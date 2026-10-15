/**
 * The verifier's shell: Claude Code runs each Bash tool command through it (`CLAUDE_CODE_SHELL_PREFIX`), outside the workspace.
 *   node workspace-shell.mts --socket <path> --log <file> --workspace <name> --work <run folder> <shell script>
 * Claude Code hands it one script: its own shell setup, then `eval <the command>`, then `pwd -P >| <file>` to track the folder
 * the command ended in. The setup is for a shell on this machine, so only the command is sent into the workspace; the folder
 * comes back and is written here. Every command is logged with the workspace it ran in, its exit status, and each access the
 * workspace refused it, read from its output: the sandbox reports refusals only for the process it started, not its commands.
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { createInterface } from 'node:readline';

/** The script split at each top-level `&&`, each part verbatim. Quotes and escapes are respected; null when unbalanced. */
export const splitAnd = (script: string): string[] | null => {
  const parts: string[] = [];
  let start = 0;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < script.length; i++) {
    const c = script[i];
    if (quote === "'") {
      if (c === "'") quote = null;
    } else if (c === '\\') i++;
    else if (quote === '"') {
      if (c === '"') quote = null;
    } else if (c === "'" || c === '"') quote = c;
    else if (c === '&' && script[i + 1] === '&') {
      parts.push(script.slice(start, i).trim());
      start = i + 2;
      i++;
    }
  }
  if (quote) return null;
  parts.push(script.slice(start).trim());
  return parts;
};

/** The shell words of `text`, unquoted. Enough for the quoting Claude Code produces; an operator ends the words. */
export const words = (text: string): string[] => {
  const out: string[] = [];
  let word: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "'") {
      const end = text.indexOf("'", i + 1);
      word = (word ?? '') + text.slice(i + 1, end < 0 ? text.length : end);
      i = end < 0 ? text.length : end;
    } else if (c === '"') {
      let j = i + 1;
      let s = '';
      for (; j < text.length && text[j] !== '"'; j++) s += text[j] === '\\' && /["\\$`]/.test(text[j + 1] ?? '') ? text[++j] : text[j];
      word = (word ?? '') + s;
      i = j;
    } else if (c === '\\') word = (word ?? '') + (text[++i] ?? '');
    else if (/\s/.test(c)) {
      if (word !== null) out.push(word);
      word = null;
    } else if (/[<>|;&]/.test(c) && word === null) break;
    else word = (word ?? '') + c;
  }
  if (word !== null) out.push(word);
  return out;
};

/** The command and the folder-tracking file in Claude Code's script, or null when it has another shape. */
export const parseScript = (script: string): { evalArgs: string; command: string; cwdFile: string } | null => {
  const parts = splitAnd(script);
  if (!parts || parts.length < 2) return null;
  const pwd = parts.at(-1)!.match(/^pwd -P >\| (.+)$/s);
  const evaluated = parts.at(-2)!.match(/^eval (.+)$/s);
  if (!pwd || !evaluated) return null;
  const cwdFile = words(pwd[1]!)[0];
  if (!cwdFile) return null;
  return { evalArgs: evaluated[1]!, command: words(evaluated[1]!).join(' '), cwdFile };
};

const REFUSED = /Operation not permitted|Permission denied|\bEPERM\b|\bEACCES\b/;

/** Each path outside the run folder that a line of output says was refused, with the line. */
export const refusals = (output: string, work: string): { path: string; line: string }[] => {
  const found = new Map<string, string>();
  for (const line of output.split('\n')) {
    if (!REFUSED.test(line)) continue;
    for (const [, path] of line.matchAll(/((?:\/[^\s:'"`,()]+)+)/g)) {
      if (!path || path === work || path.startsWith(work + '/') || path.split('/').length < 3) continue;
      if (!found.has(path)) found.set(path, line.trim().slice(0, 300));
    }
  }
  return [...found].map(([path, line]) => ({ path, line }));
};

export interface LoggedCommand {
  time: string;
  workspace: string;
  cwd: string;
  command: string;
  exit: number | null;
  ms: number;
  refused: { path: string; line: string }[];
}

const main = async () => {
  const args = process.argv.slice(2);
  const opt = (name: string) => {
    const i = args.indexOf(name);
    const v = i >= 0 ? args.splice(i, 2)[1] : undefined;
    if (!v) throw new Error(`workspace-shell: ${name} is required`);
    return v;
  };
  const socket = opt('--socket');
  const log = opt('--log');
  const workspace = opt('--workspace');
  const work = opt('--work');
  const script = args.join(' ');
  const started = Date.now();
  const cwd = process.cwd();
  const record = (entry: Omit<LoggedCommand, 'time' | 'workspace' | 'cwd' | 'ms'>) =>
    appendFileSync(
      log,
      JSON.stringify({ time: new Date(started).toISOString(), workspace, cwd, ...entry, ms: Date.now() - started } satisfies LoggedCommand) + '\n',
    );

  const parsed = parseScript(script);
  if (!parsed) {
    record({ command: script.slice(0, 2000), exit: 126, refused: [] });
    process.stderr.write('workspace: this shell runs only Claude Code Bash tool commands, and this script has another shape\n');
    process.exit(126);
  }

  let output = '';
  const keep = (b: Buffer) => {
    if (output.length < 32 << 20) output += b.toString();
  };
  const exit = await new Promise<number | null>((done) => {
    const conn = connect(socket);
    let status: number | null = null;
    conn.once('connect', () => conn.write(JSON.stringify({ script: `eval ${parsed.evalArgs} && pwd -P >&3`, cwd }) + '\n'));
    conn.once('error', (e) => {
      process.stderr.write(`workspace: unreachable (${e.message})\n`);
      done(126);
    });
    createInterface({ input: conn }).on('line', (line) => {
      const m = JSON.parse(line) as { out?: string; err?: string; cwd?: string; exit?: number };
      if (m.out) {
        const b = Buffer.from(m.out, 'base64');
        keep(b);
        process.stdout.write(b);
      }
      if (m.err) {
        const b = Buffer.from(m.err, 'base64');
        keep(b);
        process.stderr.write(b);
      }
      if (m.cwd) writeFileSync(parsed.cwdFile, m.cwd + '\n');
      if (m.exit !== undefined) status = m.exit;
    });
    conn.once('close', () => done(status));
    // Claude Code stops a command that runs too long by signalling its shell; closing the connection stops it in the workspace.
    for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.once(s, () => conn.destroy());
  });
  record({ command: parsed.command, exit, refused: refusals(output, work) });
  process.exit(exit ?? 143);
};

if (import.meta.main) await main();
