import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adfToMarkdown, textToAdf } from '../src/adf.mts';
import { classify } from '../src/evidence.mts';
import { buildComment, feedbackComment, launchComment, readApproval, readComments, reportComment, reviewComment, type ChangelogEntry } from '../src/ledger.mts';

const t = (m: number) => new Date(Date.UTC(2026, 9, 7, 10, m)).toISOString();
const labels = (at: string, accountId: string, from: string, to: string): ChangelogEntry => ({
  at,
  accountId,
  who: accountId,
  items: [{ field: 'labels', fromString: from, toString: to }],
});
const edit = (at: string): ChangelogEntry => ({ at, accountId: 'x', who: 'Bob', items: [{ field: 'description', fromString: null, toString: null }] });

test('an approval counts only from an approver, and only until the description changes', () => {
  const approved = labels(t(1), 'ann', 'sdlc', 'sdlc sdlc-approved');
  assert.equal(readApproval(['sdlc', 'sdlc-approved'], [approved], ['ann'], t(0)).approval.ok, true);
  assert.equal(readApproval(['sdlc', 'sdlc-approved'], [approved], ['someone-else'], t(0)).approval.ok, false);
  const r = readApproval(['sdlc', 'sdlc-approved'], [approved, edit(t(2))], ['ann'], t(0));
  assert.equal(r.approval.ok === false && r.approval.code, 'edited-after-approval');
  // Re-approving after the edit makes it count again.
  assert.equal(
    readApproval(['sdlc', 'sdlc-approved'], [approved, edit(t(2)), labels(t(3), 'ann', 'sdlc', 'sdlc sdlc-approved')], ['ann'], t(0)).approval.ok,
    true,
  );
});

test('un-parking starts a new epoch', () => {
  const log = [labels(t(1), 'ann', 'sdlc', 'sdlc sdlc-approved'), labels(t(5), 'ann', 'sdlc sdlc-approved sdlc-parked', 'sdlc sdlc-approved')];
  assert.equal(readApproval(['sdlc', 'sdlc-approved'], log, ['ann'], t(0)).epoch, t(5));
});

test('tick comments round-trip through Jira', () => {
  const sha = 'c'.repeat(40);
  const comments = [
    { at: t(1), text: adfToMarkdown(textToAdf(launchComment({ stage: 'build', attempt: 1, base: 'none', session: 'abc' }, 'note'))) },
    { at: t(2), text: adfToMarkdown(textToAdf(reportComment(sha, 'failed', '1 shown'))) },
    { at: t(3), text: 'a person writing [sdlc] launched stage=build in the middle' },
  ];
  const r = readComments(comments);
  assert.deepEqual(r.launches, [
    { stage: 'build', at: t(1), attempt: 1, base: 'none', sha: undefined, session: 'abc', log: undefined, work: undefined, result: undefined },
  ]);
  assert.deepEqual(r.reports, [{ at: t(2), sha, result: 'failed', evidence: undefined, page: undefined, run: undefined }]);
});

test('numbered claims survive the ADF conversion', () => {
  const doc = {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Claims' }] },
      {
        type: 'orderedList',
        attrs: { order: 1 },
        content: [
          {
            type: 'listItem',
            content: [
              {
                type: 'paragraph',
                content: [
                  { type: 'text', text: 'A user sees ' },
                  { type: 'text', text: 'Save', marks: [{ type: 'code' }] },
                ],
              },
            ],
          },
          {
            type: 'listItem',
            content: [
              { type: 'paragraph', content: [{ type: 'text', text: 'An error is shown.' }] },
              { type: 'paragraph', content: [{ type: 'text', text: 'Calibration: a toast counts.' }] },
            ],
          },
        ],
      },
    ],
  };
  assert.equal(adfToMarkdown(doc), '## Claims\n\n1. A user sees `Save`\n2. An error is shown.\n\n   Calibration: a toast counts.');
});

test('a verify run is passed only when the audit is clean and every claim is shown', () => {
  const ev = (...statuses: string[]) => ({
    claims: statuses.map((s, i) => ({ id: `C${i + 1}`, items: [{ status: s, reason: s === 'shown' ? undefined : 'why' }] })),
  });
  const clean = { clean: true, verdict: 'clean' };
  assert.equal(classify(ev('shown', 'shown'), clean).result, 'passed');
  assert.equal(classify(ev('shown', 'not-shown'), clean).result, 'failed');
  assert.equal(classify(ev('not-shown', 'blocked'), clean).result, 'blocked');
  assert.equal(classify(ev('shown'), { clean: false, verdict: 'reached git history' }).result, 'invalid');
  assert.equal(classify(null, clean).result, 'invalid');
});

