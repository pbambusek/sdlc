/**
 * A run executes the commit's own code, so it doesn't also take its instructions from that commit: a change could send a
 * credential to a new host or loosen a baseline. A run follows the project's VERIFY.md files as they are on the remote's
 * default branch at launch. A change to them goes to the default branch in its own pull request first.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export interface Instructions {
  remote: string;
  branch: string;
  /** The default branch's head when the launcher read it. */
  commit: string;
  /** Each VERIFY.md on the default branch, by path, with its content. */
  files: Map<string, string>;
  /** Each VERIFY.md the target commit adds, removes or changes against the default branch. */
  changed: string[];
}

const git = (repo: string, args: string[], timeout = 120_000) =>
  // Nothing may wait on a person: no credential prompt, no SSH passphrase prompt.
  execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    maxBuffer: 1 << 28,
    timeout,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes' },
  });
const why = (e: unknown) => ((e as { stderr?: string }).stderr || (e as Error).message || '').trim().split('\n').filter(Boolean).at(-1)?.slice(0, 300) ?? 'unknown error';

/** Each VERIFY.md in a commit, by path, with its blob id. */
const verifyFiles = (repo: string, commit: string) =>
  new Map(
    git(repo, ['ls-tree', '-r', '-z', commit])
      .split('\0')
      .filter(Boolean)
      .map((line) => line.match(/^\d+ blob ([0-9a-f]+)\t(.+)$/s))
      .filter((m): m is RegExpMatchArray => m !== null && basename(m[2]!) === 'VERIFY.md')
      .map((m) => [m[2]!, m[1]!]),
  );

/**
 * Reads the VERIFY.md files on the remote's default branch, fetching it first, and compares them with `target`'s.
 * Throws, with what to tell the owner, when the branch can't be read or holds no VERIFY.md at its root.
 */
export const readInstructions = ({ repo, target }: { repo: string; target: string }): Instructions => {
  const remotes = git(repo, ['remote']).split('\n').filter(Boolean);
  const remote = remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0]! : null;
  if (!remote) throw new Error(`the repo has ${remotes.length ? 'several remotes and none is origin' : 'no remote'}, so its default branch can't be read`);

  let head: string;
  try {
    head = git(repo, ['ls-remote', '--symref', remote, 'HEAD'], 60_000);
  } catch (e) {
    throw new Error(`the default branch of ${remote} can't be read: ${why(e)}`);
  }
  const branch = head.match(/^ref: refs\/heads\/(\S+)\tHEAD$/m)?.[1];
  const commit = head.match(/^([0-9a-f]{40,64})\tHEAD$/m)?.[1];
  if (!branch || !commit) throw new Error(`the default branch of ${remote} can't be read: ${remote} names no default branch`);
  try {
    git(repo, ['fetch', '--no-tags', '--quiet', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`]);
    git(repo, ['cat-file', '-e', `${commit}^{commit}`]);
  } catch (e) {
    throw new Error(`the default branch ${remote}/${branch} can't be read: ${why(e)}`);
  }

  const onDefault = verifyFiles(repo, commit);
  if (!onDefault.has('VERIFY.md')) {
    throw new Error(`${remote}/${branch} has no VERIFY.md at its root. A run follows the VERIFY.md files on the default branch: merge the project's VERIFY.md to ${branch} first, in its own pull request`);
  }
  const atTarget = verifyFiles(repo, target);
  const changed = [...new Set([...onDefault.keys(), ...atTarget.keys()])].filter((p) => onDefault.get(p) !== atTarget.get(p)).sort();
  const files = new Map([...onDefault].map(([path, blob]) => [path, git(repo, ['cat-file', 'blob', blob])]));
  return { remote, branch, commit, files, changed };
};

/** Puts the default branch's VERIFY.md files in the exported commit, in place of its own; one only the commit has is removed. */
export const applyInstructions = (work: string, { files, changed }: Instructions) => {
  for (const path of changed) {
    const content = files.get(path);
    if (content === undefined) rmSync(join(work, path), { force: true });
    else {
      mkdirSync(dirname(join(work, path)), { recursive: true });
      writeFileSync(join(work, path), content);
    }
  }
};
