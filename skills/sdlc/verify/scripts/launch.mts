/**
 * Verifies one commit against its claims in a fresh Claude Code session that knows nothing of how the code was written,
 * and prints where the evidence page is. Run it from anywhere inside the repo:
 *   node <skill dir>/scripts/launch.mts <spec path at the target> [ref]
 *   node <skill dir>/scripts/launch.mts --claims <file> [--source <label>] [ref]
 *   node <skill dir>/scripts/launch.mts --export-only [ref]   (setup: export and copy, print the folder, start no session)
 *   options: --copy <path> (repeatable), --slug <name>, --interactive
 * The page lands in <repo>/.verify/<slug>/<timestamp>-<commit>/ and opens; VERIFY_NO_OPEN=1 keeps it closed.
 *
 * What keeps the verifier honest:
 *   - the target is exported with `git archive` into a new temp folder: no history, no diff, no untracked files;
 *   - the session is a new process: none of the caller's session, git's search stops above the folder, auto-memory is off;
 *   - Claude Code's file tools only read the run folder, and are denied the source repo and the session transcripts;
 *   - afterwards the session's transcript is audited, and the page shows the verdict and any exported file it changed.
 * The method (run.md) comes from where the launcher runs; the claims, VERIFY.md and the code come from the target commit.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { audit, snapshot } from './audit.mts';

const USAGE = 'usage: launch.mts <spec path> [ref] | --claims <file> [--source <label>] [ref] | --export-only [ref]  [--copy <path>]… [--slug <name>] [--interactive]';
const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const args = process.argv.slice(2);
const flags = new Map<string, string | true>();
const copies: string[] = [];
const positional: string[] = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  if (a === '--interactive' || a === '--export-only') flags.set(a, true);
  else if (a === '--copy') copies.push(args[++i] ?? fail(USAGE));
  else if (a.startsWith('--')) flags.set(a, args[++i] ?? fail(USAGE));
  else positional.push(a);
}
const exportOnly = flags.has('--export-only');
const claimsFile = flags.get('--claims') as string | undefined;
const spec = claimsFile || exportOnly ? undefined : (positional.shift() ?? fail(USAGE));
const refArg = positional.shift() ?? 'HEAD';
const interactive = flags.has('--interactive');

const git = (repo: string, ...a: string[]) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', maxBuffer: 1 << 30 }).trim();
const repo = git(process.cwd(), 'rev-parse', '--show-toplevel');
// A worktree's main checkout holds the same history and every other worktree, so both are denied, and runs are named after it.
const mainCheckout = dirname(realpathSync(resolve(repo, git(repo, 'rev-parse', '--git-common-dir'))));
const commit = git(repo, 'rev-parse', '--verify', `${refArg}^{commit}`);
const ref = refArg === 'HEAD' ? git(repo, 'rev-parse', '--abbrev-ref', 'HEAD') : refArg;
const atTarget = (path: string) => {
  try {
    return execFileSync('git', ['-C', repo, 'show', `${commit}:${path}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
};

if (!exportOnly && atTarget('VERIFY.md') === null) fail(`no VERIFY.md at the repo root at ${ref}: set the project up first (the skill's setup.md)`);

let claims = '';
let source = 'none';
if (exportOnly) {
  // Setup tries the project's commands in an export; there is nothing to verify yet.
} else if (spec) {
  claims = atTarget(spec) ?? fail(`${spec} does not exist at ${ref}`);
  source = spec;
} else {
  if (!existsSync(claimsFile!)) fail(`${claimsFile} does not exist`);
  claims = readFileSync(claimsFile!, 'utf8');
  source = (flags.get('--source') as string | undefined) ?? 'the request';
}
if (!exportOnly && !claims.trim()) fail('the claims source is empty');

const slug = ((flags.get('--slug') as string | undefined) ?? (spec ? basename(spec).replace(/\.md$/, '') : exportOnly ? 'export' : 'claims')).replace(/[^a-zA-Z0-9-]+/g, '-');
const ranAt = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const run = `${ranAt.replaceAll(':', '-')}-${commit.slice(0, 7)}`;
const work = realpathSync(mkdtempSync(join(tmpdir(), `verify-${basename(mainCheckout)}-${slug}-`)));
const skillDir = realpathSync(resolve(import.meta.dirname, '..'));
// Claude Code keeps session transcripts and auto-memory under its config dir's `projects/`.
const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
const denied = [...new Set([repo, mainCheckout, join(configDir, 'projects')])];

console.log(`▶ exporting ${ref} (${commit.slice(0, 12)}) to ${work}`);
execFileSync('bash', ['-c', `git -C "$1" archive "$2" | tar -x -C "$3"`, '_', repo, commit, work], { stdio: 'inherit' });
for (const p of copies) {
  if (existsSync(join(repo, p))) cpSync(join(repo, p), join(work, p), { recursive: true });
  else console.warn(`  copy: ${p} is not in ${repo}; skipped`);
}
const before = snapshot(work);

const verifyDir = join(work, '.verify');
mkdirSync(verifyDir, { recursive: true });
writeFileSync(join(verifyDir, 'target.json'), JSON.stringify({ ref, commit, source, ranAt }, null, 2) + '\n');
// The skill's own folder stays readable for the example evidence and the page builder.
const settings = { autoMemoryEnabled: false, permissions: { deny: denied.map((p) => `Read(/${p}/**)`), additionalDirectories: [skillDir] } };
writeFileSync(join(verifyDir, 'settings.json'), JSON.stringify(settings, null, 2) + '\n');

if (exportOnly) {
  console.log(`exported ${work}`);
  process.exit(0);
}

const prompt = [
  `Verify commit ${commit} (${ref}) against the claims below. They come from ${source}, unchanged.`,
  `The skill's folder is ${skillDir}.`,
  '',
  '<claims>',
  claims.trim(),
  '</claims>',
].join('\n');
const childEnv: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CEILING_DIRECTORIES: dirname(work),
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  VERIFY_MODE: interactive ? 'interactive' : 'headless',
  // One shell for every verifier, whatever the owner's login shell is.
  SHELL: execFileSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).trim(),
};
// A launcher started from inside a Claude Code session must not hand the verifier that session's identity.
for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_JOB_DIR']) delete childEnv[k];
const sessionId = randomUUID();
const claudeArgs = ['--session-id', sessionId, '--settings', join(verifyDir, 'settings.json'), '--append-system-prompt-file', join(skillDir, 'run.md'), '--allowedTools', 'Bash'];

if (interactive) {
  console.log('▶ starting an interactive verification session (approve the folder trust prompt)');
  spawnSync('claude', [...claudeArgs, prompt], { cwd: work, env: childEnv, stdio: 'inherit' });
} else {
  console.log(`▶ verifying headless, session ${sessionId}`);
  const session = spawn('claude', ['-p', prompt, ...claudeArgs, '--permission-mode', 'acceptEdits', '--output-format', 'stream-json', '--verbose'], {
    cwd: work,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  // One line per step, so the terminal shows the session at work.
  const short = (s: string, n = 110) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  for await (const line of createInterface({ input: session.stdout })) {
    let event: { type?: string; message?: { content?: { type: string; text?: string; name?: string; input?: Record<string, string> }[] } };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type !== 'assistant') continue;
    for (const b of event.message?.content ?? []) {
      if (b.type === 'text' && b.text?.trim()) console.log(`› ${b.text.trim()}`);
      if (b.type === 'tool_use') console.log(`  · ${b.name}: ${short(b.input?.description ?? b.input?.command ?? b.input?.file_path ?? '')}`);
    }
  }
  await new Promise((done) => session.once('close', done));
}

console.log('▶ auditing the session');
const transcript = join(configDir, 'projects', work.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);
const result = audit({ transcript: existsSync(transcript) ? transcript : null, work, repos: [repo, mainCheckout], allowed: [skillDir], before });
writeFileSync(join(verifyDir, 'audit.json'), JSON.stringify(result, null, 2) + '\n');
console.log(result.verdict);

if (!existsSync(join(verifyDir, 'evidence.json'))) {
  console.error(`✖ the session wrote no evidence; its folder is kept at ${work}`);
  console.error(`  to inspect or continue it: cd ${work} && claude --resume ${sessionId}`);
  process.exit(1);
}
// Rebuilt so the page carries the audit; the builder prints the summary.
const out = join(repo, '.verify', slug, run);
mkdirSync(out, { recursive: true });
const built = spawnSync('node', [join(skillDir, 'scripts/build-page.mts'), '.verify'], { cwd: work, stdio: 'inherit' });
for (const f of ['evidence.html', 'audit.json', 'shots']) {
  if (existsSync(join(verifyDir, f))) cpSync(join(verifyDir, f), join(out, f), { recursive: true });
}
// The copy names the commit it verified, so the file alone tells a reader whether it is still about their code; malformed evidence is copied as is.
try {
  const evidence = JSON.parse(readFileSync(join(verifyDir, 'evidence.json'), 'utf8'));
  writeFileSync(join(out, 'evidence.json'), JSON.stringify({ target: { ref, commit }, ...evidence }, null, 2) + '\n');
} catch {
  cpSync(join(verifyDir, 'evidence.json'), join(out, 'evidence.json'));
}
if (built.status !== 0) fail(`✖ the page did not build; the evidence is in ${out}, the run folder is ${work}`);
console.log(`✔ ${join(out, 'evidence.html')}`);

const opener = process.platform === 'darwin' ? 'open' : process.platform === 'linux' ? 'xdg-open' : null;
if (opener && !process.env.VERIFY_NO_OPEN) spawnSync(opener, [join(out, 'evidence.html')], { stdio: 'ignore' });
if (!result.clean) fail('✖ the audit failed; treat this page as invalid');
