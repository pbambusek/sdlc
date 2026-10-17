// The dispatcher table: observed facts in, one decision out. Pure, so it can move to another runtime unchanged.
import type { Action, Decision, Feature, Launch, Limits, Round } from './types.mts';

const last = <T,>(xs: T[]): T | undefined => xs[xs.length - 1];
const short = (sha: string) => sha.slice(0, 7);

/** A head with no check run at all is done once this many minutes have passed: a push's checks appear within seconds. */
export const GRACE_MINUTES = 5;

/**
 * The round of one head, from what GitHub reports on it now: done when nothing is still running, and the reviewer's
 * check (when one is expected) exists. `since` is when the round started, the head's first verify launch.
 */
export const settle = (
  seen: { checks: { name: string; done: boolean }[]; pendingStatuses: string[] },
  expect: string | null,
  since: string,
  now: string,
  limits: Limits,
): Round => {
  const pending = [...seen.checks.filter((c) => !c.done).map((c) => c.name), ...seen.pendingStatuses];
  if (expect && !seen.checks.some((c) => c.name === expect)) pending.push(`${expect} (not started)`);
  const minutes = (Date.parse(now) - Date.parse(since)) / 60_000;
  if (!pending.length && (seen.checks.length || minutes >= GRACE_MINUTES)) return { state: 'done', pending };
  return { state: minutes >= limits.roundTimeoutMinutes ? 'timed-out' : 'waiting', pending };
};

export const decide = (f: Feature, limits: Limits): Decision => {
  const out = (state: string, detail = '', ...actions: Action[]): Decision => ({ key: f.key, state, detail, actions });
  const park = (reason: string) => out('parking', reason, { kind: 'park', reason });

  if (f.parked) return out('parked', 'remove the sdlc-parked label to continue');

  const a = f.approval;
  if (!a.ok) {
    if (a.code === 'not-approved') return out('waiting for approval', 'add the sdlc-approved label');
    const posted = f.notices.some((n) => n.code === a.code && n.at >= a.since);
    return out('approval invalid', a.reason, ...(posted ? [] : [{ kind: 'notice' as const, code: a.code, text: a.reason }]));
  }
  if (!f.repo) return out('no repo', `no repo is configured for project ${f.key.split('-')[0]}`);

  if (f.running.length) {
    const r = f.running[0]!;
    return out(r.state === 'blocked' ? `${r.stage} waiting for input` : `${r.stage} running`, r.label);
  }

  // A build that has ended goes into the ledger before anything else; a question parks with it.
  if (f.finished) {
    const { launch, result } = f.finished;
    const record: Action = { kind: 'record-build', launch, result };
    if (result?.outcome === 'asked') {
      const reason = 'The build asked the questions in the build-result comment above. The build reads only the spec: answer them there and approve it again.';
      return out('parking', `build #${launch.attempt} asked`, record, { kind: 'park', reason });
    }
    const detail = result ? `build #${launch.attempt} ${result.outcome} ${short(result.commit ?? 'nothing')}` : `build #${launch.attempt} wrote no result`;
    return out('recording build', detail, record);
  }
  if (f.finishedFeedback) {
    const { launch, result } = f.finishedFeedback;
    const detail = `feedback #${launch.attempt} on ${short(launch.sha ?? '')}: ${result?.outcome ?? 'no output'}`;
    return out('recording feedback', detail, { kind: 'record-feedback', launch, result });
  }

  if (f.pr?.state === 'merged') return out('merged', f.pr.url);
  if (f.pr?.state === 'closed') return out('pr closed', `${f.pr.url}: reopen it, or remove the sdlc label`);

  // Every run the issue has had numbers the next, so an un-park never reuses a session name or result file. Builds also cap on it.
  const ever = (stage: Launch['stage']) => f.allLaunches.filter((l) => l.stage === stage).length;
  // Builds since the epoch guard against a stuck loop; verify and feedback runs are guarded per head, and a build starts every loop.
  const builds = f.launches.filter((l) => l.stage === 'build');
  const total = ever('build');
  const nextBuild = (base: string, why: string, feedback: string | null = null) =>
    total >= limits.maxBuilds
      ? park(`${why}, and ${total} builds have run on this issue, the limit. Raise limits.maxBuilds to build it again.`)
      : out('building', why, { kind: 'launch-build', attempt: total + 1, base, branch: f.pr?.branch ?? f.branch, feedback });

  if (!f.pr) {
    if (builds.length >= 2) return park(`${builds.length} builds ended without a pull request.`);
    return nextBuild('none', builds.length ? 'the last build ended without a pull request' : 'approved, nothing built yet');
  }

  const head = f.pr.head;
  const verifies = f.launches.filter((l) => l.stage === 'verify' && l.sha === head);
  const reports = f.reports.filter((r) => r.sha === head);
  const lastVerify = last(verifies);
  const lastReport = last(reports);
  // Each new head gets one review request, alongside its first verify launch.
  const review: Action[] = f.repo.review && !f.reviewRequests.some((r) => r.sha === head) ? [{ kind: 'request-review', sha: head }] : [];

  if (lastVerify && (!lastReport || lastVerify.at > lastReport.at)) {
    if (f.evidence?.sha === head) return out('reporting', `${short(head)}: ${f.evidence.result}`, { kind: 'report', evidence: f.evidence }, ...review);
    return out('verifying', short(head), ...review);
  }
  if (!lastReport) {
    // A head the build asked on is not ready to verify: once answered, the next build continues from it.
    if (f.outcomes.some((o) => o.outcome === 'asked' && o.commit === head)) {
      if (builds.length) return park(`A build after the answer ended without a new commit on ${short(head)}.`);
      return nextBuild(head, `continuing ${short(head)} after the answer`);
    }
    return out('verifying', short(head), { kind: 'launch-verify', attempt: ever('verify') + 1, sha: head }, ...review);
  }
  if (lastReport.result === 'invalid') {
    const invalid = reports.filter((r) => r.result === 'invalid').length;
    if (invalid >= limits.maxInvalidVerifies) return park(`${invalid} verify runs on ${short(head)} ended without a valid result.`);
    return out('verifying', `retrying ${short(head)}`, { kind: 'launch-verify', attempt: ever('verify') + 1, sha: head });
  }

  // Verify has a valid result. The round ends when CI and review have too; feedback then reads all of it at once.
  const feedbackRuns = f.launches.filter((l) => l.stage === 'feedback' && l.sha === head);
  const lastFeedback = last(f.feedbacks.filter((o) => o.sha === head));
  if (!lastFeedback || lastFeedback.outcome === 'none') {
    if (feedbackRuns.length >= limits.maxFeedbackRuns) return park(`${feedbackRuns.length} feedback runs on ${short(head)} ended without an output.`);
    const round = f.round;
    if (round?.state === 'waiting') return out('waiting for the round', `${short(head)}: ${round.pending.join(', ')}`);
    return out('reading feedback', short(head), { kind: 'launch-feedback', attempt: ever('feedback') + 1, sha: head, run: lastReport.run ?? null });
  }

  switch (lastFeedback.outcome) {
    case 'clean':
      return out('ready for review', `${short(head)} verified, CI and review clean: ${f.pr.url}`);
    case 'blocked':
      return park(`Feedback on ${short(head)} found signals nobody could read; a person has to unblock them. See the feedback comment.`);
    case 'fix': {
      if (builds.some((b) => b.at > lastFeedback.at)) return park(`A fix build ended without pushing a commit after the feedback on ${short(head)}.`);
      return nextBuild(head, `feedback on ${short(head)} asks for fixes`, lastFeedback.file ?? null);
    }
  }
};
