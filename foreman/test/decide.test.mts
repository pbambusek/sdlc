import { expect, test } from 'vitest';
import { decide, settle } from '../src/decide.mts';
import type { BuildOutcome, FeedbackOutcome, Feature, Launch, Report, Round } from '../src/types.mts';

const limits = { maxBuilds: 3, maxInvalidVerifies: 2, maxFeedbackRuns: 2, roundTimeoutMinutes: 120 };
const repo = { path: '/r', github: 'o/r', verifyCopy: [], review: null };
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const t = (m: number) => new Date(Date.UTC(2026, 9, 7, 10, m)).toISOString();

const feature = (over: Partial<Feature> = {}): Feature => ({
  key: 'PROJ-1',
  summary: 's',
  url: 'u',
  parked: false,
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
  ...over,
});
const pr = (head: string) => ({ number: 7, url: 'pr', branch: 'PROJ-1-x', head, state: 'open' as const });
const build = (m: number, base = 'none', attempt = 1): Launch => ({ stage: 'build', at: t(m), attempt, base });
const verify = (m: number, sha: string, attempt = 1): Launch => ({ stage: 'verify', at: t(m), attempt, sha });
const report = (m: number, sha: string, result: Report['result'], run?: string): Report => ({ at: t(m), sha, result, run });
const fb = (m: number, sha: string, outcome: FeedbackOutcome['outcome'], file?: string, attempt = 1): FeedbackOutcome => ({
  at: t(m),
  attempt,
  sha,
  outcome,
  file,
});
const feedbackRun = (m: number, sha: string, attempt = 1): Launch => ({ stage: 'feedback', at: t(m), attempt, sha });
const done: Round = { state: 'done', pending: [] };
const asked = (m: number, commit: string): BuildOutcome => ({ at: t(m), attempt: 1, outcome: 'asked', branch: 'PROJ-1-x', commit });
const kinds = (f: Feature) => decide(f, limits).actions.map((a) => a.kind);
const state = (f: Feature) => decide(f, limits).state;

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

test('an ended build is recorded first; an asked one parks with it', () => {
  const launch = build(1);
  expect(kinds(feature({ launches: [launch], finished: { launch, result: null } }))).toStrictEqual(['record-build']);
  expect(kinds(feature({ launches: [launch], finished: { launch, result: { outcome: 'built', commit: A } } }))).toStrictEqual(['record-build']);
  expect(kinds(feature({ launches: [launch], finished: { launch, result: { outcome: 'asked', questions: [{ question: 'Which locale?' }] } } }))).toStrictEqual([
    'record-build',
    'park',
  ]);
});

test('a build that ends without a PR is retried once, then parked', () => {
  expect(kinds(feature({ launches: [build(1)] }))).toStrictEqual(['launch-build']);
  expect(kinds(feature({ launches: [build(1), build(2, 'none', 2)] }))).toStrictEqual(['park']);
});

test('a new PR head is verified', () => {
  expect(decide(feature({ pr: pr(A), launches: [build(1)] }), limits).actions).toStrictEqual([{ kind: 'launch-verify', attempt: 1, sha: A }]);
});

test('a finished verify run is reported before anything else', () => {
  const evidence = { sha: A, at: t(9), result: 'failed' as const, summary: '', dir: null, log: null };
  expect(kinds(feature({ pr: pr(A), launches: [build(1), verify(5, A)], evidence }))).toStrictEqual(['report']);
  expect(state(feature({ pr: pr(A), launches: [build(1), verify(5, A)] }))).toBe('verifying');
});

test('a verified head waits for its round, then feedback reads it with the verify run', () => {
  const verified = { pr: pr(A), launches: [build(1), verify(5, A)], reports: [report(9, A, 'failed', 'run-a')] };
  const waiting = feature({ ...verified, round: { state: 'waiting', pending: ['terraform-plan'] } });
  expect(state(waiting)).toBe('waiting for the round');
  expect(kinds(waiting)).toStrictEqual([]);
  expect(decide(feature({ ...verified, round: done }), limits).actions).toStrictEqual([{ kind: 'launch-feedback', attempt: 1, sha: A, run: 'run-a' }]);
  // Past the timeout, feedback runs anyway and lists what is still running as blocked.
  expect(kinds(feature({ ...verified, round: { state: 'timed-out', pending: ['e2e'] } }))).toStrictEqual(['launch-feedback']);
});

