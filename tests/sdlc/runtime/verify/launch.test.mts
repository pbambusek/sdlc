import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { USAGE } from '../../../../plugins/sdlc/runtime/verify/args.mts';
import { declaring, fakeBin, needs, repoWithRemote, runtimeDir, temp, VERIFY_MD } from './helpers.mts';

/** A new git repo, without a remote, with these committed files, plus a gitignored `.env`. */
const repo = (files: Record<string, string>) => {
  const dir = temp('sdlc-launch-');
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=test', '-c', 'user.email=test@example.com', ...a], { stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  for (const [p, text] of Object.entries({ '.gitignore': '.env\n', ...files })) writeFileSync(join(dir, p), text);
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  writeFileSync(join(dir, '.env'), 'LOCAL=1\n');
  writeFileSync(join(dir, 'untracked.txt'), 'not committed\n');
  return dir;
};

const MODEL_KEY = `fake-model-key-${process.pid}`;
const EVIDENCE = JSON.stringify({
  environment: ['nothing to set up'],
  claims: [{ id: 'C1', text: 'It runs.', origin: 'quoted', items: [{ type: 'command', shows: 'It ran.', how: 'echo ran', payload: 'ran', status: 'shown' }] }],
});
const writeEvidence = `mkdir -p .verify && node -e 'require("fs").writeFileSync(".verify/evidence.json", process.argv[1])' '${EVIDENCE}'`;

interface Launched {
  status: number | null;
  out: string;
  err: string;
  // How the verifier was started and what its commands printed, when it was started at all.
  record: { args: string[]; cwd: string; env: Record<string, string>; results: { command: string; status: number; out: string }[] } | null;
}

/** Runs the launcher in `cwd` with `args`; a fake verifier (fake-claude.mts) runs `commands` in the workspace. */
const launch = (cwd: string, args: string[], { commands = [] as string[], bin = {} as Record<string, string> } = {}): Launched => {
  const dir = temp('sdlc-launch-run-');
  writeFileSync(join(dir, 'commands.json'), JSON.stringify(commands));
  const record = join(dir, 'record.json');
  const path = fakeBin({ claude: `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(import.meta.dirname, 'fake-claude.mts'))} "$@"`, ...bin });
  const r = spawnSync(process.execPath, [join(runtimeDir, 'launch.mts'), ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 300_000,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE'))),
      PATH: `${path}:${process.env.PATH}`,
      CLAUDE_CONFIG_DIR: join(dir, 'claude-config'),
      VERIFY_NO_OPEN: '1',
      ANTHROPIC_API_KEY: MODEL_KEY,
      FAKE_CLAUDE_COMMANDS: join(dir, 'commands.json'),
      FAKE_CLAUDE_RECORD: record,
    },
  });
  return { status: r.status, out: r.stdout, err: r.stderr, record: existsSync(record) ? JSON.parse(readFileSync(record, 'utf8')) : null };
};
const claims = (cwd: string, opts?: Parameters<typeof launch>[2]) => {
  const file = join(temp('sdlc-claims-'), 'claims.md');
  writeFileSync(file, '1. It runs.\n');
  return launch(cwd, ['--claims', file, '--slug', 'test'], opts);
};
const pages = (dir: string) => (existsSync(join(dir, '.verify/test')) ? readdirSync(join(dir, '.verify/test')) : []);

