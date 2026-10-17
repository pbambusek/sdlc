import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cacheFolder, ensureTemplate, openWorkspace, parseRecipe, RUNS, templateName, type Workspace } from '../../src/verify/workspace.mts';
import type { LoggedCommand } from '../../src/verify/workspace-shell.mts';
import { needs, pluginDir as pluginPath, runnerDir, temp } from './helpers.mts';

const q = (s: string) => `'${s.replaceAll("'", `'"'"'`)}'`;
const section = (json: unknown) => `# Verify\n\n## Workspace\n\n\`\`\`json\n${JSON.stringify(json)}\n\`\`\`\n`;

describe('parseRecipe', () => {
  it('is the defaults when VERIFY.md has no Workspace section', () => {
    expect(parseRecipe('# Verify\n')).toEqual({ provision: '', caches: [], cpus: 4, memory: 8, disk: 60 });
    expect(parseRecipe(null).cpus).toBe(4);
  });

  it('is the defaults when the Workspace section is prose only', () => {
    expect(parseRecipe('# Verify\n\n## Workspace\n\nNode 24 or later. Nothing else.\n\n## Seams\n')).toEqual({
      provision: '',
      caches: [],
      cpus: 4,
      memory: 8,
      disk: 60,
    });
  });

  it('reads provisioning lines, caches and the size', () => {
    const recipe = parseRecipe(
      section({
        provision: ['apt-get install -y jq', 'echo done'],
        caches: [{ host: '~/.cache/tool', guest: '/var/cache/tool', env: { TOOL_CACHE: '/var/cache/tool' } }],
        cpus: 6,
      }),
    );
    expect(recipe).toEqual({
      provision: 'apt-get install -y jq\necho done',
      caches: [{ host: '~/.cache/tool', guest: '/var/cache/tool', env: { TOOL_CACHE: '/var/cache/tool' } }],
      cpus: 6,
      memory: 8,
      disk: 60,
    });
  });

  it('names every malformed field', () => {
    expect(() => parseRecipe(section({ cpus: 0, caches: [{ host: 'relative', guest: 'also' }] }))).toThrow(
      'VERIFY.md Workspace: cpus: a positive whole number; caches.0.host: a host folder, absolute or under ~/; caches.0.guest: an absolute folder in the VM',
    );
  });
});

describe('cacheFolder', () => {
  it("shares a folder that holds only a tool's packages", () => {
    const dir = temp();
    expect(cacheFolder(dir, [])).toEqual({ outcome: 'shared', path: dir });
  });

  it('refuses the home folder, a folder that holds a forbidden one, and one inside it', () => {
    const repo = temp();
    mkdirSync(join(repo, 'cache'));
    expect(cacheFolder('~/', []).outcome).toBe('refused');
    expect(cacheFolder(repo, [join(repo, 'src')])).toMatchObject({ outcome: 'refused', reason: `${repo} overlaps ${join(repo, 'src')}` });
    expect(cacheFolder(join(repo, 'cache'), [repo])).toMatchObject({ outcome: 'refused' });
  });

  it('reports a folder this machine does not have', () => {
    expect(cacheFolder('/no/such/cache', [])).toEqual({ outcome: 'missing', reason: '/no/such/cache does not exist on this machine' });
  });
});

describe('templateName', () => {
  it('is the same for the same recipe and roots, and new when either changes', () => {
    const recipe = parseRecipe(null);
    expect(templateName(recipe, '')).toMatch(/^sdlc-[0-9a-f]{12}$/);
    expect(templateName(recipe, '')).toBe(templateName(parseRecipe(null), ''));
    expect(templateName({ ...recipe, provision: 'echo x' }, '')).not.toBe(templateName(recipe, ''));
    expect(templateName(recipe, 'ROOT')).not.toBe(templateName(recipe, ''));
  });
});

const t = needs('a command in the workspace VM', 'limactl');
const pluginDir = realpathSync(pluginPath);

