import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { openWorkspace, prepareWorkspace, RUNS, type Workspace } from '../../skills/sdlc/verify/scripts/workspace.mts';
import type { LoggedCommand } from '../../skills/sdlc/verify/scripts/workspace-shell.mts';
import { needsNono, SKILL } from './helpers.mts';

const q = (s: string) => `'${s.replaceAll("'", `'"'"'`)}'`;

describe('a command in the workspace', { skip: needsNono }, () => {
  let ws: Workspace;
  let work: string;
  let stateDir: string;
  let outside: string;
  let tempOutside: string;
  const cwdFile = join(realpathSync(tmpdir()), `verify-test-cwd-${process.pid}`);
  const secret = `real-secret-${process.pid}`;
  const marker = `marker-${process.pid}`;
  let outsider: ReturnType<typeof spawn>;

  /** Runs `command` through the verifier's shell as Claude Code's Bash tool does, from `cwd`. */
  const run = (command: string, cwd = work) => {
    const script = `shopt -u extglob 2>/dev/null || true && eval ${q(command)} < /dev/null && pwd -P >| ${q(cwdFile)}`;
    const r = spawnSync('bash', ['-c', `${q(ws.shell)} ${q(script)}`], { cwd, encoding: 'utf8', timeout: 60_000 });
    return { status: r.status, out: r.stdout, err: r.stderr };
  };
  const logged = (): LoggedCommand[] => readFileSync(ws.commandLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

  before(async () => {
    mkdirSync(RUNS, { recursive: true });
    work = realpathSync(mkdtempSync(join(RUNS, 'r-')));
    stateDir = realpathSync(mkdtempSync(join(RUNS, 'l-')));
    mkdirSync(join(work, '.verify'), { recursive: true });
    // Stand-ins for what the workspace must not reach: a file in the owner's home outside the run (the launcher's own folder),
    // and a file in the system temp where Claude Code keeps its sessions' files.
    outside = join(stateDir, 'outside.txt');
    writeFileSync(outside, 'owner data\n');
    tempOutside = realpathSync(mkdtempSync(join('/tmp', 'claude-test-')));
    writeFileSync(join(tempOutside, 'session.jsonl'), 'transcript\n');
    // A process outside the workspace whose environment holds a secret.
    outsider = spawn('sleep', ['120'], { env: { ...process.env, VERIFY_TEST_MARKER: marker }, stdio: 'ignore' });
    process.env.VERIFY_TEST_SECRET = secret;
    ws = await openWorkspace(prepareWorkspace({ work, skillDir: SKILL, stateDir, env: { PATH: process.env.PATH!, LANG: 'C', GIVEN: 'placeholder' } }));
  });

  after(async () => {
    outsider?.kill();
    delete process.env.VERIFY_TEST_SECRET;
    await ws?.close();
    for (const d of [work, stateDir, tempOutside, cwdFile]) if (d) rmSync(d, { recursive: true, force: true });
  });

  test('runs in the run folder, keeps its exit status, and reports the folder it ended in', () => {
    mkdirSync(join(work, 'sub'), { recursive: true });
    const r = run('echo hello; cd sub');
    assert.equal(r.status, 0);
    assert.equal(r.out, 'hello\n');
    assert.equal(readFileSync(cwdFile, 'utf8').trim(), join(work, 'sub'));
    assert.equal(run('exit 7').status, 7);
  });

  test('logs every command with its workspace and exit status', () => {
    run('echo logged; exit 3');
    const entry = logged().find((c) => c.command === 'echo logged; exit 3');
    assert.ok(entry);
    assert.equal(entry.workspace, 'local');
    assert.equal(entry.exit, 3);
    assert.equal(entry.cwd, work);
  });

  test('gets nothing from a file in the source repo', () => {
    const r = run(`cat ${q(join(SKILL, '../../../tests/verify/workspace.test.mts'))}`);
    assert.notEqual(r.status, 0);
    assert.equal(r.out, '');
  });

  test("gets nothing from the owner's home outside the toolchains, and its own home is the run's", () => {
    const r = run(`cat ${q(outside)}; echo "home=$HOME"`);
    assert.doesNotMatch(r.out, /owner data/);
    assert.match(r.out, new RegExp(`home=${join(work, '.verify/home')}`));
  });

  test("gets nothing from the system temp, where Claude Code keeps its sessions' files", () => {
    const r = run(`cat ${q(join(tempOutside, 'session.jsonl'))}; ls ${q(tempOutside)}`);
    assert.doesNotMatch(r.out, /transcript|session\.jsonl/);
  });

  test('records each refused access with its path', () => {
    run(`cat ${q(outside)}`);
    assert.ok(logged().some((c) => c.refused.some((x) => x.path === outside)), JSON.stringify(logged().map((c) => c.refused)));
  });

  test('does not land a write outside the run folder and temp', () => {
    const target = join(stateDir, 'written.txt');
    run(`echo x > ${q(target)}; touch ${q(join(tempOutside, 'written'))}`);
    assert.equal(existsSync(target), false);
    // Linux's /tmp is temp the workspace may write, though not read; macOS's holds Claude Code's files and is refused.
    if (platform() === 'darwin') assert.equal(existsSync(join(tempOutside, 'written')), false);
    assert.equal(run('echo t > "$TMPDIR/own" && cat "$TMPDIR/own"').out, 't\n');
  });

  test("holds only the environment it was given, and sees no other process's", () => {
    const env = run('env').out;
    assert.match(env, /^GIVEN=placeholder$/m);
    assert.doesNotMatch(env, new RegExp(secret));
    const scan = run(`{ ps -E -A -ww -o command= 2>/dev/null; cat /proc/[0-9]*/environ 2>/dev/null | tr '\\0' '\\n'; } | grep -c -e ${q(marker)} -e ${q(secret)}; true`);
    assert.equal(scan.out.trim(), '0');
  });

  test('gets no Azure CLI token', { skip: spawnSync('az', ['version']).status === 0 ? false : 'no Azure CLI' }, () => {
    const r = run('az account get-access-token --query accessToken -o tsv');
    assert.notEqual(r.status, 0);
    assert.equal(r.out.trim(), '');
  });

  test('keeps what a command started in the background running for the next, and stops it on close', async () => {
    const tag = `${4000 + (process.pid % 1000)}`;
    assert.equal(run(`(sleep ${tag} &); echo started`).out, 'started\n');
    assert.equal(run('echo next').out, 'next\n');
    const before = spawnSync('pgrep', ['-f', `sleep ${tag}`], { encoding: 'utf8' }).stdout.trim();
    assert.notEqual(before, '', 'the background process should outlive its command');
    const closed = await ws.close();
    assert.deepEqual(closed.stillRunning, []);
    assert.equal(spawnSync('pgrep', ['-f', `sleep ${tag}`], { encoding: 'utf8' }).stdout.trim(), '');
  });
});
