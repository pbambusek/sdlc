import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDeclaration } from '../../src/verify/credentials.mts';
import { applyInstructions, readInstructions } from '../../src/verify/instructions.mts';
import { declaring, repoWithRemote, temp, VERIFY_MD } from './helpers.mts';

describe('readInstructions', () => {
  it('reads the VERIFY.md files on the default branch, and names those the commit changes', () => {
    const { repo, head } = repoWithRemote({
      onDefault: { 'VERIFY.md': declaring(['api.example.com']), 'pkg/VERIFY.md': 'pkg on main\n', 'gone/VERIFY.md': 'only on main\n' },
      onFeature: {
        'VERIFY.md': declaring(['api.example.com', 'other.example.net']),
        'pkg/VERIFY.md': 'pkg changed\n',
        'new/VERIFY.md': 'only on feature\n',
        'gone/VERIFY.md': null,
      },
    });
    const instructions = readInstructions({ repo, target: head });
    expect(instructions).toMatchObject({ remote: 'origin', branch: 'main', changed: ['VERIFY.md', 'gone/VERIFY.md', 'new/VERIFY.md', 'pkg/VERIFY.md'] });
    // The credential goes only to the default branch's hosts, whatever the commit declares.
    expect(parseDeclaration(instructions.files.get('VERIFY.md')!)!.credentials[0]!.hosts).toEqual(['api.example.com']);

    // The export gets the default branch's files in place of the commit's; one only the commit has is gone.
    const work = temp('sdlc-export-');
    execFileSync('bash', ['-c', `git -C "$1" archive "$2" | tar -x -C "$3"`, '_', repo, head, work]);
    applyInstructions(work, instructions);
    expect(readFileSync(join(work, 'pkg/VERIFY.md'), 'utf8')).toBe('pkg on main\n');
    expect(readFileSync(join(work, 'gone/VERIFY.md'), 'utf8')).toBe('only on main\n');
    expect(existsSync(join(work, 'new/VERIFY.md'))).toBe(false);
    expect(readFileSync(join(work, 'VERIFY.md'), 'utf8')).toContain('"hosts":["api.example.com"]');
  });

  it('names nothing when the commit leaves VERIFY.md alone', () => {
    const { repo, head } = repoWithRemote({ onDefault: { 'VERIFY.md': VERIFY_MD } });
    expect(readInstructions({ repo, target: head }).changed).toEqual([]);
  });

  it('fetches the default branch as it is on the remote, not as the checkout last saw it', () => {
    const { repo, remote, head } = repoWithRemote({ onDefault: { 'VERIFY.md': VERIFY_MD } });
    const other = temp('sdlc-other-');
    execFileSync('git', ['clone', '-q', remote, other], { stdio: 'ignore' });
    writeFileSync(join(other, 'VERIFY.md'), 'moved on\n');
    execFileSync('git', ['-C', other, '-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-qam', 'move']);
    execFileSync('git', ['-C', other, 'push', '-q', 'origin', 'main']);
    expect(readInstructions({ repo, target: head }).files.get('VERIFY.md')).toBe('moved on\n');
  });

  it('stops when the default branch has no VERIFY.md at its root', () => {
    const { repo, head } = repoWithRemote({ onDefault: {}, onFeature: { 'VERIFY.md': VERIFY_MD } });
    expect(() => readInstructions({ repo, target: head })).toThrow(
      /origin\/main has no VERIFY\.md at its root.*merge the project's VERIFY\.md to main first, in its own pull request/,
    );
  });

  it('stops when the default branch cannot be read', () => {
    const { repo, head } = repoWithRemote({ onDefault: { 'VERIFY.md': VERIFY_MD } });
    execFileSync('git', ['-C', repo, 'remote', 'set-url', 'origin', join(repo, 'no-such-remote.git')]);
    expect(() => readInstructions({ repo, target: head })).toThrow("the default branch of origin can't be read");
  });

  it('stops when the repo has no remote', () => {
    const { repo, head } = repoWithRemote({ onDefault: { 'VERIFY.md': VERIFY_MD } });
    execFileSync('git', ['-C', repo, 'remote', 'remove', 'origin']);
    expect(() => readInstructions({ repo, target: head })).toThrow('no remote');
  });
});
