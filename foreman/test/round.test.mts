import { expect, test } from 'vitest';
import { choicesFor, describeNext, isGood, needsCommit, nextOf, ordered, problemsFile, repliesOf, toDecision } from '../src/round.mts';

const thread = { item: 'thread:https://github.com/example/app/pull/7#discussion_r12', status: 'open' };

test('good items need no decision: shown claims, passing checks, approvals and comments, a clean audit and base', () => {
  const good = [
    { item: 'claim:C1', status: 'shown' },
    { item: 'check:test.yml / unit', status: 'success' },
    { item: 'check:scan', status: 'neutral' },
    { item: 'check:sdlc/verify', status: 'failure' },
    { item: 'review:1', status: 'approved' },
    { item: 'review:2', status: 'commented' },
    { item: 'audit', status: 'clean' },
    { item: 'base', status: 'clean' },
  ];
  expect(good.every(isGood)).toBe(true);
  const open = [
    { item: 'claim:C2', status: 'not-shown' },
    { item: 'probe:X1', status: 'blocked' },
    { item: 'check:plan.yml / plan', status: 'success', rule: 'Finding: a replace of a stateful resource.' },
    { item: 'check:lint.yml / rules', status: 'missing' },
    { item: 'review:3', status: 'changes-requested' },
    thread,
    { item: 'audit', status: 'flagged' },
    { item: 'base', status: 'behind' },
  ];
  expect(open.some(isGood)).toBe(false);
});

test('the page keeps the feedback file’s fixed order', () => {
  const names = ordered([
    { item: 'base' },
    thread,
    { item: 'check:b' },
    { item: 'audit' },
    { item: 'claim:C2' },
    { item: 'check:a' },
    { item: 'probe:X1' },
  ]).map((i) => i.item);
  expect(names).toStrictEqual(['claim:C2', 'probe:X1', thread.item, 'check:b', 'check:a', 'audit', 'base']);
});

test('every item offers fix, ignore it and follow up; claims also change the claim; questions take an answer', () => {
  expect(choicesFor({ item: 'check:a', status: 'failure' })).toStrictEqual(['fix', 'leave', 'follow-up']);
  expect(choicesFor({ item: 'claim:C2', status: 'not-shown' })).toStrictEqual(['fix', 'leave', 'follow-up', 'change-claim']);
  expect(choicesFor({ item: 'probe:X1', status: 'not-shown' })).toStrictEqual(['fix', 'leave', 'follow-up']);
  expect(choicesFor({ item: 'question:Q1', status: 'open', about: ['claim:C4'] })).toStrictEqual(['answer', 'change-claim']);
  expect(choicesFor({ item: 'question:Q2', status: 'open', about: ['src/db.mjs'] })).toStrictEqual(['answer']);
});

test('a choice becomes the decision the build reads', () => {
  expect(toDecision({ item: 'check:a', status: 'failure' }, 'fix', '')).toStrictEqual({ do: 'fix' });
  expect(toDecision({ item: 'base', status: 'behind' }, 'fix', ' ')).toStrictEqual({ do: 'merge' });
  expect(toDecision(thread, 'leave', 'The name matches the API.')).toStrictEqual({ do: 'reply', hint: 'The name matches the API.' });
  expect(toDecision(thread, 'leave', '')).toStrictEqual({ do: 'reply' });
  expect(toDecision({ item: 'check:a', status: 'failure' }, 'leave', '')).toStrictEqual({ do: 'leave' });
  expect(toDecision({ item: 'question:Q1', status: 'open', recommended: 'Use C4' }, 'answer', '')).toStrictEqual({ do: 'answer', hint: 'Use C4' });
});

test('what a gate makes foreman do next', () => {
  const on = (item: string, d: object) => ({ item, ...d }) as never;
  expect(nextOf([on('check:a', { do: 'leave' }), on('claim:C1', { do: 'follow-up' })], false)).toBe('done');
  // Foreman answers an ignored or followed-up review thread itself: no build for it.
  expect(nextOf([on(thread.item, { do: 'follow-up' }), on(thread.item, { do: 'reply' })], false)).toBe('done');
  expect(repliesOf([on(thread.item, { do: 'reply' }), on('check:a', { do: 'leave' }), on(thread.item, { do: 'fix' })])).toStrictEqual([
    { item: thread.item, body: 'Leaving this as it is.' },
  ]);
  expect(nextOf([on('check:a', { do: 'fix' }), on('check:b', { do: 'leave' })], false)).toBe('build');
  expect(nextOf([on('check:a', { do: 'fix' }), on('claim:C1', { do: 'change-claim' })], false)).toBe('respec');
  expect(nextOf([on('check:a', { do: 'fix' })], true)).toBe('abandon');
  expect(needsCommit([{ do: 'reply', hint: 'x' }])).toBe(false);
  expect(needsCommit([{ do: 'reply', hint: 'x' }, { do: 'merge' }])).toBe(true);
  expect(describeNext('build', [on('check:a', { do: 'fix' }), on(thread.item, { do: 'reply', hint: 'x' })], { pr: 7, nextBuild: 3 })).toBe(
    'Foreman replies in 1 review thread. Build #3 fixes 1.',
  );
});

test('the problems for a spec revision are the items decided change the claim, with their words', () => {
  const text = problemsFile('PROJ-1', [
    { item: 'claim:C6', status: 'not-shown', reason: 'a withdrawn vote is given back', decision: { do: 'change-claim', hint: 'votes cast, not held' } },
    { item: 'check:a', status: 'failure', decision: { do: 'fix' } },
  ]);
  expect(text).toContain('## claim:C6');
  expect(text).toContain('- hint: votes cast, not held');
  expect(text).not.toContain('check:a');
});
