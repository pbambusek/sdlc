import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const SKILL = realpathSync(join(import.meta.dirname, '../../skills/sdlc/verify'));
export const hasNono = spawnSync('nono', ['--version']).status === 0;
// CI installs nono, so a missing one there is a failure, not a skip.
export const needsNono = hasNono || process.env.CI ? false : 'nono is not installed';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export const VERIFY_MD = '# Verify: test project\n\n## Surface\n\nNothing to start.\n';

/**
 * A repo whose `origin` is a bare repo with `main` as its default branch, holding `onDefault`; the checkout is on a
 * `feature` branch one commit ahead, with `onFeature` written on top. A file set to null is removed.
 */
export const makeRepo = ({ onDefault, onFeature = {} }: { onDefault: Record<string, string>; onFeature?: Record<string, string | null> }) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'verify-test-')));
  const remote = join(root, 'remote.git');
  const repo = join(root, 'repo');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['clone', '-q', remote, repo], { stdio: 'ignore' });
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'checkout', '-q', '-b', 'main');
  const write = (files: Record<string, string | null>) => {
    for (const [path, content] of Object.entries(files)) {
      if (content === null) git(repo, 'rm', '-q', path);
      else {
        mkdirSync(dirname(join(repo, path)), { recursive: true });
        writeFileSync(join(repo, path), content);
        git(repo, 'add', path);
      }
    }
  };
  write({ 'README.md': 'test\n', '.gitignore': '.verify/\n', ...onDefault });
  git(repo, 'commit', '-q', '-m', 'default');
  git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'checkout', '-q', '-b', 'feature');
  write({ 'feature.txt': 'feature\n', ...onFeature });
  git(repo, 'commit', '-q', '-m', 'feature');
  return { root, remote, repo, head: git(repo, 'rev-parse', 'HEAD') };
};

/** A folder of executables, each a shell script, to put first on PATH. */
export const fakeBin = (scripts: Record<string, string>) => {
  const bin = realpathSync(mkdtempSync(join(tmpdir(), 'verify-bin-')));
  for (const [name, body] of Object.entries(scripts)) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  return bin;
};
