import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseDeclaration } from '../../skills/sdlc/verify/scripts/credentials.mts';
import { applyInstructions, readInstructions } from '../../skills/sdlc/verify/scripts/instructions.mts';
import { makeRepo, VERIFY_MD } from './helpers.mts';

const declaring = (hosts: string[]) =>
  `${VERIFY_MD}\n## Credentials\n\n\`\`\`json\n${JSON.stringify({ vault: 'kv-test', credentials: [{ name: 'API_KEY', secret: 'api-key', hosts }] })}\n\`\`\`\n`;

test('reads the VERIFY.md files on the default branch, and names those the commit changes', () => {
  const { repo, head } = makeRepo({
    onDefault: { 'VERIFY.md': declaring(['api.example.com']), 'pkg/VERIFY.md': 'pkg on main\n', 'gone/VERIFY.md': 'only on main\n' },
    onFeature: { 'VERIFY.md': declaring(['api.example.com', 'evil.example.net']), 'pkg/VERIFY.md': 'pkg changed\n', 'new/VERIFY.md': 'only on feature\n', 'gone/VERIFY.md': null },
  });
  const instructions = readInstructions({ repo, target: head });
  assert.equal(instructions.remote, 'origin');
  assert.equal(instructions.branch, 'main');
  assert.deepEqual(instructions.changed, ['VERIFY.md', 'gone/VERIFY.md', 'new/VERIFY.md', 'pkg/VERIFY.md']);
  // The credential goes only to the default branch's hosts, whatever the commit declares.
  assert.deepEqual(parseDeclaration(instructions.files.get('VERIFY.md')!)!.credentials[0]!.hosts, ['api.example.com']);

  // The export gets the default branch's files in place of the commit's; one only the commit has is gone.
  const work = mkdtempSync(join(tmpdir(), 'verify-export-'));
  execFileSync('bash', ['-c', `git -C "$1" archive "$2" | tar -x -C "$3"`, '_', repo, head, work]);
  applyInstructions(work, instructions);
  assert.equal(readFileSync(join(work, 'pkg/VERIFY.md'), 'utf8'), 'pkg on main\n');
  assert.equal(readFileSync(join(work, 'gone/VERIFY.md'), 'utf8'), 'only on main\n');
  assert.equal(existsSync(join(work, 'new/VERIFY.md')), false);
  assert.match(readFileSync(join(work, 'VERIFY.md'), 'utf8'), /"hosts":\["api\.example\.com"\]/);
});

test('names nothing when the commit leaves VERIFY.md alone', () => {
  const { repo, head } = makeRepo({ onDefault: { 'VERIFY.md': VERIFY_MD } });
  assert.deepEqual(readInstructions({ repo, target: head }).changed, []);
});

test('fetches the default branch as it is on the remote, not as the checkout last saw it', () => {
  const { repo, remote, head } = makeRepo({ onDefault: { 'VERIFY.md': VERIFY_MD } });
  const other = mkdtempSync(join(tmpdir(), 'verify-other-'));
  execFileSync('git', ['clone', '-q', remote, other], { stdio: 'ignore' });
  writeFileSync(join(other, 'VERIFY.md'), 'moved on\n');
  execFileSync('git', ['-C', other, '-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-qam', 'move']);
  execFileSync('git', ['-C', other, 'push', '-q', 'origin', 'main']);
  assert.equal(readInstructions({ repo, target: head }).files.get('VERIFY.md'), 'moved on\n');
});

test('stops when the default branch has no VERIFY.md at its root', () => {
  const { repo, head } = makeRepo({ onDefault: {}, onFeature: { 'VERIFY.md': VERIFY_MD } });
  assert.throws(() => readInstructions({ repo, target: head }), /origin\/main has no VERIFY\.md at its root.*merge the project's VERIFY\.md to main first, in its own pull request/);
});

test('stops when the default branch cannot be read', () => {
  const { repo, head } = makeRepo({ onDefault: { 'VERIFY.md': VERIFY_MD } });
  execFileSync('git', ['-C', repo, 'remote', 'set-url', 'origin', join(repo, 'no-such-remote.git')]);
  assert.throws(() => readInstructions({ repo, target: head }), /the default branch of origin can't be read/);
});

test('stops when the repo has no remote', () => {
  const { repo, head } = makeRepo({ onDefault: { 'VERIFY.md': VERIFY_MD } });
  execFileSync('git', ['-C', repo, 'remote', 'remove', 'origin']);
  assert.throws(() => readInstructions({ repo, target: head }), /no remote/);
});
