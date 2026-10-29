/**
 * Verifies one commit against its claims in a fresh Claude Code session that knows nothing of how the code was written,
 * and prints where the evidence page is. Run it from anywhere inside the repo:
 *   foreman verify <spec path at the target> [ref]
 *   foreman verify --claims <file> [--source <label>] [ref]
 *   foreman verify --export-only [ref]   (setup: export and copy into a workspace VM, print how to open a shell in it, start no session)
 * `foreman verify` runs this file; the tick runs it the same way for each round.
 *   options: --copy <path> (repeatable), --slug <name>, --model <id>, --interactive
 * The page lands in <repo>/.verify/<slug>/<timestamp>-<commit>/ and opens; VERIFY_NO_OPEN=1 keeps it closed.
 *
 * What keeps the verifier honest:
 *   - the target is exported with `git archive` into a new run folder: no history, no diff, no untracked files;
 *   - every command the verifier runs executes in the run's workspace (workspace.mts), a fresh Linux VM that holds the export on
 *     its own disk and shares with the host only the run's .verify folder, the plugin's folder and the caches VERIFY.md declares,
 *     read-only: the source repo, every session's transcripts and the owner's keys and logins are not there for it. Each
 *     command is logged with its exit status. Without a workspace, no run starts;
 *   - the verifier itself stays outside the workspace, with its own login and transcript, and loads nothing of the owner's
 *     Claude Code setup (memory, instructions, plugins, skills, connectors). Its only tools are running a command in the
 *     workspace and viewing an image the workspace saved; anything else is refused without asking;
 *   - afterwards the session's transcript is audited, and the page shows the verdict and any exported file it changed.
 * The method (run.md) comes from the verify skill in the plugin of the checkout the launcher runs from; the claims and the code come from the target commit; the VERIFY.md
 * files come from the remote's default branch (instructions.mts), so the commit under test can't rewrite its own instructions.
 *
 * When VERIFY.md declares credentials, the run holds only placeholders for them (credentials.mts): the launcher reads the real
 * values from the declared Key Vault, and nono's proxy puts them on requests to each credential's hosts, logging every such request.
 * A declared credential that can't be read stops the launch.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from './args.mts';
import { audit } from './audit.mts';
import { findValues, parseDeclaration, readCredentials, startProxy } from './credentials.mts';
import { applyInstructions, readInstructions, type Instructions } from './instructions.mts';
import { cacheFolder, ensureTemplate, openWorkspace, parseRecipe, RUNS, workspaceMissing, type Recipe } from './workspace.mts';
import type { LoggedCommand } from './workspace-shell.mts';

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const options = (() => {
  try {
    return parseArgs(process.argv.slice(2));
  } catch (e) {
    return fail((e as Error).message);
  }
})();
const { exportOnly, claimsFile, spec, copies, slug, model, interactive, ref: refArg } = options;

const git = (repo: string, ...a: string[]) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', maxBuffer: 1 << 30 }).trim();
const repo = git(process.cwd(), 'rev-parse', '--show-toplevel');
// A worktree's main checkout holds the same history and every other worktree, so the audit treats both as the source repo.
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
const noRun = (why: string) => fail(`✖ ${why}. No verifier started.`);

// The workspace comes first: without it nothing else is worth reading.
if (!exportOnly) {
  const missing = workspaceMissing();
  if (missing) noRun(`the run's workspace can't be set up on this machine: ${missing}`);
}

// Setup writes VERIFY.md, so it reads the commit's own; a run follows the default branch's.
let instructions: Instructions | null = null;
if (!exportOnly) {
  try {
    instructions = readInstructions({ repo, target: commit });
  } catch (e) {
    noRun((e as Error).message);
  }
  const { remote, branch, changed } = instructions!;
  console.log(`▶ instructions: the VERIFY.md files on ${remote}/${branch} (${instructions!.commit.slice(0, 12)})`);
  if (changed.length) {
    console.log(`▶ ${ref} changes ${changed.length === 1 ? 'this VERIFY.md file' : 'these VERIFY.md files'}: ${changed.join(', ')}.`);
    console.log(
      `  The run follows ${remote}/${branch}'s version${changed.length === 1 ? '' : 's'}. A change to VERIFY.md goes to ${branch} in its own pull request first, never with the change under test.`,
    );
  }
}
const verifyMd = exportOnly ? atTarget('VERIFY.md') : instructions!.files.get('VERIFY.md')!;
let declaration: ReturnType<typeof parseDeclaration> = null;
try {
  declaration = exportOnly || verifyMd === null ? null : parseDeclaration(verifyMd);
} catch (e) {
  noRun((e as Error).message);
}
// What the workspace VM installs and which host caches it reads come from the same VERIFY.md.
let recipe: Recipe;
try {
  recipe = parseRecipe(verifyMd);
} catch (e) {
  noRun((e as Error).message);
}

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
  source = options.source ?? 'the request';
}
if (!exportOnly && !claims.trim()) fail('the claims source is empty');

// Each credential is read before anything starts, with the Azure CLI's cached login: nothing here can wait on a person. A
// declared credential is meant to be there, so one that can't be read stops the launch for a person to fix.
const reads = declaration ? await readCredentials(declaration) : [];
const unreadable = reads.filter((r) => r.outcome === 'unavailable');
if (unreadable.length) {
  for (const r of unreadable) console.error(`✖ credential ${r.name} can't be read: ${r.outcome === 'unavailable' ? r.reason : ''}`);
  noRun(`VERIFY.md declares ${unreadable.length === 1 ? 'a credential' : 'credentials'} that can't be read`);
}
for (const r of reads)
  if (r.outcome === 'read')
    console.log(
      `▶ credential ${r.name}: read from ${declaration!.vault}/${r.secret} without a prompt; the workspace holds a placeholder, swapped on ${r.hosts.join(', ')}`,
    );

const ranAt = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const run = `${ranAt.replaceAll(':', '-')}-${commit.slice(0, 7)}`;
mkdirSync(RUNS, { recursive: true, mode: 0o700 });
// The run folder is the workspace's; the state folder beside it is the launcher's (the profile, the verifier's shell, the
// command and credential logs), out of the workspace's reach.
const work = realpathSync(mkdtempSync(join(RUNS, 'r-')));
const stateDir = realpathSync(mkdtempSync(join(RUNS, 'l-')));
// The runner is foreman's; the skill's method, assets and scripts are the plugin's in the same checkout. The workspace reads both.
const runnerDir = realpathSync(import.meta.dirname);
const pluginDir = realpathSync(resolve(runnerDir, '../../../plugins/sdlc'));
const skillDir = join(pluginDir, 'skills/verify');
const scriptsDir = join(skillDir, 'scripts');
// The owner's Claude Code keeps session transcripts and auto-memory under its config dir's `projects/`.
const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
// A declared cache is a tool's packages: one that reaches how the code was written stops the launch.
const forbidden = [repo, mainCheckout, configDir].filter((p) => existsSync(p)).map((p) => realpathSync(p));
const caches = recipe!.caches.flatMap((c) => {
  const folder = cacheFolder(c.host, forbidden);
  if (folder.outcome === 'shared') return [{ ...c, path: folder.path }];
  if (folder.outcome === 'missing') return (console.warn(`  cache: ${folder.reason}; the run goes without it`), []);
  return noRun(`VERIFY.md Workspace: the cache ${folder.reason}`);
});

console.log(`▶ exporting ${ref} (${commit.slice(0, 12)}) to ${work}`);
execFileSync('bash', ['-c', `git -C "$1" archive "$2" | tar -x -C "$3"`, '_', repo, commit, work], { stdio: 'inherit' });
for (const p of copies) {
  if (existsSync(join(repo, p))) cpSync(join(repo, p), join(work, p), { recursive: true });
  else console.warn(`  copy: ${p} is not in ${repo}; skipped`);
}
if (instructions) applyInstructions(work, instructions);

const verifyDir = join(work, '.verify');
mkdirSync(verifyDir, { recursive: true });
writeFileSync(join(verifyDir, 'target.json'), JSON.stringify({ ref, commit, source, ranAt }, null, 2) + '\n');

// Commands get this environment and nothing else of the launcher's: no login, key or token the owner's shell holds. The VM
// keeps its own PATH, home and locale.
const KEEP = ['TERM', 'TZ'];
const baseEnv: Record<string, string> = {
  ...Object.fromEntries(KEEP.flatMap((k) => (process.env[k] ? [[k, process.env[k]!]] : []))),
  // One shell for every verifier, whatever the owner's login shell is.
  SHELL: execFileSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).trim(),
  GIT_CEILING_DIRECTORIES: dirname(work),
  VERIFY_MODE: interactive ? 'interactive' : 'headless',
};

if (exportOnly) {
  console.log(`exported ${work}`);
  // Setup tries the project's commands in the same workspace a run gets, and leaves the VM for the person to delete.
  if (!workspaceMissing()) {
    try {
      const template = ensureTemplate({ recipe: recipe!, log: (line) => console.log(line) });
      const ws = await openWorkspace({ template, work, stateDir, pluginDir, runnerDir, caches, env: baseEnv, serve: false });
      console.log(`a shell in its workspace: limactl shell --workdir ${work} ${ws.name}`);
      console.log(`when done: limactl delete -f ${ws.name}`);
    } catch (e) {
      fail(`✖ the workspace can't be set up: ${(e as Error).message}`);
    }
  }
  process.exit(0);
}

// A run takes minutes, and a machine that sleeps meanwhile pauses its VM and stalls its commands.
if (process.platform === 'darwin') spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore', detached: true }).unref();
let template = '';
try {
  template = ensureTemplate({ recipe: recipe!, log: (line) => console.log(line) });
} catch (e) {
  noRun(`the workspace template can't be baked: ${(e as Error).message}`);
}

const credentialLog = join(stateDir, 'credential-requests.jsonl');
const proxy = reads.length
  ? await startProxy({
      reads,
      profileFile: join(stateDir, 'nono-proxy-profile.json'),
      nonoLog: join(stateDir, 'nono-proxy.log'),
      log: credentialLog,
      baseEnv,
      trustFile: join(verifyDir, 'proxy-ca.pem'),
    })
  : null;
if (proxy) console.log('▶ credential proxy (nono) started; the workspace holds its token, never a value');

let workspace;
try {
  workspace = await openWorkspace({
    template,
    work,
    stateDir,
    pluginDir,
    runnerDir,
    caches,
    env: (proxy?.env as Record<string, string> | undefined) ?? baseEnv,
    trust: proxy ? join(verifyDir, 'proxy-ca.pem') : undefined,
  });
} catch (e) {
  await proxy?.stop();
  noRun(`the run's workspace can't be set up on this machine: ${(e as Error).message}`);
}
const ws = workspace!;
console.log(`▶ ${ws.banner}`);

// The verifier's own model credential, when the owner's environment holds one, must not reach the workspace either.
const modelCredentials = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'].flatMap((k) =>
  process.env[k] ? [{ name: `the verifier's ${k}`, value: process.env[k]! }] : [],
);
const scanned = [...(proxy?.values ?? []), ...modelCredentials];

const credentialLines = reads.map(
  (r) =>
    `- \`${r.name}\`: set in the workspace's environment as a placeholder. The run's proxy swaps it for the real value on requests to ${r.hosts.join(', ')} only; anywhere else it arrives as the placeholder.`,
);
const prompt = [
  `Verify commit ${commit} (${ref}) against the claims below. They come from ${source}, unchanged.`,
  `The skill's folder is ${skillDir}.`,
  `${ws.summary} It has Docker of its own. Each command you run is logged with its exit status.`,
  "Your tools: `Bash` runs a command in the workspace, and `Read` views an image the workspace saved. `playwright-cli` opens Playwright's own Chromium, set as the default: the workspace has no Google Chrome.",
  `You run ${interactive ? 'interactive' : 'headless'}.`,
  `The VERIFY.md files in this folder are those on ${instructions!.remote}/${instructions!.branch}, the project's default branch.`,
  '',
  ...(declaration
    ? ['Credentials declared in VERIFY.md:', ...credentialLines, `Every request that used one is logged in \`.verify/credential-requests.jsonl\`.`, '']
    : []),
  '<claims>',
  claims.trim(),
  '</claims>',
].join('\n');

const childEnv: NodeJS.ProcessEnv = {
  ...process.env,
  CLAUDE_CODE_SHELL_PREFIX: ws.shell,
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
  VERIFY_MODE: baseEnv.VERIFY_MODE,
  SHELL: baseEnv.SHELL,
};
// A launcher started from inside a Claude Code session must not hand the verifier that session's identity.
for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_JOB_DIR']) delete childEnv[k];
const sessionId = randomUUID();
// Nothing of the owner's setup loads (safe mode), no settings file is read, and no connector starts. The only tools are a
// command in the workspace and viewing an image there; everything else is refused without asking anyone (dontAsk).
const images = ['png', 'jpg', 'jpeg', 'gif', 'webp'].map((ext) => `Read(/${work}/**/*.${ext})`);
const claudeArgs = [
  '--session-id',
  sessionId,
  '--safe-mode',
  '--restricted',
  '--strict-mcp-config',
  '--tools',
  'Bash,Read',
  '--allowedTools',
  'Bash',
  ...images,
  '--permission-mode',
  'dontAsk',
  '--append-system-prompt-file',
  join(skillDir, 'run.md'),
  ...(model ? ['--model', model] : []),
];

// The proxy runs in this process, so the session is never spawned synchronously: a blocked event loop would stall every request.
const sample = () => {
  if (!proxy) return;
  proxy.collect();
  // The verifier cites the log; the copy in the state folder is the one the page keeps.
  if (existsSync(credentialLog)) copyFileSync(credentialLog, join(verifyDir, 'credential-requests.jsonl'));
};
if (interactive) {
  console.log('▶ starting an interactive verification session (approve the folder trust prompt)');
  const session = spawn('claude', [...claudeArgs, prompt], { cwd: work, env: childEnv, stdio: 'inherit' });
  const timer = setInterval(sample, 15_000);
  await new Promise((done) => session.once('close', done));
  clearInterval(timer);
} else {
  console.log(`▶ verifying headless, session ${sessionId}`);
  const session = spawn('claude', ['-p', prompt, ...claudeArgs, '--output-format', 'stream-json', '--verbose'], {
    cwd: work,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const timer = setInterval(sample, 15_000);
  session.once('close', () => clearInterval(timer));
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
sample();

// The files are compared before the VM goes; deleting it stops whatever the run left running, containers included.
const changed = ws.changed();
const closed = await ws.close();
if (closed.stopped.length) console.log(`▶ deleted the workspace (${closed.stopped.join(', ')}) with everything the run started`);
// Once the workspace is gone, its proxy token and placeholders reach nothing.
await proxy?.stop();
if (proxy) console.log('▶ credential proxy (nono) stopped');

console.log('▶ auditing the session');
const transcript = join(configDir, 'projects', work.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);
const result = audit({ transcript: existsSync(transcript) ? transcript : null, changed });

const commands: LoggedCommand[] = readFileSync(ws.commandLog, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l));
result.workspace = [ws.summary, `Commands: ${commands.length} ran in the workspace, each logged with its exit status.`];

// A real value reaches the workspace only in a response from a declared host; the transcript is where it would be kept.
const leaks = scanned.length
  ? findValues({ values: scanned, texts: existsSync(transcript) ? { 'the session transcript': readFileSync(transcript, 'utf8') } : {} })
  : [];
const requests = existsSync(credentialLog) ? readFileSync(credentialLog, 'utf8').split('\n').filter(Boolean).length : 0;
result.credentials = [
  ...(declaration
    ? [
        `Credentials: ${reads.map((r) => r.name).join(', ')} held as ${reads.length === 1 ? 'a placeholder' : 'placeholders'}, swapped by the proxy on ${reads.length === 1 ? 'its' : 'their'} declared hosts. ${requests} credentialed request${requests === 1 ? '' : 's'} logged.`,
      ]
    : []),
  ...(scanned.length
    ? [
        leaks.length
          ? `Credential check: VIOLATED, a real value appeared: ${leaks.join('; ')}. Rotate it.`
          : 'Credential check: clean, no real value in the session transcript.',
      ]
    : []),
];
if (leaks.length) result.clean = false;
writeFileSync(join(verifyDir, 'audit.json'), JSON.stringify(result, null, 2) + '\n');
console.log(result.verdict);
for (const line of [...result.workspace, ...result.credentials]) console.log(line);

const keep = () => {
  console.error(`  the run folder is kept at ${work}; the command log is ${ws.commandLog}`);
  console.error(`  the session transcript is ${transcript}`);
};
if (closed.stillRunning.length) {
  console.error(`✖ the workspace could not be deleted: ${closed.stillRunning.join('; ')}`);
  keep();
  process.exit(1);
}
if (!existsSync(join(verifyDir, 'evidence.json'))) {
  console.error('✖ the session wrote no evidence');
  keep();
  process.exit(1);
}
// Rebuilt so the page carries the audit; the builder prints the summary.
const out = join(repo, '.verify', slug, run);
mkdirSync(out, { recursive: true });
if (existsSync(credentialLog)) copyFileSync(credentialLog, join(verifyDir, 'credential-requests.jsonl'));
const built = spawnSync('node', [join(scriptsDir, 'build-page.mts'), '.verify'], { cwd: work, stdio: 'inherit' });
for (const f of ['evidence.html', 'audit.json', 'shots', 'credential-requests.jsonl']) {
  if (existsSync(join(verifyDir, f))) cpSync(join(verifyDir, f), join(out, f), { recursive: true });
}
copyFileSync(ws.commandLog, join(out, 'commands.jsonl'));
// The copy names the commit it verified, so the file alone tells a reader whether it is still about their code; malformed evidence is copied as is.
try {
  const evidence = JSON.parse(readFileSync(join(verifyDir, 'evidence.json'), 'utf8'));
  writeFileSync(join(out, 'evidence.json'), JSON.stringify({ target: { ref, commit }, ...evidence }, null, 2) + '\n');
} catch {
  cpSync(join(verifyDir, 'evidence.json'), join(out, 'evidence.json'));
}
if (built.status !== 0) {
  console.error(`✖ the page did not build; the evidence is in ${out}`);
  keep();
  process.exit(1);
}
console.log(`✔ ${join(out, 'evidence.html')}`);
// Everything a reader needs is in the page's folder.
rmSync(work, { recursive: true, force: true });
rmSync(stateDir, { recursive: true, force: true });

const opener = process.platform === 'darwin' ? 'open' : process.platform === 'linux' ? 'xdg-open' : null;
if (opener && !process.env.VERIFY_NO_OPEN) spawnSync(opener, [join(out, 'evidence.html')], { stdio: 'ignore' });
if (!result.clean) console.log('! the audit has warnings; the page lists them, and the claims keep their status');
