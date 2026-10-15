import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openWorkspace, prepareWorkspace, RUNS, type Workspace } from '../../../../plugins/sdlc/runtime/verify/workspace.mts';
import type { LoggedCommand } from '../../../../plugins/sdlc/runtime/verify/workspace-shell.mts';
import { needs, runtimeDir, skillDir } from './helpers.mts';

const q = (s: string) => `'${s.replaceAll("'", `'"'"'`)}'`;
const t = needs('a command in the workspace', 'nono');

describe.skipIf(t.skip)(t.name, () => {
  let ws: Workspace;
  let work: string;
  let stateDir: string;
  let outside: string;
  let tempOutside: string;
  let outsider: ReturnType<typeof spawn>;
  const cwdFile = join(realpathSync(tmpdir()), `sdlc-test-cwd-${process.pid}`);
  const secret = `real-secret-${process.pid}`;
  const marker = `marker-${process.pid}`;

  /** Runs `command` through the verifier's shell as Claude Code's Bash tool does, from `cwd`. */
  const run = (command: string, cwd = work) => {
    const script = `shopt -u extglob 2>/dev/null || true && eval ${q(command)} < /dev/null && pwd -P >| ${q(cwdFile)}`;
    const r = spawnSync('bash', ['-c', `${q(ws.shell)} ${q(script)}`], { cwd, encoding: 'utf8', timeout: 60_000 });
    return { status: r.status, out: r.stdout, err: r.stderr };
  };
  const logged = (): LoggedCommand[] =>
    readFileSync(ws.commandLog, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));

  beforeAll(async () => {
    mkdirSync(RUNS, { recursive: true });
    work = realpathSync(mkdtempSync(join(RUNS, 'r-')));
    stateDir = realpathSync(mkdtempSync(join(RUNS, 'l-')));
    mkdirSync(join(work, '.verify'), { recursive: true });
    // Stand-ins for what the workspace must not reach: a file in the owner's home outside the run (the launcher's own folder),
    // and a file in the system temp, where Claude Code keeps its sessions' files.
    outside = join(stateDir, 'outside.txt');
    writeFileSync(outside, 'owner data\n');
    tempOutside = realpathSync(mkdtempSync(join('/tmp', 'claude-test-')));
    writeFileSync(join(tempOutside, 'session.jsonl'), 'transcript\n');
    // A process outside the workspace whose environment holds a secret.
    outsider = spawn('sleep', ['120'], { env: { ...process.env, SDLC_TEST_MARKER: marker }, stdio: 'ignore' });
    process.env.SDLC_TEST_SECRET = secret;
    ws = await openWorkspace(prepareWorkspace({ work, runtimeDir, skillDir, stateDir, env: { PATH: process.env.PATH!, LANG: 'C', GIVEN: 'placeholder' } }));
  });

  afterAll(async () => {
    outsider?.kill();
    delete process.env.SDLC_TEST_SECRET;
    await ws?.close();
    for (const d of [work, stateDir, tempOutside, cwdFile]) if (d) rmSync(d, { recursive: true, force: true });
  });

  it('runs in the run folder, keeps its exit status, and reports the folder it ended in', () => {
    mkdirSync(join(work, 'sub'), { recursive: true });
    const r = run('echo hello; cd sub');
    expect(r.status).toBe(0);
    expect(r.out).toBe('hello\n');
    expect(readFileSync(cwdFile, 'utf8').trim()).toBe(join(work, 'sub'));
    expect(run('exit 7').status).toBe(7);
  });

  it('logs every command with its workspace and exit status', () => {
    run('echo logged; exit 3');
    expect(logged().find((c) => c.command === 'echo logged; exit 3')).toMatchObject({ workspace: 'local', exit: 3, cwd: work });
  });

  it('gets nothing from a file in the source repo', () => {
    const r = run(`cat ${q(join(runtimeDir, '../../../../tests/sdlc/runtime/verify/workspace.test.mts'))}`);
    expect(r.status).not.toBe(0);
    expect(r.out).toBe('');
  });

  it("gets nothing from the owner's home outside the toolchains, and its own home is the run's", () => {
    const r = run(`cat ${q(outside)}; echo "home=$HOME"`);
    expect(r.out).not.toContain('owner data');
    expect(r.out).toContain(`home=${join(work, '.verify/home')}`);
  });

  it("gets nothing from the system temp, where Claude Code keeps its sessions' files", () => {
    const r = run(`cat ${q(join(tempOutside, 'session.jsonl'))}; ls ${q(tempOutside)}`);
    expect(r.out).not.toMatch(/transcript|session\.jsonl/);
  });

  it('records each refused access with its path', () => {
    run(`cat ${q(outside)}`);
    expect(logged().some((c) => c.refused.some((x) => x.path === outside))).toBe(true);
  });

  it('does not land a write outside the run folder and temp', () => {
    const target = join(stateDir, 'written.txt');
    run(`echo x > ${q(target)}; touch ${q(join(tempOutside, 'written'))}`);
    expect(existsSync(target)).toBe(false);
    // Linux's /tmp is temp the workspace may write, though not read; macOS's holds Claude Code's files and is refused.
    if (platform() === 'darwin') expect(existsSync(join(tempOutside, 'written'))).toBe(false);
    expect(run('echo t > "$TMPDIR/own" && cat "$TMPDIR/own"').out).toBe('t\n');
  });

  it("holds only the environment it was given, and sees no other process's", () => {
    const env = run('env').out;
    expect(env).toMatch(/^GIVEN=placeholder$/m);
    expect(env).not.toContain(secret);
    const scan = run(
      `{ ps -E -A -ww -o command= 2>/dev/null; cat /proc/[0-9]*/environ 2>/dev/null | tr '\\0' '\\n'; } | grep -c -e ${q(marker)} -e ${q(secret)}; true`,
    );
    expect(scan.out.trim()).toBe('0');
  });

  const az = needs('gets no Azure CLI token', 'az');
  it.skipIf(az.skip)(az.name, () => {
    const r = run('az account get-access-token --query accessToken -o tsv');
    expect(r.status).not.toBe(0);
    expect(r.out.trim()).toBe('');
  });

  it('keeps what a command started in the background running for the next, and stops it on close', async () => {
    const tag = `${4000 + (process.pid % 1000)}`;
    expect(run(`(sleep ${tag} &); echo started`).out).toBe('started\n');
    expect(run('echo next').out).toBe('next\n');
    expect(spawnSync('pgrep', ['-f', `sleep ${tag}`], { encoding: 'utf8' }).stdout.trim()).not.toBe('');
    const closed = await ws.close();
    expect(closed.stillRunning).toEqual([]);
    expect(spawnSync('pgrep', ['-f', `sleep ${tag}`], { encoding: 'utf8' }).stdout.trim()).toBe('');
  });
});