test('a comment body is a valid ADF document', () => {
  const doc = textToAdf('[sdlc] parked\n\nWhy');
  assert.equal(doc.version, 1);
  assert.equal(doc.type, 'doc');
  assert.equal('attrs' in doc, false);
  // No empty text nodes: Jira rejects them.
  assert.deepEqual(doc.content?.[1], { type: 'paragraph', content: [] });
});

test('a report comment carries the attachment ids of the full report', () => {
  const sha = 'd'.repeat(40);
  const text = adfToMarkdown(textToAdf(reportComment(sha, 'failed', '1 not shown', { evidence: '10001', page: '10002' })));
  assert.deepEqual(readComments([{ at: t(1), text }]).reports, [{ at: t(1), sha, result: 'failed', evidence: '10001', page: '10002', run: undefined }]);
});

test('a build result round-trips, with its questions for people below the fields', () => {
  const launch = { stage: 'build' as const, at: t(0), attempt: 2, session: 's1', work: '/w/PROJ-1-2', result: '/r/build.json' };
  const sha = 'e'.repeat(40);
  const built = buildComment(launch, { outcome: 'built', branch: 'PROJ-1-x', commit: sha, review: 'https://github.com/o/r/pull/7' });
  const askedText = buildComment(launch, {
    outcome: 'asked',
    branch: 'PROJ-1-x',
    commit: null,
    questions: [{ about: ['C4'], question: 'Which locale?', recommended: 'en' }],
  });
  assert.match(askedText, /\(C4\) Which locale\?\n   Recommended: en/);
  const r = readComments([
    { at: t(1), text: adfToMarkdown(textToAdf(built)) },
    { at: t(2), text: adfToMarkdown(textToAdf(askedText)) },
    { at: t(3), text: adfToMarkdown(textToAdf(buildComment(launch, null))) },
    { at: t(4), text: '[sdlc] build-result attempt=1 outcome=built review=[https://x/pull/1](https://x/pull/1)' },
  ]);
  assert.deepEqual(
    r.outcomes.map((o) => [o.outcome, o.branch, o.commit, o.review]),
    [
      ['built', 'PROJ-1-x', sha, 'https://github.com/o/r/pull/7'],
      ['asked', 'PROJ-1-x', undefined, undefined],
      ['none', undefined, undefined, undefined],
      ['built', undefined, undefined, 'https://x/pull/1'],
    ],
  );
});

test('a feedback result, its launch and a review request round-trip', () => {
  const sha = 'f'.repeat(40);
  const launch = { stage: 'feedback' as const, at: t(0), attempt: 1, sha, session: 's2', work: '/w/PROJ-1-feedback-1', result: '/r/feedback-fffffff-1.json' };
  const result = {
    commit: sha,
    outcome: 'fix' as const,
    findings: [
      { id: 'F1', source: 'ci:test', kind: 'bar', severity: 'blocking' as const, observed: 'login.spec.ts fails: expected 200, got 500' },
      { id: 'F2', source: 'review:rev', kind: 'bar', severity: 'advisory' as const, observed: 'a nit' },
    ],
    blocked: [{ source: 'ci:e2e', reason: 'runner lost' }],
  };
  const text = feedbackComment(launch, result, 'feedback-fffffff-1.json');
  assert.match(text, /1 blocking and 1 advisory findings, 1 signals nobody could read\.\n- F1 \(ci:test\): login\.spec\.ts fails/);
  const r = readComments([
    { at: t(1), text: adfToMarkdown(textToAdf(launchComment(launch, 'note'))) },
    { at: t(2), text: adfToMarkdown(textToAdf(text)) },
    { at: t(3), text: adfToMarkdown(textToAdf(feedbackComment(launch, null))) },
    { at: t(4), text: adfToMarkdown(textToAdf(reviewComment(sha, 'Asked for a review.'))) },
  ]);
  assert.deepEqual(
    r.launches.map((l) => [l.stage, l.sha, l.session, l.result]),
    [['feedback', sha, 's2', '/r/feedback-fffffff-1.json']],
  );
  assert.deepEqual(
    r.feedbacks.map((o) => [o.attempt, o.sha, o.session, o.outcome, o.file]),
    [
      [1, sha, 's2', 'fix', 'feedback-fffffff-1.json'],
      [1, sha, 's2', 'none', undefined],
    ],
  );
  assert.deepEqual(r.reviewRequests, [{ at: t(4), sha }]);
});