test('every valid verify result goes to feedback, not straight to a decision', () => {
  for (const result of ['passed', 'failed', 'blocked'] as const) {
    expect(kinds(feature({ pr: pr(A), launches: [build(1), verify(5, A)], reports: [report(9, A, result)], round: done }))).toStrictEqual(['launch-feedback']);
  }
});

test('an ended feedback run is recorded first', () => {
  const launch = feedbackRun(10, A);
  const f = feature({ pr: pr(A), launches: [build(1), verify(5, A), launch], reports: [report(9, A, 'passed')], finishedFeedback: { launch, result: null } });
  expect(kinds(f)).toStrictEqual(['record-feedback']);
});

test('feedback decides the round: clean is ready for review, blocked parks, fix starts a build with it', () => {
  const base = { pr: pr(A), launches: [build(1), verify(5, A), feedbackRun(10, A)], reports: [report(9, A, 'failed')], round: done };
  expect(state(feature({ ...base, feedbacks: [fb(12, A, 'clean')] }))).toBe('ready for review');
  expect(kinds(feature({ ...base, feedbacks: [fb(12, A, 'blocked')] }))).toStrictEqual(['park']);
  const fix = feature({ ...base, feedbacks: [fb(12, A, 'fix', 'feedback-aaaaaaa-1.json')] });
  expect(decide(fix, limits).actions).toStrictEqual([{ kind: 'launch-build', attempt: 2, base: A, branch: 'PROJ-1-x', feedback: 'feedback-aaaaaaa-1.json' }]);
  expect(kinds({ ...fix, launches: [...fix.launches, build(13, A, 2)] })).toStrictEqual(['park']);
});

test('a feedback run without output is retried once, then parked', () => {
  const base = { pr: pr(A), reports: [report(9, A, 'passed')], round: done };
  expect(kinds(feature({ ...base, launches: [build(1), verify(5, A), feedbackRun(10, A)], feedbacks: [fb(12, A, 'none')] }))).toStrictEqual([
    'launch-feedback',
  ]);
  const twice = feature({
    ...base,
    launches: [build(1), verify(5, A), feedbackRun(10, A), feedbackRun(13, A, 2)],
    feedbacks: [fb(12, A, 'none'), fb(15, A, 'none', undefined, 2)],
  });
  expect(kinds(twice)).toStrictEqual(['park']);
});

test('a configured review is requested once per head, with its first verify', () => {
  const reviewed = { path: '/r', github: 'o/r', verifyCopy: [], review: { label: 'review-me', check: 'code-review' } };
  const f = feature({ repo: reviewed, pr: pr(A), launches: [build(1)] });
  expect(kinds(f)).toStrictEqual(['launch-verify', 'request-review']);
  expect(kinds({ ...f, reviewRequests: [{ at: t(2), sha: A }] })).toStrictEqual(['launch-verify']);
  expect(kinds({ ...f, pr: pr(B), reviewRequests: [{ at: t(2), sha: A }] })).toStrictEqual(['launch-verify', 'request-review']);
});

test('builds stop at the limit', () => {
  const f = feature({
    pr: pr(B),
    launches: [build(1), verify(2, A), feedbackRun(3, A), build(4, A, 2), verify(5, B), feedbackRun(6, B), build(7, B, 3)],
    reports: [report(3, A, 'failed'), report(6, B, 'failed')],
    feedbacks: [fb(3, A, 'fix', 'f1'), fb(9, B, 'fix', 'f2')],
    round: done,
  });
  expect(decide(f, limits).actions[0]?.kind).toBe('park');
});

