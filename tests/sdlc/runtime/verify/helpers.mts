import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach } from 'vitest';

export const runtimeDir = fileURLToPath(new URL('../../../../plugins/sdlc/runtime/verify/', import.meta.url));
export const skillDir = fileURLToPath(new URL('../../../../plugins/sdlc/skills/verify/', import.meta.url));

/** Whether a command is on PATH. */
export const has = (tool: string) => spawnSync('bash', ['-c', `command -v ${tool}`], { stdio: 'ignore' }).status === 0;

/**
 * A test name that says why it was skipped: `needs(name, 'nono')` gives the name and whether to skip, so a machine without
 * the tool reports the test as skipped with the tool named, never as passed.
 */
export const needs = (name: string, tool: string, available = has(tool)) => ({
  skip: !available,
  name: available ? name : `${name} (skipped: ${tool} is not available)`,
});

const temps: string[] = [];
/** A new empty folder, removed after the test. */
export const temp = (prefix = 'sdlc-test-') => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

export const VERIFY_MD = '# Verify: test project\n\n## Surface\n\nNothing to start.\n';

/** VERIFY.md declaring one credential for `hosts`. */
export const declaring = (hosts: string[]) =>
  `${VERIFY_MD}\n## Credentials\n\n\`\`\`json\n${JSON.stringify({ vault: 'example-vault', credentials: [{ name: 'API_KEY', secret: 'api-key', hosts }] })}\n\`\`\`\n`;

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/**
 * A repo whose `origin` is a bare repo with `main` as its default branch, holding `onDefault`; the checkout is on a
 * `feature` branch one commit ahead, with `onFeature` written on top. A file set to null is removed.
 */
export const repoWithRemote = ({ onDefault, onFeature = {} }: { onDefault: Record<string, string>; onFeature?: Record<string, string | null> }) => {
  const root = temp('sdlc-repo-');
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
  write({ 'README.md': 'test\n', '.gitignore': '.verify/\n.env\n', ...onDefault });
  git(repo, 'commit', '-q', '-m', 'default');
  git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'checkout', '-q', '-b', 'feature');
  write({ 'feature.txt': 'feature\n', ...onFeature });
  git(repo, 'commit', '-q', '-m', 'feature');
  return { root, remote, repo, head: git(repo, 'rev-parse', 'HEAD') };
};

/** A folder of executables, each a shell script, to put first on PATH. */
export const fakeBin = (scripts: Record<string, string>) => {
  const bin = temp('sdlc-bin-');
  for (const [name, body] of Object.entries(scripts)) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  return bin;
};
