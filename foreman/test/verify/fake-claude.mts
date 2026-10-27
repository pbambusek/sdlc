/**
 * Stands in for Claude Code in the launcher's tests. It records how it was started, runs a scripted list of commands the way
 * Claude Code's Bash tool does (through CLAUDE_CODE_SHELL_PREFIX, with a script ending in `eval <command>` and
 * `pwd -P >| <file>`), and writes a transcript where Claude Code keeps it. `$SCRIPTS` in a command is the verify skill's scripts folder.
 *   FAKE_CLAUDE_COMMANDS: a JSON file with the commands; FAKE_CLAUDE_RECORD: where to write the record.
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const args = process.argv.slice(2);
const opt = (name: string) => args[args.indexOf(name) + 1]!;
const sessionId = opt('--session-id');
const scripts = join(dirname(opt('--append-system-prompt-file')), 'scripts');
const prefix = process.env.CLAUDE_CODE_SHELL_PREFIX!;
const commands = (JSON.parse(readFileSync(process.env.FAKE_CLAUDE_COMMANDS!, 'utf8')) as string[]).map((c) => c.replaceAll('$SCRIPTS', scripts));
const q = (s: string) => `'${s.replaceAll("'", `'"'"'`)}'`;
const cwdFile = join(tmpdir(), `fake-claude-${process.pid}-cwd`);

const transcript: object[] = [];
const results: { command: string; status: number | null; out: string; err: string }[] = [];
let cwd = process.cwd();
for (const command of commands) {
  const id = randomUUID();
  transcript.push({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
  const script = `shopt -u extglob 2>/dev/null || true && eval ${q(command)} < /dev/null && pwd -P >| ${q(cwdFile)}`;
  const r = spawnSync('bash', ['-c', `${q(prefix)} ${q(script)}`], { cwd, encoding: 'utf8', timeout: 120_000 });
  if (existsSync(cwdFile)) cwd = readFileSync(cwdFile, 'utf8').trim();
  results.push({ command, status: r.status, out: r.stdout, err: r.stderr });
  transcript.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: r.stdout + r.stderr, is_error: r.status !== 0 }] } });
}

const configDir = process.env.CLAUDE_CONFIG_DIR!;
const folder = join(configDir, 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
mkdirSync(folder, { recursive: true });
writeFileSync(join(folder, `${sessionId}.jsonl`), transcript.map((t) => JSON.stringify(t)).join('\n') + '\n');
writeFileSync(
  process.env.FAKE_CLAUDE_RECORD!,
  JSON.stringify({
    args,
    cwd: process.cwd(),
    env: { prefix, mcp: process.env.ENABLE_CLAUDEAI_MCP_SERVERS, memory: process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY },
    results,
  }),
);