// Folders a launch leaves on purpose: an export for setup, and the run and state folders of a broken run.
const kept: string[] = [];
const keep = (out: string) => {
  for (const m of out.matchAll(
    /^exported (\S+)$|--profile (\S+)\/workspace-profile\.json|the run folder is kept at (\S+); the command log is (\S+)\/commands\.jsonl/gm,
  ))
    kept.push(...m.slice(1).filter((d): d is string => Boolean(d)));
};
afterEach(() => {
  for (const dir of kept.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('launch', () => {
  it('prints the usage line and exits 1 without arguments', () => {
    const out = launch(repo({ 'README.md': 'x' }), []);
    expect(out.status).toBe(1);
    expect(out.err.trim()).toBe(USAGE);
  });

  it('exports the commit alone with its own VERIFY.md, copies what --copy names, and starts no verifier', () => {
    // Setup writes VERIFY.md, so an export needs neither a remote nor VERIFY.md on the default branch.
    const dir = repo({ 'VERIFY.md': '# VERIFY\n', 'app.js': 'console.log(1)\n' });
    const out = launch(dir, ['--export-only', '--copy', '.env']);
    keep(out.out);
    expect(out.status).toBe(0);
    const work = out.out.match(/^exported (.+)$/m)?.[1];
    expect(work).toBeDefined();
    expect(readFileSync(join(work!, 'VERIFY.md'), 'utf8')).toBe('# VERIFY\n');
    expect(readFileSync(join(work!, 'app.js'), 'utf8')).toBe('console.log(1)\n');
    expect(readFileSync(join(work!, '.env'), 'utf8')).toBe('LOCAL=1\n');
    expect(existsSync(join(work!, 'untracked.txt'))).toBe(false);
    expect(existsSync(join(work!, '.git'))).toBe(false);
    const commit = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    expect(JSON.parse(readFileSync(join(work!, '.verify/target.json'), 'utf8'))).toMatchObject({ ref: 'main', commit, source: 'none' });
    expect(out.record).toBeNull();
  });

  const shell = needs('prints the command that opens a shell in the workspace a run gets', 'nono');
  it.skipIf(shell.skip)(shell.name, () => {
    const out = launch(repo({ 'VERIFY.md': '# VERIFY\n' }), ['--export-only']);
    keep(out.out);
    expect(out.out).toMatch(/^a shell in its workspace: cd .* nono run .* bash$/m);
  });

  it('warns about and skips a --copy path that does not exist', () => {
    const out = launch(repo({ 'VERIFY.md': '# VERIFY\n' }), ['--export-only', '--copy', 'nope.json']);
    keep(out.out);
    expect(out.status).toBe(0);
    expect(out.err).toContain('copy: nope.json is not in');
  });

  it('stops before the verifier when the workspace cannot be set up, saying what is missing', () => {
    const { repo: dir } = repoWithRemote({ onDefault: { 'VERIFY.md': VERIFY_MD } });
    const out = claims(dir, { bin: { nono: 'exit 127' } });
    expect(out.status).toBe(1);
    expect(out.err).toMatch(/the run's workspace can't be set up on this machine: nono, which confines the workspace, is not installed.*No verifier started/s);
    expect(out.record).toBeNull();
  });
});

const nono = needs('a launch', 'nono');
describe.skipIf(nono.skip)(nono.name, () => {
  it('runs every command in the confined workspace, follows the default branch, and leaves nothing running', () => {
    const { repo: dir } = repoWithRemote({
      onDefault: { 'VERIFY.md': VERIFY_MD },
      onFeature: { 'VERIFY.md': `${VERIFY_MD}\nChanged by the feature.\n`, 'pkg/VERIFY.md': 'new\n' },
    });
    const tag = `${5000 + (process.pid % 1000)}`;
    const r = claims(dir, {
      commands: ['cat VERIFY.md; ls pkg/VERIFY.md 2>&1', `(sleep ${tag} &); echo started`, 'env', writeEvidence, 'node $RUNTIME/build-page.mts'],
    });
    keep(r.err);
    expect(r.status, r.out + r.err).toBe(0);

    // The changed VERIFY.md files are named, and the run follows the default branch's.
    expect(r.out).toContain('changes these VERIFY.md files: VERIFY.md, pkg/VERIFY.md.');
    expect(r.out).toContain("follows origin/main's versions. A change to VERIFY.md goes to main in its own pull request first");
    expect(r.record!.results[0]!.out).not.toContain('Changed by the feature');
    expect(r.record!.results[0]!.out).toContain('No such file');

    // The confinement line comes before the verifier starts.
    const banner = r.out.indexOf('▶ Workspace: local, confined by nono');
    expect(banner).toBeGreaterThanOrEqual(0);
    expect(banner).toBeLessThan(r.out.indexOf('▶ verifying headless'));
    expect(r.out).toContain('beyond its own folder it reads only the skill and runtime folders');

    // The verifier: nothing of the owner's setup, only a command and an image viewer, nothing that asks.
    const args = r.record!.args;
    for (const flag of ['--safe-mode', '--restricted', '--strict-mcp-config']) expect(args).toContain(flag);
    expect(args[args.indexOf('--tools') + 1]).toBe('Bash,Read');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('dontAsk');
    expect(r.record!.env).toMatchObject({ mcp: 'false' });
    expect(r.record!.env.prefix).toBeTruthy();

    // The workspace holds neither the verifier's model credential nor anything else of the launcher's environment.
    const env = r.record!.results[2]!.out;
    expect(env).not.toContain(MODEL_KEY);
    expect(env).not.toMatch(/^ANTHROPIC_API_KEY=/m);
    expect(r.out).toContain('Credential check: clean');

    // The page says the commands ran confined, and the command log lists each with its workspace and exit status.
    const [page] = pages(dir);
    expect(page).toBeDefined();
    expect(readFileSync(join(dir, '.verify/test', page!, 'evidence.html'), 'utf8')).toContain(
      'Workspace: local, confined; reads beyond the run folder: the skill and runtime folders',
    );
    const log = readFileSync(join(dir, '.verify/test', page!, 'commands.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    expect(log).toHaveLength(5);
    for (const c of log) expect(c).toMatchObject({ workspace: 'local', exit: expect.any(Number) });

    // What the run left running is stopped, and its folder is gone.
    expect(r.out).toContain('stopped what the run left running: 1 process');
    expect(spawnSync('pgrep', ['-f', `sleep ${tag}`], { encoding: 'utf8' }).stdout.trim()).toBe('');
    expect(existsSync(r.record!.cwd)).toBe(false);
  });

  it('a refused access breaks the run: each path is printed, the launcher fails, and no page is written', () => {
    const { repo: dir } = repoWithRemote({ onDefault: { 'VERIFY.md': VERIFY_MD } });
    const source = join(dir, 'README.md');
    const r = claims(dir, { commands: [`cat ${source}`, writeEvidence] });
    keep(r.err);
    expect(r.status).not.toBe(0);
    expect(r.err).toContain('the workspace refused 1 access; this run is broken and has no page');
    expect(r.err).toContain(source);
    expect(pages(dir)).toEqual([]);
  });

  it('a declared credential reaches the workspace only as a placeholder, and the proxy is reachable from it', () => {
    const value = `real-api-value-${process.pid}`;
    const { repo: dir } = repoWithRemote({ onDefault: { 'VERIFY.md': declaring(['api.example.com']) } });
    const r = claims(dir, {
      commands: ['printenv API_KEY; printenv HTTPS_PROXY | grep -c 127.0.0.1', 'curl -sS -o /dev/null -w "%{http_code}\\n" https://example.com', writeEvidence],
      bin: { az: `echo ${value}` },
    });
    keep(r.err);
    expect(r.status, r.out + r.err).toBe(0);
    const [env, web] = r.record!.results;
    const [placeholder, proxied] = env!.out.trim().split('\n');
    expect(placeholder!.length).toBeGreaterThanOrEqual(32);
    expect(env!.out).not.toContain(value);
    expect(proxied).toBe('1');
    expect(web!.out.trim()).toBe('200');
    expect(r.out).toContain('Credential check: clean');
  });

  it('stops before the verifier when a declared credential cannot be read, naming it and why', () => {
    const { repo: dir } = repoWithRemote({ onDefault: { 'VERIFY.md': declaring(['api.example.com']) } });
    const r = claims(dir, { bin: { az: `echo "ERROR: Please run 'az login' to setup account." >&2; exit 1` } });
    expect(r.status).toBe(1);
    expect(r.err).toContain("credential API_KEY can't be read: example-vault/api-key: Please run 'az login' to setup account.");
    expect(r.err).toContain('No verifier started');
    expect(r.record).toBeNull();
  });

  it('refuses malformed credentials on the default branch before the verifier', () => {
    const { repo: dir } = repoWithRemote({ onDefault: { 'VERIFY.md': '## Credentials\n\n```json\n{"vault":"x","credentials":[]}\n```\n' } });
    const r = claims(dir);
    expect(r.status).toBe(1);
    expect(r.err).toContain('✖ VERIFY.md Credentials:');
    expect(r.record).toBeNull();
  });

  it('refuses a spec that is not in the commit', () => {
    const { repo: dir } = repoWithRemote({ onDefault: { 'VERIFY.md': VERIFY_MD } });
    const r = launch(dir, ['missing.md']);
    expect(r.status).toBe(1);
    expect(r.err).toContain('missing.md does not exist at feature');
  });

  it('stops before the verifier when the default branch has no VERIFY.md', () => {
    const { repo: dir } = repoWithRemote({ onDefault: {}, onFeature: { 'VERIFY.md': VERIFY_MD } });
    const r = claims(dir);
    expect(r.status).toBe(1);
    expect(r.err).toMatch(/origin\/main has no VERIFY\.md at its root.*merge the project's VERIFY\.md to main first/);
    expect(r.record).toBeNull();
  });

  it('stops before the verifier when the default branch cannot be read', () => {
    const { repo: dir } = repoWithRemote({ onDefault: { 'VERIFY.md': VERIFY_MD } });
    execFileSync('git', ['-C', dir, 'remote', 'set-url', 'origin', join(dir, 'gone.git')]);
    const r = claims(dir);
    expect(r.status).toBe(1);
    expect(r.err).toMatch(/the default branch of origin can't be read.*No verifier started/s);
    expect(r.record).toBeNull();
  });
});
