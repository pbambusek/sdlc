import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Run } from '../src/archive.mts';
import { readJournal, timeline, withRuns } from '../src/history.mts';
import { buildComment, feedbackComment, launchComment, parkComment, readComments, reportComment, reviewComment } from '../src/ledger.mts';
import { emptyUsage } from '../src/usage.mts';

const t = (m: number) => new Date(Date.UTC(2026, 9, 7, 10, m)).toISOString();
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

const ledger = () =>
  readComments([
    { at: t(1), text: launchComment({ stage: 'build', attempt: 1, base: 'none', session: 's1' }, 'n') },
    { at: t(10), text: buildComment({ stage: 'build', at: t(1), attempt: 1, session: 's1' }, { outcome: 'built', branch: 'b', commit: A }) },
    { at: t(11), text: launchComment({ stage: 'verify', attempt: 1, sha: A, log: '/l' }, 'n') },
    { at: t(11), text: reviewComment(A, 'asked') },
    { at: t(20), text: reportComment(A, 'failed', '1 failed') },
    { at: t(21), text: launchComment({ stage: 'feedback', attempt: 1, sha: A, session: 'f1' }, 'n') },
    {
      at: t(25),
      text: feedbackComment({ stage: 'feedback', at: t(21), attempt: 1, sha: A, session: 'f1' }, { commit: A, outcome: 'fix', findings: [], blocked: [] }),
    },
    { at: t(26), text: launchComment({ stage: 'build', attempt: 2, base: A, session: 's2' }, 'n') },
    { at: t(30), text: buildComment({ stage: 'build', at: t(26), attempt: 2, session: 's2' }, { outcome: 'built', branch: 'b', commit: B }) },
    { at: t(31), text: launchComment({ stage: 'verify', attempt: 1, sha: B, log: '/l2' }, 'n') },
    { at: t(40), text: reportComment(B, 'blocked', 'could not check claim 2') },
    { at: t(41), text: parkComment('Verify could not check every claim.') },
    { at: t(50), text: launchComment({ stage: 'verify', attempt: 1, sha: B, log: '/l3' }, 'n') },
  ]);

test('a timeline lists every run with its outcome, across a park and an un-park', () => {
  const steps = timeline(ledger(), [t(45)], [{ stage: 'verify', label: 'verify launcher', state: 'running' }]);
  assert.deepEqual(
    steps.map((s) => `${s.label} ${s.outcome}`),
    ['B1 built', 'V failed', 'review requested', 'F fix', 'B2 built', 'V blocked', 'parked parked', 'unparked unparked', 'V running'],
  );
  assert.equal(steps.find((s) => s.kind === 'park')?.note, 'Verify could not check every claim.');
});

test('a run that has ended but is not recorded shows as ended, not running', () => {
  const steps = timeline(ledger(), [], []);
  assert.equal(steps.at(-1)?.outcome, 'ended');
});

test('runs pick up time and cost from the archive: builds by session, verify runs by commit in order', () => {
  const usage = { ...emptyUsage(), turns: 7, seconds: 120 };
  const run = (over: Partial<Run>): Run => ({ key: 'PROJ-1', stage: 'build', at: t(0), outcome: 'built', session: null, usage, ...over });
  const runs = [run({ session: 's1' }), run({ stage: 'verify', sha: A, outcome: 'failed', launcher: { code: 0, seconds: 600 } })];
  const steps = withRuns(timeline(ledger(), [], []), runs, {});
  assert.equal(steps[0]!.turns, 7);
  assert.equal(steps[0]!.seconds, 120);
  assert.equal(steps.find((s) => s.kind === 'verify')!.seconds, 600);
  assert.equal(steps.find((s) => s.label === 'B2')!.seconds, undefined);
});

const journal = [
  '2026-10-13T08:00:00.000Z [tick aaa111 launchd] start (pid 1)',
  '2026-10-13T08:00:01.000Z [tick aaa111 launchd] done in 1.0 s',
  '2026-10-13T08:00:01.000Z [tick aaa111 launchd] ISSUE  STATE   DETAIL',
  '2026-10-13T08:00:01.000Z [tick aaa111 launchd] PROJ-16  parked  remove the sdlc-parked label to continue',
  '2026-10-13T08:05:00.000Z [tick bbb222 launchd] start (pid 2)',
  '2026-10-13T08:05:01.000Z [tick bbb222 launchd] done in 1.0 s',
  '2026-10-13T08:10:00.000Z [tick ccc333 launchd] start (pid 3)',
  '2026-10-13T08:10:02.000Z [tick ccc333 launchd] PROJ-16: launch verify #1 of 49b82ab',
  '2026-10-13T08:10:03.000Z [tick ccc333 launchd] done in 3.0 s, 1 error(s)',
  '2026-10-13T08:10:03.000Z [tick ccc333 launchd] PROJ-16  verifying  launch verify #1 of 49b82ab',
  '2026-10-13T08:10:03.000Z [tick ccc333 launchd] ! PROJ-9: launch build #1: gh: HTTP 502',
  '2026-10-13T08:12:00.000Z [status ddd444 manual] last tick 2 min ago',
  '2026-10-13T08:30:00Z [verify PROJ-16 #1 49b82ab] launcher exited with code 0 after 1140 s; log: /x.log',
].join('\n');

test('the journal reads as actions, errors and launcher exits, with idle ticks folded', () => {
  const j = readJournal(journal, Date.parse('2026-10-13T09:00:00Z'));
  assert.deepEqual(
    j.items.map((x) => ('quiet' in x ? `quiet ${x.quiet}` : `${x.kind} ${x.key} ${x.text}`)),
    [
      'notice PROJ-16 launcher exited with code 0 after 1140 s',
      'error PROJ-9 launch build #1: gh: HTTP 502',
      'action PROJ-16 launch verify #1 of 49b82ab',
      'quiet 2',
    ],
  );
  assert.deepEqual([j.ticks24h, j.actions24h, j.errors24h], [3, 1, 1]);
});

test('a launcher that exits with an error is an error', () => {
  const j = readJournal(
    '2026-10-13T08:30:00Z [verify PROJ-16 #1 49b82ab] launcher exited with code 1 after 4 s; log: /x.log',
    Date.parse('2026-10-13T09:00:00Z'),
  );
  assert.equal(j.items[0] && !('quiet' in j.items[0]) && j.items[0].kind, 'error');
});
