import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseScript, refusals, splitAnd, words } from '../../skills/sdlc/verify/scripts/workspace-shell.mts';

// The shape Claude Code's Bash tool hands its shell prefix: its own setup, then the command, then the folder it ended in.
const q = (s: string) => `'${s.replaceAll("'", `'"'"'`)}'`;
const claudeScript = (command: string, cwdFile = '/tmp/claude-1-cwd') =>
  `source /Users/me/.claude/shell-snapshots/snapshot-bash-1.sh 2>/dev/null || true && shopt -u extglob 2>/dev/null || true && eval ${q(command)} < /dev/null && pwd -P >| ${q(cwdFile)}`;

test('takes the command and the folder file out of a Claude Code script', () => {
  const parsed = parseScript(claudeScript('echo hi && cd sub'));
  assert.deepEqual(parsed, { evalArgs: `${q('echo hi && cd sub')} < /dev/null`, command: 'echo hi && cd sub', cwdFile: '/tmp/claude-1-cwd' });
});

test('keeps quotes, && and eval inside the command where they belong', () => {
  const command = `grep -c "a && eval b" file.txt; echo 'it'"'"'s'`;
  assert.equal(parseScript(claudeScript(command))?.command, command);
});

test('refuses a script of another shape', () => {
  assert.equal(parseScript('echo hi'), null);
  assert.equal(parseScript(`eval ${q('echo hi')}`), null);
  assert.equal(parseScript(`eval 'unbalanced && pwd -P >| /tmp/x`), null);
});

test('splits only at top-level &&', () => {
  assert.deepEqual(splitAnd(`a && "b && c" && 'd && e' && f\\&\\&g`), ['a', '"b && c"', "'d && e'", 'f\\&\\&g']);
});

test('unquotes shell words', () => {
  assert.deepEqual(words(`'a b' "c \\"d\\"" e\\ f < /dev/null`), ['a b', 'c "d"', 'e f']);
});

test('finds refused paths outside the run folder in output', () => {
  const output = [
    'cat: /Users/me/.ssh/id_ed25519: Operation not permitted',
    'bash: /home/me/.gitconfig: Permission denied',
    'cat: /work/run/own.txt: Permission denied',
    'Error: EACCES: permission denied, open \'/etc/shadow\'',
    'fine: /usr/bin/env',
  ].join('\n');
  assert.deepEqual(
    refusals(output, '/work/run').map((r) => r.path),
    ['/Users/me/.ssh/id_ed25519', '/home/me/.gitconfig', '/etc/shadow'],
  );
});
