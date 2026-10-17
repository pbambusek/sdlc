import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseSince } from '../src/stats.mts';
import { cacheHit, cost, DEFAULT_PRICES, sessionUsage } from '../src/usage.mts';

const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0, oneHour = 0) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheWrite,
  cache_creation: { ephemeral_5m_input_tokens: cacheWrite - oneHour, ephemeral_1h_input_tokens: oneHour },
});
const assistant = (at: string, id: string, model: string, u: object, content: object[] = []) => ({
  type: 'assistant',
  timestamp: at,
  message: { id, model, usage: u, content },
});
const jsonl = (path: string, lines: object[]) => writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

test('a response counts once however many content blocks it was written as, with its subagents added', () => {
  const dir = mkdtempSync(join(tmpdir(), 'usage-'));
  const main = join(dir, 's1.jsonl');
  jsonl(main, [
    { type: 'user', timestamp: '2026-10-08T10:00:00.000Z', message: { content: 'go' } },
    assistant('2026-10-08T10:00:05.000Z', 'm1', 'claude-opus-5-5', usage(10, 1, 100, 50, 20), [{ type: 'thinking' }]),
    assistant('2026-10-08T10:00:06.000Z', 'm1', 'claude-opus-5-5', usage(10, 7, 100, 50, 20), [{ type: 'tool_use', id: 't1', name: 'Bash' }]),
    assistant('2026-10-08T10:01:00.000Z', 'm2', 'claude-opus-5-5', usage(5, 3), [{ type: 'tool_use', id: 't2', name: 'Read' }]),
    assistant('2026-10-08T10:01:01.000Z', 'x', '<synthetic>', usage(0, 0)),
    { type: 'user', timestamp: '2026-10-08T10:02:00.000Z', message: { content: 'done' } },
  ]);
  mkdirSync(join(dir, 's1', 'subagents'), { recursive: true });
  jsonl(join(dir, 's1', 'subagents', 'agent-a.jsonl'), [
    assistant('2026-10-08T10:00:30.000Z', 'a1', 'claude-haiku-5-5', usage(4, 2), [{ type: 'tool_use', id: 't3', name: 'Bash' }]),
  ]);
  writeFileSync(join(dir, 's1', 'subagents', 'agent-a.meta.json'), '{}');

  const u = sessionUsage(main);
  assert.equal(u.turns, 3);
  assert.equal(u.subagents, 1);
  assert.equal(u.seconds, 120);
  assert.deepEqual(u.tools, { Bash: 2, Read: 1 });
  assert.deepEqual(u.tokens, { input: 19, output: 12, cacheRead: 100, cacheWrite5m: 30, cacheWrite1h: 20 });
  assert.deepEqual(Object.keys(u.models).sort(), ['claude-haiku-5-5', 'claude-opus-5-5']);
  assert.equal(cacheHit(u.tokens), 100 / 169);
});

test('cost prices each model, matches dated variants, and names the models it cannot price', () => {
  const t = (input: number, output: number) => ({ input, output, cacheRead: 1e6, cacheWrite5m: 0, cacheWrite1h: 1e6 });
  const u = { models: { 'claude-opus-5-5[1m]': t(1e6, 1e6), 'claude-mystery-9': t(1e6, 0) } } as any;
  const c = cost(u, DEFAULT_PRICES);
  assert.equal(c.usd, 4 + 20 + 0.2 + 8);
  assert.deepEqual(c.unpriced, ['claude-mystery-9']);
});

test('--since takes a span or a date', () => {
  const now = Date.parse('2026-10-13T12:00:00.000Z');
  assert.equal(parseSince('7d', now), '2026-10-06T12:00:00.000Z');
  assert.equal(parseSince('2026-10-01', now), '2026-10-01T00:00:00.000Z');
  assert.throws(() => parseSince('last week', now));
});
