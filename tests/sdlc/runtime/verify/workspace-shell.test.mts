import { describe, expect, it } from 'vitest';
import { parseScript, refusals, splitAnd, words } from '../../../../plugins/sdlc/runtime/verify/workspace-shell.mts';

// The shape Claude Code's Bash tool hands its shell prefix: its own setup, then the command, then the folder it ended in.
const q = (s: string) => `'${s.replaceAll("'", `'"'"'`)}'`;
const claudeScript = (command: string, cwdFile = '/tmp/claude-1-cwd') =>
  `source /home/me/.claude/shell-snapshots/snapshot-bash-1.sh 2>/dev/null || true && shopt -u extglob 2>/dev/null || true && eval ${q(command)} < /dev/null && pwd -P >| ${q(cwdFile)}`;

describe('parseScript', () => {
  it('takes the command and the folder file out of a Claude Code script', () => {
    expect(parseScript(claudeScript('echo hi && cd sub'))).toEqual({
      evalArgs: `${q('echo hi && cd sub')} < /dev/null`,
      command: 'echo hi && cd sub',
      cwdFile: '/tmp/claude-1-cwd',
    });
  });

  it('keeps quotes, && and eval inside the command where they belong', () => {
    const command = `grep -c "a && eval b" file.txt; echo 'it'"'"'s'`;
    expect(parseScript(claudeScript(command))?.command).toBe(command);
  });

  it('refuses a script of another shape', () => {
    expect(parseScript('echo hi')).toBeNull();
    expect(parseScript(`eval ${q('echo hi')}`)).toBeNull();
    expect(parseScript(`eval 'unbalanced && pwd -P >| /tmp/x`)).toBeNull();
  });
});

describe('splitAnd', () => {
  it('splits only at top-level &&', () => {
    expect(splitAnd(`a && "b && c" && 'd && e' && f\\&\\&g`)).toEqual(['a', '"b && c"', "'d && e'", 'f\\&\\&g']);
  });
});

describe('words', () => {
  it('unquotes shell words', () => {
    expect(words(`'a b' "c \\"d\\"" e\\ f < /dev/null`)).toEqual(['a b', 'c "d"', 'e f']);
  });
});

describe('refusals', () => {
  it('finds refused paths outside the run folder in output', () => {
    const output = [
      'cat: /Users/me/.ssh/id_ed25519: Operation not permitted',
      'bash: /home/me/.gitconfig: Permission denied',
      'cat: /work/run/own.txt: Permission denied',
      "Error: EACCES: permission denied, open '/etc/shadow'",
      'fine: /usr/bin/env',
    ].join('\n');
    expect(refusals(output, '/work/run').map((r) => r.path)).toEqual(['/Users/me/.ssh/id_ed25519', '/home/me/.gitconfig', '/etc/shadow']);
  });
});