describe.skipIf(t.skip)(t.name, () => {
  let ws: Workspace & { name: string };
  let work: string;
  let stateDir: string;
  const cwdFile = join(realpathSync(tmpdir()), `sdlc-test-cwd-${process.pid}`);

  /** Runs `command` through the verifier's shell as Claude Code's Bash tool does, from `cwd`. */
  const run = (command: string, cwd = work) => {
    const script = `shopt -u extglob 2>/dev/null || true && eval ${q(command)} < /dev/null && pwd -P >| ${q(cwdFile)}`;
    const r = spawnSync('bash', ['-c', `${q(ws.shell)} ${q(script)}`], { cwd, encoding: 'utf8', timeout: 120_000 });
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
    writeFileSync(join(work, 'app.txt'), 'exported\n');
    mkdirSync(join(work, 'sub'));
    const template = ensureTemplate({ recipe: parseRecipe(null), log: () => {} });
    ws = await openWorkspace({ template, work, stateDir, pluginDir, runnerDir, caches: [], env: { TERM: 'dumb', GIVEN: 'placeholder' } });
  }, 3_600_000);

  afterAll(async () => {
    await ws?.close();
    for (const d of [work, stateDir, cwdFile]) if (d) rmSync(d, { recursive: true, force: true });
  }, 300_000);

  it('runs in the exported folder, keeps its exit status, and reports the folder it ended in', () => {
    const r = run('cat app.txt; cd sub');
    expect(r.status).toBe(0);
    expect(r.out).toBe('exported\n');
    expect(readFileSync(cwdFile, 'utf8').trim()).toBe(join(work, 'sub'));
    expect(run('exit 7').status).toBe(7);
  });

  it('logs every command with its workspace and exit status', () => {
    run('echo logged; exit 3');
    expect(logged().find((c) => c.command === 'echo logged; exit 3')).toMatchObject({ workspace: 'local-vm', exit: 3, cwd: work });
  });

  it("holds the export on its own disk: the host keeps only the run's .verify folder", () => {
    expect(spawnSync('ls', ['-A', work], { encoding: 'utf8' }).stdout.trim()).toBe('.verify');
    expect(run('ls -A').out.split('\n')).toEqual(expect.arrayContaining(['app.txt', 'sub', '.verify']));
  });

  it("has nothing of the owner's: no home, no session's transcripts, no source repo, no login", () => {
    // The home holds only the paths down to what the VM shares: the run folder and the plugin's folder.
    const shared = [...new Set(['.sdlc-verify', relative(homedir(), pluginDir).split('/')[0]!])].sort();
    const r = run(
      `ls -A ${q(homedir())}; test -e ${q(join(homedir(), '.claude/projects'))} && echo HAS-SESSIONS; test -e ${q(join(pluginDir, '../tests'))} && echo HAS-REPO; command -v gh az || true`,
    );
    expect(r.out.trim().split('\n').filter(Boolean).sort()).toEqual(shared);
  });

  it('holds only the environment it was given', () => {
    const env = run('env').out;
    expect(env).toMatch(/^GIVEN=placeholder$/m);
    expect(env).toMatch(/^NODE_EXTRA_CA_CERTS=\/etc\/ssl\/certs\/ca-certificates\.crt$/m);
    expect(env).not.toMatch(/^ANTHROPIC_/m);
  });

  it('keeps what a command started in the background running for the next', () => {
    expect(run('(sleep 600 &); echo started').out).toBe('started\n');
    expect(run('pgrep -c -x sleep').out.trim()).toBe('1');
  });

  it('lists the exported files a command changed', () => {
    run('echo changed > app.txt');
    expect(ws.changed()).toEqual(['app.txt']);
  });

  it('deletes the VM on close', async () => {
    const closed = await ws.close();
    expect(closed).toEqual({ stopped: [`VM ${ws.name}`], stillRunning: [] });
    expect(spawnSync('limactl', ['list', '--format', '{{.Name}}'], { encoding: 'utf8' }).stdout.split('\n')).not.toContain(ws.name);
  }, 300_000);
});
