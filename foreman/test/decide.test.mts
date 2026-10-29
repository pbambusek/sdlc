import { expect, test } from 'vitest';
import { decide, settle } from '../src/decide.mts';
import type { BuildOutcome, Decided, FeedbackOutcome, Feature, Launch, Report, Round } from '../src/types.mts';

const limits = { roundTimeoutMinutes: 120 };
const repo = { path: '/r', github: 'o/r', verifyCopy: [], review: null };
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const t = (m: number) => new Date(Date.UTC(2026, 9, 7, 10, m)).toISOString();

const feature = (over: Partial<Feature> = {}): Feature => ({
  key: 'PROJ-1',
  summary: 's',
  url: 'u',
  approval: { ok: true, at: t(0), by: 'Ann' },
  epoch: t(0),
  repo,
  branch: null,
  pr: null,
  launches: [],
  allLaunches: over.launches ?? [],
  reports: [],
  notices: [],
  outcomes: [],
  running: [],
  finished: null,
  evidence: null,
  feedbacks: [],
  reviewRequests: [],
  finishedFeedback: null,
  round: null,
  decisions: [],
  retries: [],
  readies: [],
  replied: [],
  merge: null,
  ...over,
});
const pr = (head: string, state: 'open' | 'merged' | 'closed' = 'open') => ({ number: 7, url: 'pr', branch: 'PROJ-1-x', head, state });
const build = (m: number, base = 'none', attempt = 1): Launch => ({ stage: 'build', at: t(m), attempt, base });
const verify = (m: number, sha: string, attempt = 1): Launch => ({ stage: 'verify', at: t(m), attempt, sha });
const report = (m: number, sha: string, result: Report['result'], run?: string): Report => ({ at: t(m), sha, result, run });
const fb = (m: number, sha: string, outcome: FeedbackOutcome['outcome'] = 'read', attempt = 1): FeedbackOutcome => ({
  at: t(m),
  attempt,
  sha,
  outcome,
  file: `/f/${sha}`,
});
const built = (m: number, commit: string, attempt = 1): BuildOutcome => ({ at: t(m), attempt, outcome: 'built', branch: 'PROJ-1-x', commit });
const asked = (m: number, commit: string, attempt = 1): BuildOutcome => ({ at: t(m), attempt, outcome: 'asked', branch: 'PROJ-1-x', commit });
const none = (m: number, attempt = 1): BuildOutcome => ({ at: t(m), attempt, outcome: 'none' });
const decided = (m: number, sha: string, next: Decided['next'], over: Partial<Decided> = {}): Decided => ({
  at: t(m),
  gate: 'round',
  sha,
  next,
  commit: next === 'build',
  replies: 0,
  file: `/d/${sha}`,
  ...over,
});
const done: Round = { state: 'done', pending: [] };
const kinds = (f: Feature) => decide(f, limits).actions.map((a) => a.kind);
const state = (f: Feature) => decide(f, limits).state;

/** A head verified and read: its round's gate is open. */
const read = (over: Partial<Feature> = {}) =>
  feature({
    pr: pr(A),
    launches: [build(1), verify(3, A)],
    outcomes: [built(2, A)],
    reports: [report(4, A, 'passed', 'run-a')],
    feedbacks: [fb(6, A)],
    round: done,
    ...over,
  });

test('waits for approval, and says once why an approval does not count', () => {
  expect(state(feature({ approval: { ok: false, code: 'not-approved', reason: '', since: t(0) } }))).toBe('waiting for approval');
  const edited = feature({ approval: { ok: false, code: 'edited-after-approval', reason: 'edited', since: t(5) } });
  expect(kinds(edited)).toStrictEqual(['notice']);
  expect(kinds({ ...edited, notices: [{ at: t(6), code: 'edited-after-approval' }] })).toStrictEqual([]);
});

test('an approved feature with nothing built launches the first build', () => {
  expect(decide(feature(), limits).actions).toStrictEqual([{ kind: 'launch-build', attempt: 1, base: 'none', branch: null, feedback: null }]);
});

test('nothing is launched while a stage runs', () => {
  expect(state(feature({ running: [{ stage: 'build', label: 'x', state: 'blocked' }] }))).toBe('build waiting for input');
  expect(kinds(feature({ running: [{ stage: 'build', label: 'x', state: 'working' }] }))).toStrictEqual([]);
});

test('an ended build and an ended feedback run are recorded before anything else', () => {
  const launch = build(1);
  expect(kinds(feature({ launches: [launch], finished: { launch, result: null } }))).toStrictEqual(['record-build']);
  const f = { stage: 'feedback' as const, at: t(5), attempt: 1, sha: A };
  expect(kinds(read({ feedbacks: [], finishedFeedback: { launch: f, result: { commit: A, items: [] } } }))).toStrictEqual(['record-feedback']);
});

test('a build that ends without a PR runs again once, then stalls until a person retries it', () => {
  expect(kinds(feature({ launches: [build(1)], outcomes: [none(2)] }))).toStrictEqual(['launch-build']);
  const twice = feature({ launches: [build(1), build(3, 'none', 2)], allLaunches: [build(1), build(3, 'none', 2)], outcomes: [none(2), none(4, 2)] });
  expect(state(twice)).toBe('stalled');
  expect(kinds({ ...twice, retries: [{ at: t(5), stage: 'build' }] })).toStrictEqual(['launch-build']);
});

