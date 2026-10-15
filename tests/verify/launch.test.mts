import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fakeBin, makeRepo, needsNono, SKILL, VERIFY_MD } from './helpers.mts';

const MODEL_KEY = `fake-model-key-${process.pid}`;
const EVIDENCE = JSON.stringify({
  environment: ['nothing to set up'],
  claims: [{ id: 'C1', text: 'It runs.', origin: 'quoted', items: [{ type: 'command', shows: 'It ran.', how: 'echo ran', payload: 'ran', status: 'shown' }] }],
});
const writeEvidence = `mkdir -p .verify && node -e 'require("fs").writeFileSync(".verify/evidence.json", process.argv[1])' '${EVIDENCE}'`;

/** Launches a run of `repo`'s HEAD with a fake verifier that runs `commands`; returns what the launcher and the verifier did. */
const launch = (repo: string, commands: string[], { bin = {} as Record<string, string> } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'verify-launch-'));
  writeFileSync(join(dir, 'claims.md'), '1. It runs.\n');
  writeFileSync(join(dir, 'commands.json'), JSON.stringify(commands));
  const record = join(dir, 'record.json');
  const path = fakeBin({ claude: `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(import.meta.dirname, 'fake-claude.mts'))} "$@"`, ...bin });
  const r = spawnSync(process.execPath, [join(SKILL, 'scripts/launch.mts'), '--claims', join(dir, 'claims.md'), '--slug', 'test'], {
    cwd: repo,
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
  const started = existsSync(record);
  return {
    status: r.status,
    out: r.stdout,
    err: r.stderr,
    started,
    record: started ? (JSON.parse(readFileSync(record, 'utf8')) as { args: string[]; cwd: string; env: Record<string, string>; results: { command: string; status: number; out: string }[] }) : null,
  };
};
/** Removes the run and state folders a broken run keeps for inspection. */
const removeKept = (err: string) => {
  const kept = err.match(/the run folder is kept at (\S+); the command log is (\S+)\/commands\.jsonl/);
  for (const dir of kept?.slice(1) ?? []) rmSync(dir, { recursive: true, force: true });
};
const pages = (repo: string) => (existsSync(join(repo, '.verify/test')) ? readdirSync(join(repo, '.verify/test')) : []);

describe('a launch', { skip: needsNono }, () => {
  test('runs every command in the confined workspace, follows the default branch, and leaves nothing running', () => {
    const { repo } = makeRepo({ onDefault: { 'VERIFY.md': VERIFY_MD }, onFeature: { 'VERIFY.md': `${VERIFY_MD}\nChanged by the feature.\n`, 'pkg/VERIFY.md': 'new\n' } });
    const tag = `${5000 + (process.pid % 1000)}`;
    const r = launch(repo, ['cat VERIFY.md; ls pkg/VERIFY.md 2>&1', `(sleep ${tag} &); echo started`, 'env', writeEvidence, 'node $SKILL/scripts/build-page.mts']);
    assert.equal(r.status, 0, r.out + r.err);

    // The changed VERIFY.md files are named, and the run follows the default branch's.
    assert.match(r.out, /changes these VERIFY\.md files: VERIFY\.md, pkg\/VERIFY\.md\./);
    assert.match(r.out, /follows origin\/main's versions\. A change to VERIFY\.md goes to main in its own pull request first/);
    assert.equal(r.record!.results[0]!.out.includes('Changed by the feature'), false);
    assert.match(r.record!.results[0]!.out, /No such file/);

    // The confinement line comes before the verifier starts.
    const banner = r.out.indexOf('▶ Workspace: local, confined by nono');
    assert.ok(banner >= 0 && banner < r.out.indexOf('▶ verifying headless'), r.out);
    assert.match(r.out, /beyond its own folder it reads only the skill folder/);

    // The verifier: nothing of the owner's setup, only a command and an image viewer, nothing that asks.
    const args = r.record!.args;
    for (const flag of ['--safe-mode', '--restricted', '--strict-mcp-config']) assert.ok(args.includes(flag), flag);
    assert.equal(args[args.indexOf('--tools') + 1], 'Bash,Read');
    assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
    assert.equal(r.record!.env.mcp, 'false');
    assert.ok(r.record!.env.prefix);

    // The workspace holds neither the verifier's model credential nor anything else of the launcher's environment.
    const env = r.record!.results[2]!.out;
    assert.doesNotMatch(env, new RegExp(MODEL_KEY));
    assert.doesNotMatch(env, /^ANTHROPIC_API_KEY=/m);
    assert.match(r.out, /Credential check: clean/);

    // The page says the commands ran confined, and the command log lists each with its workspace and exit status.
    const [page] = pages(repo);
    assert.ok(page, 'a page');
    const html = readFileSync(join(repo, '.verify/test', page, 'evidence.html'), 'utf8');
    assert.match(html, /Workspace: local, confined; reads beyond the run folder: the skill folder/);
    const log = readFileSync(join(repo, '.verify/test', page, 'commands.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(log.length, 5);
    for (const c of log) {
      assert.equal(c.workspace, 'local');
      assert.equal(typeof c.exit, 'number');
    }

    // What the run left running is stopped, and its folder is gone.
    assert.match(r.out, /stopped what the run left running: 1 process/);
    assert.equal(spawnSync('pgrep', ['-f', `sleep ${tag}`], { encoding: 'utf8' }).stdout.trim(), '');
    assert.equal(existsSync(r.record!.cwd), false);
  });

  test('a refused access breaks the run: each path is printed, the launcher fails, and no page is written', () => {
    const { repo } = makeRepo({ onDefault: { 'VERIFY.md': VERIFY_MD } });
    const source = join(repo, 'README.md');
    const r = launch(repo, [`cat ${source}`, writeEvidence]);
    removeKept(r.err);
    assert.notEqual(r.status, 0);
    assert.match(r.err, /the workspace refused 1 access; this run is broken and has no page/);
    assert.ok(r.err.includes(source), r.err);
    assert.deepEqual(pages(repo), []);
  });

  test('stops before the verifier when the default branch has no VERIFY.md', () => {
    const { repo } = makeRepo({ onDefault: {}, onFeature: { 'VERIFY.md': VERIFY_MD } });
    const r = launch(repo, []);
    assert.equal(r.status, 1);
    assert.match(r.err, /origin\/main has no VERIFY\.md at its root.*merge the project's VERIFY\.md to main first/);
    assert.equal(r.started, false);
  });

  test('stops before the verifier when the default branch cannot be read', () => {
    const { repo } = makeRepo({ onDefault: { 'VERIFY.md': VERIFY_MD } });
    spawnSync('git', ['-C', repo, 'remote', 'set-url', 'origin', join(repo, 'gone.git')]);
    const r = launch(repo, []);
    assert.equal(r.status, 1);
    assert.match(r.err, /the default branch of origin can't be read.*No verifier started/s);
    assert.equal(r.started, false);
  });

  test('a declared credential reaches the workspace only as a placeholder, and the proxy is reachable from it', () => {
    const value = `real-api-value-${process.pid}`;
    const declared = `${VERIFY_MD}\n## Credentials\n\n\`\`\`json\n{ "vault": "kv-test", "credentials": [{ "name": "API_KEY", "secret": "api-key", "hosts": ["api.example.com"] }] }\n\`\`\`\n`;
    const { repo } = makeRepo({ onDefault: { 'VERIFY.md': declared } });
    const r = launch(repo, ['printenv API_KEY; printenv HTTPS_PROXY | grep -c 127.0.0.1', 'curl -sS -o /dev/null -w "%{http_code}\\n" https://example.com', writeEvidence], {
      bin: { az: `echo ${value}` },
    });
    assert.equal(r.status, 0, r.out + r.err);
    const [env, web] = r.record!.results;
    assert.ok(env!.out.trim().split('\n')[0]!.length >= 32, 'a placeholder is set');
    assert.doesNotMatch(env!.out, new RegExp(value));
    assert.equal(env!.out.trim().split('\n')[1], '1');
    assert.equal(web!.out.trim(), '200', web!.out);
    assert.match(r.out, /Credential check: clean/);
  });

  test('stops before the verifier when a declared credential cannot be read, naming it and why', () => {
    const declared = `${VERIFY_MD}\n## Credentials\n\n\`\`\`json\n{ "vault": "kv-test", "credentials": [{ "name": "API_KEY", "secret": "api-key", "hosts": ["api.example.com"] }] }\n\`\`\`\n`;
    const { repo } = makeRepo({ onDefault: { 'VERIFY.md': declared } });
    const r = launch(repo, [], { bin: { az: `echo "ERROR: Please run 'az login' to setup account." >&2; exit 1` } });
    assert.equal(r.status, 1);
    assert.match(r.err, /credential API_KEY can't be read: kv-test\/api-key: Please run 'az login' to setup account\./);
    assert.match(r.err, /No verifier started/);
    assert.equal(r.started, false);
  });
});

test('setup exports the commit with its own VERIFY.md, before the default branch has one, and starts no verifier', { skip: needsNono }, () => {
  const { repo } = makeRepo({ onDefault: {}, onFeature: { 'VERIFY.md': VERIFY_MD } });
  const r = spawnSync(process.execPath, [join(SKILL, 'scripts/launch.mts'), '--export-only'], { cwd: repo, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const work = r.stdout.match(/^exported (\S+)$/m)?.[1];
  assert.ok(work);
  assert.equal(readFileSync(join(work, 'VERIFY.md'), 'utf8'), VERIFY_MD);
  assert.match(r.stdout, /^a shell in its workspace: cd .* nono run .* bash$/m);
  const profile = r.stdout.match(/--profile (\S+)\/workspace-profile\.json/)?.[1];
  for (const dir of [work, profile]) if (dir) rmSync(dir, { recursive: true, force: true });
});

test('stops before the verifier when the workspace cannot be set up, saying what is missing', () => {
  const { repo } = makeRepo({ onDefault: { 'VERIFY.md': VERIFY_MD } });
  const r = launch(repo, [], { bin: { nono: 'exit 127' } });
  assert.equal(r.status, 1);
  assert.match(r.err, /the run's workspace can't be set up on this machine: nono, which confines the workspace, is not installed.*No verifier started/s);
  assert.equal(r.started, false);
});
