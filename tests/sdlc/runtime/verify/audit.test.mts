import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { audit, snapshot } from '../../../../plugins/sdlc/runtime/verify/audit.mts';
import { temp } from './helpers.mts';

const home = homedir();
type Call = { name: string; input: Record<string, unknown>; refused?: boolean };

/** A session transcript holding these tool calls, one assistant line each, with a result for each refused one. */
const transcript = (calls: Call[]) => {
  const dir = temp();
  const lines = calls.flatMap((c, i) => [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `t${i}`, name: c.name, input: c.input }] } }),
    ...(c.refused ? [JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `t${i}`, is_error: true }] } })] : []),
  ]);
  const file = join(dir, 'session.jsonl');
  writeFileSync(file, [...lines, 'not json'].join('\n'));
  return file;
};

const run = (calls: Call[], { work = temp(), repos = ['/src/project'], allowed = ['/plugin/skills/verify'] } = {}) =>
  audit({ transcript: transcript(calls), work, repos, allowed, before: snapshot(work) });

describe('audit', () => {
  it('is not run, and not clean, without a transcript', () => {
    const work = temp();
    const result = audit({ transcript: null, work, repos: [], allowed: [], before: snapshot(work) });
    expect(result).toMatchObject({ clean: false, findings: [] });
    expect(result.verdict).toBe('Audit: not run, the session transcript was not found. Treat this run as invalid.');
  });

  it('is clean when every call stays on the system', () => {
    const work = temp();
    const result = run(
      [
        { name: 'Bash', input: { command: 'npm test' } },
        { name: 'Read', input: { file_path: join(work, 'src/index.ts') } },
        { name: 'Bash', input: { command: `ls ${home}/.npm/_cacache` } },
        { name: 'Read', input: { file_path: '/plugin/skills/verify/assets/example/evidence.json' } },
      ],
      { work },
    );
    expect(result.verdict).toBe('Audit: clean, none of 4 tool calls reached for how the code was written.');
    expect(result.clean).toBe(true);
  });

  it.each([
    [{ name: 'Bash', input: { command: 'git log -5' } }, 'reads git history'],
    [{ name: 'Bash', input: { command: 'git diff HEAD~1' } }, 'reads git history'],
    [{ name: 'Bash', input: { command: 'gh pr view 12' } }, 'reads a PR, issue or run'],
    [{ name: 'Bash', input: { command: 'acli jira workitem view ABC-1' } }, 'reads the tracker'],
    [{ name: 'Bash', input: { command: 'curl https://github.com/org/repo/pull/1' } }, 'opens GitHub or Atlassian'],
    [{ name: 'mcp__tracker__get_issue', input: { id: 1 } }, 'uses a connector'],
    [{ name: 'Read', input: { file_path: '/src/project/src/index.ts' } }, 'names the source repo'],
    [{ name: 'Bash', input: { command: 'cat ~/.claude/projects/x/session.jsonl' } }, `names ${home}/.claude/projects/x/session.jsonl`],
    [{ name: 'Bash', input: { command: 'cat ../other/notes.md' } }, 'a `..` path that can leave the run folder'],
  ] as const)('flags %j: %s', (call, why) => {
    const result = run([{ name: 'Bash', input: { command: 'npm start' } }, call as Call]);
    expect(result.clean).toBe(false);
    expect(result.findings).toEqual([{ tool: call.name, input: JSON.stringify(call.input), why }]);
    expect(result.verdict).toBe(`Audit: VIOLATED, 1 of 2 tool calls reached for how the code was written (${call.name}: ${why}). Treat this run as invalid.`);
  });

  it('ignores a file tool call that was refused, since it read nothing', () => {
    expect(run([{ name: 'Read', input: { file_path: '/src/project/src/index.ts' }, refused: true }]).clean).toBe(true);
  });

  it('still flags a refused shell call', () => {
    expect(run([{ name: 'Bash', input: { command: 'git log' }, refused: true }]).findings).toHaveLength(1);
  });

  it('lists the exported files the session changed, without counting them against the run', () => {
    const work = temp();
    mkdirSync(join(work, 'src'));
    writeFileSync(join(work, 'src/a.ts'), 'a');
    writeFileSync(join(work, 'package-lock.json'), '{}');
    const before = snapshot(work);
    writeFileSync(join(work, 'package-lock.json'), '{"changed":true}');
    const result = audit({ transcript: transcript([]), work, repos: [], allowed: [], before });
    expect(result.changed).toEqual(['package-lock.json']);
    expect(result.clean).toBe(true);
  });
});