test('a build that asked stops at the question gate: nothing runs on what it pushed', () => {
  const f = feature({ pr: pr(A), launches: [build(1)], outcomes: [asked(2, A)] });
  expect(decide(f, limits)).toMatchObject({ state: 'questions', actions: [], gate: '/questions/PROJ-1/1' });
  const answered = { ...f, decisions: [decided(3, A, 'build', { gate: 'questions', build: 1, file: '/q' })] };
  expect(decide(answered, limits).actions).toStrictEqual([{ kind: 'launch-build', attempt: 2, base: A, branch: 'PROJ-1-x', feedback: '/q' }]);
  const respec = { ...f, decisions: [decided(3, A, 'respec', { gate: 'questions', build: 1 })] };
  expect(state(respec)).toBe('waiting for spec change');
});

test('a new head is verified and its review requested; an invalid run runs again once, then stalls', () => {
  const f = feature({ pr: pr(A), launches: [build(1)], outcomes: [built(2, A)], repo: { ...repo, review: { reviewer: 'r' } } });
  expect(kinds(f)).toStrictEqual(['launch-verify', 'request-review']);
  const once = read({ reports: [report(4, A, 'invalid')], feedbacks: [] });
  expect(kinds(once)).toStrictEqual(['launch-verify']);
  const twice = read({ launches: [build(1), verify(3, A), verify(5, A, 2)], reports: [report(4, A, 'invalid'), report(6, A, 'invalid')], feedbacks: [] });
  expect(state(twice)).toBe('stalled');
});

test('a verified head waits for its round, then feedback reads it with the verify run', () => {
  const f = read({ feedbacks: [], round: { state: 'waiting', pending: ['ci'] } });
  expect(state(f)).toBe('waiting for the round');
  expect(decide({ ...f, round: done }, limits).actions).toStrictEqual([{ kind: 'launch-feedback', attempt: 1, sha: A, run: 'run-a' }]);
});

test('a read round opens its gate, and nothing starts until a person decides it', () => {
  expect(decide(read(), limits)).toMatchObject({ state: 'gate open', actions: [], gate: `/round/PROJ-1/${A}` });
});

test('a decision to build launches one build with the decided document', () => {
  const f = read({ decisions: [decided(7, A, 'build')] });
  expect(decide(f, limits).actions).toStrictEqual([{ kind: 'launch-build', attempt: 2, base: A, branch: 'PROJ-1-x', feedback: `/d/${A}` }]);
});

test('a build after the decision that changed nothing stalls, unless replies were all it had to do', () => {
  const after = {
    launches: [build(1), verify(3, A), build(8, A, 2)],
    allLaunches: [build(1), verify(3, A), build(8, A, 2)],
    outcomes: [built(2, A), built(9, A, 2)],
  };
  expect(state(read({ ...after, decisions: [decided(7, A, 'build')] }))).toBe('stalled');
  const replies = read({ ...after, decisions: [decided(7, A, 'build', { commit: false })], merge: { ready: true, why: '', base: 'main' } });
  expect(state(replies)).toBe('ready to merge');
});

test('nothing to build is ready to merge only when GitHub would merge, and marks the head once', () => {
  const f = read({ decisions: [decided(7, A, 'done')] });
  expect(state({ ...f, merge: { ready: false, why: 'conflicts with main', base: 'main' } })).toBe('waiting to merge');
  const ready = { ...f, merge: { ready: true, why: 'can merge once approved', base: 'main' } };
  expect(decide(ready, limits).actions).toStrictEqual([{ kind: 'ready', sha: A }]);
  expect(kinds({ ...ready, readies: [A] })).toStrictEqual([]);
});

test('the review threads a decision answers with its words are answered first, once', () => {
  const f = read({ decisions: [decided(7, A, 'done', { replies: 2 })], merge: { ready: true, why: '', base: 'main' } });
  expect(decide(f, limits).actions).toStrictEqual([{ kind: 'post-replies', sha: A, file: `/d/${A}` }]);
  expect(kinds({ ...f, replied: [A] })).toStrictEqual(['ready']);
});

test('a change of claim waits for the spec; a new approval verifies the same head again', () => {
  expect(state(read({ decisions: [decided(7, A, 'respec')] }))).toBe('waiting for spec change');
  // The new approval starts a new epoch: nothing before it counts, so the head is verified against the revised spec.
  const approved = read({
    epoch: t(20),
    launches: [],
    reports: [],
    feedbacks: [],
    decisions: [],
    outcomes: [built(2, A)],
    allLaunches: [build(1), verify(3, A)],
  });
  expect(kinds(approved)).toStrictEqual(['launch-verify']);
});

test('a decision on an earlier head does not hold a new head', () => {
  expect(kinds(read({ pr: pr(B), decisions: [decided(7, A, 'build')] }))).toStrictEqual(['launch-verify']);
});

test('abandon closes the PR, then the issue rests', () => {
  expect(kinds(read({ decisions: [decided(7, A, 'abandon')] }))).toStrictEqual(['close-pr']);
  expect(state(read({ pr: pr(A, 'closed'), decisions: [decided(7, A, 'abandon')] }))).toBe('abandoned');
  expect(state(read({ pr: pr(A, 'merged') }))).toBe('merged');
});

test('a round settles once nothing is pending and the reviewer has reported', () => {
  const now = t(30);
  expect(settle({ checks: [{ name: 'ci', done: true }], pendingStatuses: [] }, null, t(0), now, limits)).toStrictEqual(done);
  expect(settle({ checks: [{ name: 'ci', done: true }], pendingStatuses: [] }, 'review', t(0), now, limits).state).toBe('waiting');
  expect(settle({ checks: [{ name: 'ci', done: false }], pendingStatuses: [] }, null, t(0), t(200), limits).state).toBe('timed-out');
});
