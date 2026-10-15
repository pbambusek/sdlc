import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { USAGE } from '../../../../plugins/sdlc/runtime/verify/args.mts';
import { runtimeDir, skillDir, temp } from './helpers.mts';

/** A new git repo with these committed files, plus a gitignored `.env`. */
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
const launch = (cwd: string, ...args: string[]) =>
  spawnSync(process.execPath, [join(runtimeDir, 'launch.mts'), ...args], { cwd, encoding: 'utf8', env: { ...process.env, VERIFY_NO_OPEN: '1' } });

const exports: string[] = [];
afterEach(() => {
  for (const dir of exports.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('launch', () => {
  it('prints the usage line and exits 1 without arguments', () => {
    const out = launch(repo({ 'README.md': 'x' }));
    expect(out.status).toBe(1);
    expect(out.stderr.trim()).toBe(USAGE);
  });

  it('refuses a commit without VERIFY.md', () => {
    const out = launch(repo({ 'spec.md': '1. It works.' }), 'spec.md');
    expect(out.status).toBe(1);
    expect(out.stderr).toContain('no VERIFY.md at the repo root at main');
  });

  it('refuses a spec that is not in the commit', () => {
    const out = launch(repo({ 'VERIFY.md': '# VERIFY\n' }), 'missing.md');
    expect(out.status).toBe(1);
    expect(out.stderr).toContain('missing.md does not exist at main');
  });

  it('refuses malformed credentials in VERIFY.md', () => {
    const out = launch(repo({ 'VERIFY.md': '## Credentials\n\n```json\n{"vault":"x","credentials":[]}\n```\n', 'spec.md': '1. x' }), 'spec.md');
    expect(out.status).toBe(1);
    expect(out.stderr).toContain('✖ VERIFY.md Credentials:');
  });

  it('exports the commit alone, copies what --copy names, and prints the folder', () => {
    const dir = repo({ 'VERIFY.md': '# VERIFY\n', 'app.js': 'console.log(1)\n' });
    const out = launch(dir, '--export-only', '--copy', '.env');
    expect(out.status).toBe(0);
    const work = out.stdout.match(/^exported (.+)$/m)?.[1];
    expect(work).toBeDefined();
    exports.push(work!);
    expect(readFileSync(join(work!, 'app.js'), 'utf8')).toBe('console.log(1)\n');
    expect(readFileSync(join(work!, '.env'), 'utf8')).toBe('LOCAL=1\n');
    expect(existsSync(join(work!, 'untracked.txt'))).toBe(false);
    expect(existsSync(join(work!, '.git'))).toBe(false);

    const commit = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    expect(JSON.parse(readFileSync(join(work!, '.verify/target.json'), 'utf8'))).toMatchObject({ ref: 'main', commit, source: 'none' });
    // The verifier may read the skill's folder and the runtime's, and is denied the source repo.
    const settings = JSON.parse(readFileSync(join(work!, '.verify/settings.json'), 'utf8'));
    expect(settings.permissions.additionalDirectories).toEqual([realpathSync(skillDir), realpathSync(runtimeDir)]);
    expect(settings.permissions.deny).toContain(`Read(/${realpathSync(dir)}/**)`);
    expect(existsSync(join(settings.permissions.additionalDirectories[0], 'run.md'))).toBe(true);
    expect(existsSync(join(settings.permissions.additionalDirectories[1], 'build-page.mts'))).toBe(true);
  });

  it('warns about and skips a --copy path that does not exist', () => {
    const out = launch(repo({ 'VERIFY.md': '# VERIFY\n' }), '--export-only', '--copy', 'nope.json');
    expect(out.status).toBe(0);
    exports.push(out.stdout.match(/^exported (.+)$/m)![1]!);
    expect(out.stderr).toContain('copy: nope.json is not in');
  });
});