test('an un-park keeps the build number and the limit counting from the first build', () => {
  // Build 1 ran before the un-park at t(10); the epoch's own launches start after it.
  const f = feature({
    epoch: t(10),
    pr: pr(A),
    launches: [verify(11, A), feedbackRun(13, A)],
    reports: [report(12, A, 'failed')],
    feedbacks: [fb(14, A, 'fix', 'f1')],
    round: done,
  });
  const fix = { ...f, allLaunches: [build(1), verify(2, A), ...f.launches] };
  expect(decide(fix, limits).actions).toStrictEqual([{ kind: 'launch-build', attempt: 2, base: A, branch: 'PROJ-1-x', feedback: 'f1' }]);
  expect(kinds({ ...fix, allLaunches: [build(0), build(1, A, 2), build(2, A, 3), ...f.launches] })).toStrictEqual(['park']);
});

test('verify invalid retries once, then parks, before any round', () => {
  const base = { pr: pr(A), launches: [build(1), verify(5, A)] };
  expect(kinds(feature({ ...base, reports: [report(9, A, 'invalid')] }))).toStrictEqual(['launch-verify']);
  expect(
    kinds(feature({ pr: pr(A), launches: [build(1), verify(5, A), verify(10, A, 2)], reports: [report(9, A, 'invalid'), report(12, A, 'invalid')] })),
  ).toStrictEqual(['park']);
});

test('a round is done when every check has finished, and waits for the review check to appear', () => {
  const at = (m: number) => t(m);
  const finished = { checks: [{ name: 'test', done: true }], pendingStatuses: [] };
  expect(settle(finished, null, at(0), at(1), limits).state).toBe('done');
  expect(settle({ checks: [{ name: 'test', done: false }], pendingStatuses: ['ci/legacy'] }, null, at(0), at(1), limits)).toStrictEqual({
    state: 'waiting',
    pending: ['test', 'ci/legacy'],
  });
  expect(settle(finished, 'code-review', at(0), at(1), limits)).toStrictEqual({ state: 'waiting', pending: ['code-review (not started)'] });
  // A repo with no checks at all: done after the grace period.
  expect(settle({ checks: [], pendingStatuses: [] }, null, at(0), at(1), limits).state).toBe('waiting');
  expect(settle({ checks: [], pendingStatuses: [] }, null, at(0), at(6), limits).state).toBe('done');
  expect(
    settle({ checks: [{ name: 'plan', done: false }], pendingStatuses: [] }, null, t(0), new Date(Date.parse(t(0)) + 121 * 60_000).toISOString(), limits).state,
  ).toBe('timed-out');
});

test('after an answer, the build continues from the head it asked on instead of verifying it', () => {
  // Re-approval starts a new epoch: no launches count yet, the outcome stays.
  const f = feature({ pr: pr(A), outcomes: [asked(3, A)] });
  expect(decide(f, limits).actions).toStrictEqual([{ kind: 'launch-build', attempt: 1, base: A, branch: 'PROJ-1-x', feedback: null }]);
  expect(kinds({ ...f, launches: [build(10, A)] })).toStrictEqual(['park']);
  expect(kinds({ ...f, pr: pr(B) })).toStrictEqual(['launch-verify']);
});

test('parked, merged and closed features rest', () => {
  expect(kinds(feature({ parked: true }))).toStrictEqual([]);
  expect(state(feature({ pr: { ...pr(A), state: 'merged' } }))).toBe('merged');
  expect(state(feature({ pr: { ...pr(A), state: 'closed' } }))).toBe('pr closed');
});

test('an un-park numbers verify and feedback runs after every earlier one, while their limits count only this epoch', () => {
  // Before the un-park at t(10): one verify and two feedback runs on A, the second at the per-head limit.
  const before = [build(1), verify(2, A), feedbackRun(4, A), feedbackRun(5, A, 2)];
  const verifying = feature({ epoch: t(10), pr: pr(A), launches: [], allLaunches: before });
  expect(decide(verifying, limits).actions).toStrictEqual([{ kind: 'launch-verify', attempt: 2, sha: A }]);
  const reading = feature({
    epoch: t(10),
    pr: pr(A),
    launches: [verify(11, A, 2)],
    allLaunches: [...before, verify(11, A, 2)],
    reports: [report(12, A, 'failed', 'run-a')],
    round: done,
  });
  expect(decide(reading, limits).actions).toStrictEqual([{ kind: 'launch-feedback', attempt: 3, sha: A, run: 'run-a' }]);
});
