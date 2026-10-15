/**
 * Verifies one commit against its claims in a fresh Claude Code session that knows nothing of how the code was written,
 * and prints where the evidence page is. Run it from anywhere inside the repo:
 *   node <runtime dir>/launch.mts <spec path at the target> [ref]
 *   node <runtime dir>/launch.mts --claims <file> [--source <label>] [ref]
 *   node <runtime dir>/launch.mts --export-only [ref]   (setup: export and copy, print the folder, start no session)
 *   options: --copy <path> (repeatable), --slug <name>, --interactive
 * The page lands in <repo>/.verify/<slug>/<timestamp>-<commit>/ and opens; VERIFY_NO_OPEN=1 keeps it closed.
 *
 * What keeps the verifier honest:
 *   - the target is exported with `git archive` into a new temp folder: no history, no diff, no untracked files;
 *   - the session is a new process: none of the caller's session, git's search stops above the folder, auto-memory is off;
 *   - Claude Code's file tools only read the run folder, and are denied the source repo and the session transcripts;
 *   - afterwards the session's transcript is audited, and the page shows the verdict and any exported file it changed.
 * The method (run.md) comes from the verify skill in the plugin the launcher runs from; the claims, VERIFY.md and the code come from the target commit.
 *
 * When VERIFY.md declares credentials, the run holds only placeholders for them (credentials.mts): the launcher reads the real
 * values from the declared Key Vault, and nono's proxy puts them on requests to each credential's hosts, logging every such request.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from './args.mts';
import { audit, snapshot } from './audit.mts';
import { findValues, findValuesInProcesses, parseDeclaration, readCredentials, requireNono, startProxy } from './credentials.mts';

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
const { exportOnly, claimsFile, spec, copies, slug, interactive, ref: refArg } = options;

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

const verifyMd = atTarget('VERIFY.md');
if (!exportOnly && verifyMd === null) fail(`no VERIFY.md at the repo root at ${ref}: set the project up first (the skill's setup.md)`);
let declaration: ReturnType<typeof parseDeclaration> = null;
try {
  declaration = exportOnly || verifyMd === null ? null : parseDeclaration(verifyMd);
} catch (e) {
  fail(`✖ ${(e as Error).message}`);
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

const ranAt = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const run = `${ranAt.replaceAll(':', '-')}-${commit.slice(0, 7)}`;
const work = realpathSync(mkdtempSync(join(tmpdir(), `verify-${basename(mainCheckout)}-${slug}-`)));
// The skill's method and assets sit beside the runtime in the plugin; the verifier reads both.
const runtimeDir = realpathSync(import.meta.dirname);
const skillDir = realpathSync(resolve(runtimeDir, '../../skills/verify'));
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
// The skill's folder stays readable for the example evidence, and the runtime's for the page builder.
const settings = { autoMemoryEnabled: false, permissions: { deny: denied.map((p) => `Read(/${p}/**)`), additionalDirectories: [skillDir, runtimeDir] } };
writeFileSync(join(verifyDir, 'settings.json'), JSON.stringify(settings, null, 2) + '\n');

if (exportOnly) {
  console.log(`exported ${work}`);
  process.exit(0);
}

// Each credential is read before the session starts, with the Azure CLI's cached login: nothing here can wait on a person.
const reads = declaration ? requireNono(await readCredentials(declaration)) : [];
for (const r of reads) {
  if (r.outcome === 'read')
    console.log(
      `▶ credential ${r.name}: read from ${declaration!.vault}/${r.secret} without a prompt; the run holds a placeholder, swapped on ${r.hosts.join(', ')}`,
    );
  else console.log(`✖ credential ${r.name}: unavailable, ${r.reason}`);
}
const credentialLog = join(verifyDir, 'credential-requests.jsonl');
const proxy = reads.some((r) => r.outcome === 'read')
  ? await startProxy({
      reads,
      profileFile: join(verifyDir, 'nono-profile.json'),
      nonoLog: join(verifyDir, 'nono-proxy.log'),
      log: credentialLog,
      baseEnv: process.env,
    })
  : null;
if (proxy) console.log('▶ credential proxy (nono) started; the run holds its token, never a value');

const credentialLines = reads.map((r) =>
  r.outcome === 'read'
    ? `- \`${r.name}\`: set in your environment as a placeholder. The run's proxy swaps it for the real value on requests to ${r.hosts.join(', ')} only; anywhere else it arrives as the placeholder.`
    : `- \`${r.name}\`: unavailable (${r.reason}). It is not set in your environment.`,
);
const prompt = [
  `Verify commit ${commit} (${ref}) against the claims below. They come from ${source}, unchanged.`,
  `The skill's folder is ${skillDir}.`,
  `The runtime's folder is ${runtimeDir}.`,
  '',
  ...(declaration
    ? ['Credentials declared in VERIFY.md:', ...credentialLines, `Every request that used one is logged in \`.verify/credential-requests.jsonl\`.`, '']
    : []),
  '<claims>',
  claims.trim(),
  '</claims>',
].join('\n');
const childEnv: NodeJS.ProcessEnv = {
  ...(proxy?.env ?? process.env),
  GIT_CEILING_DIRECTORIES: dirname(work),
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  VERIFY_MODE: interactive ? 'interactive' : 'headless',
  // One shell for every verifier, whatever the owner's login shell is.
  SHELL: execFileSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).trim(),
};
// A launcher started from inside a Claude Code session must not hand the verifier that session's identity.
for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_JOB_DIR']) delete childEnv[k];
const sessionId = randomUUID();
const claudeArgs = [
  '--session-id',
  sessionId,
  '--settings',
  join(verifyDir, 'settings.json'),
  '--append-system-prompt-file',
  join(skillDir, 'run.md'),
  '--allowedTools',
  'Bash',
];

// The proxy runs in this process, so the session is never spawned synchronously: a blocked event loop would stall every request.
let sampled = 0;
const processLeaks = new Set<string>();
const sampleProcesses = (pid: number | undefined) => {
  if (!proxy || !pid) return;
  proxy.collect();
  const { hits, processes } = findValuesInProcesses({ values: proxy.values, rootPid: pid });
  sampled = Math.max(sampled, processes);
  for (const h of hits) processLeaks.add(h);
};
if (interactive) {
  console.log('▶ starting an interactive verification session (approve the folder trust prompt)');
  const session = spawn('claude', [...claudeArgs, prompt], { cwd: work, env: childEnv, stdio: 'inherit' });
  const timer = setInterval(() => sampleProcesses(session.pid), 15_000);
  await new Promise((done) => session.once('close', done));
  clearInterval(timer);
} else {
  console.log(`▶ verifying headless, session ${sessionId}`);
  const session = spawn('claude', ['-p', prompt, ...claudeArgs, '--permission-mode', 'acceptEdits', '--output-format', 'stream-json', '--verbose'], {
    cwd: work,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  // The run's processes are sampled while they live, to show no environment in the run holds a real value.
  const timer = setInterval(() => sampleProcesses(session.pid), 15_000);
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

// Once the session ends, its proxy token and placeholders reach nothing.
await proxy?.stop();
if (proxy) console.log('▶ credential proxy (nono) stopped');

console.log('▶ auditing the session');
const transcript = join(configDir, 'projects', work.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);
const result = audit({ transcript: existsSync(transcript) ? transcript : null, work, repos: [repo, mainCheckout], allowed: [skillDir, runtimeDir], before });
if (declaration) {
  const leaks = proxy
    ? [
        ...findValues({
          values: proxy.values,
          root: work,
          texts: existsSync(transcript) ? { 'the session transcript': readFileSync(transcript, 'utf8') } : {},
        }),
        ...processLeaks,
      ]
    : [];
  const requests = existsSync(credentialLog) ? readFileSync(credentialLog, 'utf8').split('\n').filter(Boolean).length : 0;
  const read = reads.filter((r) => r.outcome === 'read').map((r) => r.name);
  const unavailable = reads.flatMap((r) => (r.outcome === 'unavailable' ? [`${r.name} (${r.reason})`] : []));
  result.credentials = [
    `Credentials: ${read.length ? `${read.join(', ')} held as ${read.length === 1 ? 'a placeholder' : 'placeholders'}, swapped by the proxy on ${read.length === 1 ? 'its' : 'their'} declared hosts` : 'none could be read'}${unavailable.length ? `; unavailable: ${unavailable.join('; ')}` : ''}. ${requests} credentialed request${requests === 1 ? '' : 's'} logged.`,
    ...(proxy
      ? [
          leaks.length
            ? `Credential check: VIOLATED, a real value appeared: ${leaks.join('; ')}. Rotate it.`
            : `Credential check: clean, no real value in the run folder, the session transcript, or the environments of ${sampled} sampled run process${sampled === 1 ? '' : 'es'}.`,
        ]
      : []),
  ];
  if (leaks.length) result.clean = false;
}
writeFileSync(join(verifyDir, 'audit.json'), JSON.stringify(result, null, 2) + '\n');
console.log(result.verdict);
for (const line of result.credentials ?? []) console.log(line);

if (!existsSync(join(verifyDir, 'evidence.json'))) {
  console.error(`✖ the session wrote no evidence; its folder is kept at ${work}`);
  console.error(`  to inspect or continue it: cd ${work} && claude --resume ${sessionId}`);
  process.exit(1);
}
// Rebuilt so the page carries the audit; the builder prints the summary.
const out = join(repo, '.verify', slug, run);
mkdirSync(out, { recursive: true });
const built = spawnSync('node', [join(runtimeDir, 'build-page.mts'), '.verify'], { cwd: work, stdio: 'inherit' });
for (const f of ['evidence.html', 'audit.json', 'shots', 'credential-requests.jsonl']) {
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
