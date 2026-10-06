/**
 * Verifies one commit against its claims in a fresh, isolated Claude Code session, and prints where the evidence page is.
 * Run it from anywhere inside the repo:
 *   node <skill>/scripts/launch.mts <spec path at the target> [ref]
 *   node <skill>/scripts/launch.mts --claims <file> [--source <label>] [ref]
 *   options: --slug <name>, --interactive (a normal session instead of headless), --prepare-only (stop before the session)
 * The page lands in <repo>/.verify/<slug>/<timestamp>-<commit>/.
 *
 * Isolation is prevented by construction where it can be, and detected where it can't:
 *   - the target is exported with `git archive` into a folder outside the repo: no history, no diff, no untracked files;
 *   - git's search for a repository stops at the runs root, and auto-memory is off;
 *   - Claude Code's file tools are denied the source repo and every config dir's `projects/` (transcripts and memory);
 *   - the export is read-only by file permissions, except `.verify/`, `.playwright-cli/` and VERIFY.md's `writable`;
 *   - the skill's preflight proves all of that at the start of the run;
 *   - a shell command could still read outside the run folder, so the transcript is audited afterwards and the page shows the verdict.
 * The method (this skill) comes from where the launcher runs; the claims, VERIFY.md and the code come from the target commit.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { auditTranscript } from './audit.mts';
import { readConfig } from './config.mts';
import { showProgress } from './progress.mts';

const USAGE = 'usage: launch.mts <spec path> [ref] | --claims <file> [--source <label>] [ref]  [--slug <name>] [--interactive] [--prepare-only]';
const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const args = process.argv.slice(2);
const flags = new Map<string, string | true>();
const positional: string[] = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  if (a === '--interactive' || a === '--prepare-only') flags.set(a, true);
  else if (a.startsWith('--')) flags.set(a, args[++i] ?? fail(USAGE));
  else positional.push(a);
}
const claimsFile = flags.get('--claims') as string | undefined;
const spec = claimsFile ? undefined : (positional.shift() ?? fail(USAGE));
const refArg = positional.shift() ?? 'HEAD';

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

const verifyMd = atTarget('VERIFY.md') ?? fail(`no VERIFY.md at the repo root at ${ref}: set the project up first (the skill's setup.md)`);
const config = readConfig(verifyMd);

let claims: string;
let source: string;
if (spec) {
  claims = atTarget(spec) ?? fail(`${spec} does not exist at ${ref}`);
  source = spec;
} else {
  if (!existsSync(claimsFile!)) fail(`${claimsFile} does not exist`);
  claims = readFileSync(claimsFile!, 'utf8');
  source = (flags.get('--source') as string | undefined) ?? 'the request';
}
if (!claims.trim()) fail('the claims source is empty');

const slug = ((flags.get('--slug') as string | undefined) ?? (spec ? basename(spec).replace(/\.md$/, '') : 'claims')).replace(/[^a-zA-Z0-9-]+/g, '-');
const run = `${new Date().toISOString().replace(/\.\d+Z$/, 'Z').replaceAll(':', '-')}-${commit.slice(0, 7)}`;
const runsRoot = resolve(process.env.VERIFY_RUNS_ROOT ?? join(homedir(), '.verify-runs'));
const work = join(runsRoot, `${basename(mainCheckout)}-${slug}-${run}`);

const skillDir = realpathSync(resolve(import.meta.dirname, '..'));
const skillVersion = (() => {
  try {
    const sha = git(skillDir, 'rev-parse', '--short', 'HEAD');
    return git(skillDir, 'status', '--porcelain', '--', '.') ? `${sha} with uncommitted changes` : sha;
  } catch {
    return `an unversioned copy at ${skillDir}`;
  }
})();

// Claude Code keeps transcripts and auto-memory under each config dir's `projects/`; skills and plugins stay readable.
const configDirs = [process.env.CLAUDE_CONFIG_DIR, ...readdirSync(homedir()).filter((n) => n.startsWith('.claude')).map((n) => join(homedir(), n))];
const denied = [...new Set([repo, mainCheckout, ...configDirs.filter((d): d is string => !!d).map((d) => join(d, 'projects'))])].filter((p) => existsSync(p));
const inside = denied.find((p) => work === p || work.startsWith(p + '/'));
if (inside) fail(`the run folder ${work} is inside ${inside}, which the verifier must not read; set VERIFY_RUNS_ROOT elsewhere`);
const probe = existsSync(join(repo, 'VERIFY.md')) ? join(repo, 'VERIFY.md') : join(repo, git(repo, 'ls-files').split('\n')[0]!);

console.log(`▶ exporting ${ref} (${commit.slice(0, 12)}) to ${work}`);
mkdirSync(work, { recursive: true });
execFileSync('bash', ['-c', `git -C "$1" archive "$2" | tar -x -C "$3"`, '_', repo, commit, work], { stdio: 'inherit' });
rmSync(join(work, '.verify'), { recursive: true, force: true });
const runDir = join(work, '.verify/run');
mkdirSync(runDir, { recursive: true });
for (const p of config.copy) {
  if (existsSync(join(repo, p))) cpSync(join(repo, p), join(work, p), { recursive: true });
  else console.warn(`  copy: ${p} is not in ${repo}; skipped`);
}

const port = await new Promise<number>((done) => {
  const s = createServer().listen(0, () => {
    const { port } = s.address() as { port: number };
    s.close(() => done(port));
  });
});
const env = Object.fromEntries(
  Object.entries(config.env).map(([k, v]) => [k, v.replaceAll('${FREE_PORT}', String(port)).replaceAll('${VERIFY_DIR}', join(work, '.verify'))]),
);
const sessionEnv = { ...process.env, ...env };

console.log('▶ installing');
const installLog = join(runDir, 'install.log');
const log = openSync(installLog, 'w');
if (spawnSync('bash', ['-c', config.install], { cwd: work, env: sessionEnv, stdio: ['ignore', log, log] }).status !== 0) {
  fail(`install failed, see ${installLog}`);
}

const writable = ['.verify', '.playwright-cli'];
const readOnly = readdirSync(work).filter((e) => !writable.includes(e));
writeFileSync(join(runDir, 'target.json'), JSON.stringify({ ref, commit, source, slug, run, skill: skillVersion }, null, 2) + '\n');
writeFileSync(join(runDir, 'claims.md'), claims);
writeFileSync(join(runDir, 'isolation.json'), JSON.stringify({ denied, runsRoot, readOnly, probe }, null, 2) + '\n');
writeFileSync(join(runDir, 'env'), Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
// The skill is linked into the export but lives outside it, so its folder is added for the file tools to follow the link.
const settings = { autoMemoryEnabled: false, permissions: { deny: denied.map((p) => `Read(/${p}/**)`), additionalDirectories: [skillDir] } };
writeFileSync(join(runDir, 'settings.json'), JSON.stringify(settings, null, 2) + '\n');

// Read-only by file permissions. A file with several links shares its inode with other checkouts (yarn's hardlinks-global),
// so it keeps its mode; its folder is read-only, so it can't be replaced or removed.
// A writable path the install did not create is a folder the running system writes into.
for (const p of config.writable) if (!existsSync(join(work, p))) mkdirSync(join(work, p), { recursive: true });
const chmod = (...a: string[]) => execFileSync('bash', ['-c', ...a], { cwd: work, stdio: 'inherit' });
chmod(`find "$@" ! -type l \\( -type d -o -links 1 \\) -exec chmod a-w {} +`, '_', ...readOnly, '.verify/run');
if (config.writable.length > 0) chmod(`chmod -R -P u+w "$@"`, '_', ...config.writable);

// The skill is linked in after the chmod, so the permissions never reach its source. A copy the target tracks is replaced.
const skillsDir = join(work, '.claude/skills');
const skillsParent = existsSync(skillsDir) ? realpathSync(skillsDir) : null;
chmod(
  `mkdir -p "$1/.claude" && chmod u+w "$1/.claude" && mkdir -p "$2" && chmod u+w "$2" && rm -rf "$2/verify" && ln -s "$3" "$2/verify" && chmod a-w "$2" "$1/.claude"`,
  '_',
  work,
  skillsParent ?? skillsDir,
  skillDir,
);

if (flags.has('--prepare-only')) {
  console.log(`prepared ${work}`);
  process.exit(0);
}

const childEnv: NodeJS.ProcessEnv = {
  ...sessionEnv,
  GIT_CEILING_DIRECTORIES: runsRoot,
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  VERIFY_MODE: flags.has('--interactive') ? 'interactive' : 'headless',
  // One shell for every verifier, whatever the owner's login shell is.
  SHELL: execFileSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).trim(),
};
// A launcher started from inside a Claude Code session must not hand the verifier that session's identity.
for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_JOB_DIR']) delete childEnv[k];
const claudeArgs = ['--settings', join(runDir, 'settings.json'), '--allowedTools', 'Bash'];
if (flags.has('--interactive')) {
  console.log('▶ starting an interactive verification session (approve the folder trust prompt)');
  spawnSync('claude', ['/verify', ...claudeArgs], { cwd: work, env: childEnv, stdio: 'inherit' });
} else {
  console.log('▶ verifying headless; requests for you appear as ACTION NEEDED');
  const session = spawn('claude', ['-p', '/verify', ...claudeArgs, '--permission-mode', 'acceptEdits', '--output-format', 'stream-json', '--verbose'], {
    cwd: work,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await showProgress(session.stdout);
  await new Promise((done) => session.once('close', done));
}

if (config.stop) {
  console.log('▶ stopping what the session left running');
  spawnSync('bash', ['-c', config.stop], { cwd: work, env: sessionEnv, stdio: 'ignore' });
}

console.log('▶ auditing the session transcript');
const encoded = work.replace(/[^a-zA-Z0-9]/g, '-');
const startedAt = statSync(join(runDir, 'target.json')).mtimeMs;
const transcript = configDirs
  .filter((d): d is string => !!d && existsSync(join(d, 'projects', encoded)))
  .flatMap((d) => readdirSync(join(d, 'projects', encoded)).filter((f) => f.endsWith('.jsonl')).map((f) => join(d, 'projects', encoded, f)))
  .filter((f) => statSync(f).mtimeMs > startedAt)
  .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
const audit = transcript
  ? auditTranscript({ transcript, denied, runsRoot, work })
  : { verdict: 'Isolation audit: not run, the session transcript was not found.', clean: false, findings: [] };
writeFileSync(join(work, '.verify/audit.json'), JSON.stringify(audit, null, 2) + '\n');
console.log(audit.verdict);

const out = join(repo, '.verify', slug, run);
const page = join(work, '.verify/evidence.html');
if (!existsSync(page)) {
  console.error(`✖ the session produced no page; its folder is kept at ${work}`);
  console.error(`  to inspect or continue it: cd ${work} && claude --resume  (pick the latest session)`);
  process.exit(1);
}
// Rebuilt so the page carries the audit verdict.
spawnSync('node', [join(skillDir, 'scripts/build-page.mts'), '.verify'], { cwd: work, stdio: 'ignore' });
mkdirSync(out, { recursive: true });
for (const f of ['evidence.html', 'evidence.json', 'preflight.json', 'audit.json', 'shots']) {
  if (existsSync(join(work, '.verify', f))) cpSync(join(work, '.verify', f), join(out, f), { recursive: true });
}

const evidence = JSON.parse(readFileSync(join(out, 'evidence.json'), 'utf8')) as {
  claims: { id: string; blocked?: string; items: { status: string; reason?: string }[] }[];
};
const statusOf = (c: (typeof evidence.claims)[number]) =>
  c.items.some((i) => i.status === 'not-shown') ? 'not-shown' : c.items.length > 0 && c.items.every((i) => i.status === 'shown') ? 'shown' : 'blocked';
const counts = { shown: 0, 'not-shown': 0, blocked: 0 } as Record<string, number>;
for (const c of evidence.claims) counts[statusOf(c)]!++;
console.log(`✔ ${join(out, 'evidence.html')}`);
console.log(`  ${counts.shown} shown, ${counts['not-shown']} not shown, ${counts.blocked} blocked`);
for (const c of evidence.claims.filter((c) => statusOf(c) !== 'shown')) {
  console.log(`  ${c.id} ${statusOf(c)}: ${c.blocked ?? c.items.find((i) => i.reason)?.reason ?? ''}`);
}
if (process.stdout.isTTY && process.platform === 'darwin') spawnSync('open', [join(out, 'evidence.html')]);

// `-P` keeps chmod off the skill link's target; rm removes the link, not what it points to.
if (!process.env.VERIFY_KEEP) {
  chmod(`chmod -R -P u+w "$1"`, '_', work);
  rmSync(work, { recursive: true, force: true });
}
if (!audit.clean) fail('✖ the isolation audit failed; treat this page as invalid');
