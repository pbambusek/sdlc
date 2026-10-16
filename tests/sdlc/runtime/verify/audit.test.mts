import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { audit } from '../../../../plugins/sdlc/runtime/verify/audit.mts';
import { temp } from './helpers.mts';

type Call = { name: string; input: Record<string, unknown> };

/** A session transcript holding these tool calls, one assistant line each. */
const transcript = (calls: Call[]) => {
  const lines = calls.map((c, i) =>
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `t${i}`, name: c.name, input: c.input }] } }),
  );
  const file = join(temp(), 'session.jsonl');
  writeFileSync(file, [...lines, 'not json'].join('\n'));
  return file;
};

const run = (calls: Call[]) => audit({ transcript: transcript(calls), changed: [] });

describe('audit', () => {
  it('is not run, and not clean, without a transcript', () => {
    const result = audit({ transcript: null, changed: [] });
    expect(result).toMatchObject({ clean: false, findings: [] });
    expect(result.verdict).toBe('Audit: not run, the session transcript was not found. Treat this run as invalid.');
  });

  it('is clean when every call drives the system, whatever paths it names', () => {
    const result = run([
      { name: 'Bash', input: { command: 'cd /home/me/.sdlc-verify/r-1\necho started' } },
      { name: 'Bash', input: { command: 'cat ../other/notes.md; ls ~/.claude' } },
      { name: 'Read', input: { file_path: '/home/me/.sdlc-verify/r-1/.verify/shots/a.png' } },
    ]);
    expect(result.verdict).toBe('Audit: clean, none of 3 tool calls reached for how the code was written.');
    expect(result.clean).toBe(true);
  });

  it.each([
    [{ name: 'Bash', input: { command: 'git log -5' } }, 'reads git history'],
    [{ name: 'Bash', input: { command: 'cd app\ngit diff HEAD~1' } }, 'reads git history'],
    [{ name: 'Bash', input: { command: 'gh pr view 12' } }, 'reads a PR, issue or run'],
    [{ name: 'Bash', input: { command: 'acli jira workitem view ABC-1' } }, 'reads the tracker'],
    [{ name: 'Bash', input: { command: 'curl https://github.com/org/repo/pull/1' } }, 'opens GitHub or Atlassian'],
    [{ name: 'mcp__tracker__get_issue', input: { id: 1 } }, 'uses a connector'],
  ] as const)('flags %j: %s', (call, why) => {
    const result = run([{ name: 'Bash', input: { command: 'npm start' } }, call as Call]);
    expect(result.clean).toBe(false);
    expect(result.findings).toEqual([{ tool: call.name, input: JSON.stringify(call.input), why }]);
    expect(result.verdict).toBe(`Audit: VIOLATED, 1 of 2 tool calls reached for how the code was written (${call.name}: ${why}). Treat this run as invalid.`);
  });

  it('carries the changed files without counting them against the run', () => {
    const result = audit({ transcript: transcript([]), changed: ['package-lock.json'] });
    expect(result.changed).toEqual(['package-lock.json']);
    expect(result.clean).toBe(true);
  });
});
