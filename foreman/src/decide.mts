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

/** How many runs of a stage in a row, since the last retry a person asked for, ended without a result. */
const failedInARow = (ends: { at: string; ok: boolean }[], since: string | null) => {
  let n = 0;
  for (const e of [...ends].reverse()) {
    if (since && e.at < since) break;
    if (e.ok) break;
    n++;
  }
  return n;
};

/** A stage ending without a result twice in a row stops, for a person to retry or abandon; once, it simply runs again. */
const STALL_AFTER = 2;

export const decide = (f: Feature, _limits?: Limits): Decision => {
  const out = (state: string, detail = '', ...actions: Action[]): Decision => ({ key: f.key, state, detail, actions });

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

  // A stage that has ended goes into the ledger before anything else.
  if (f.finished) {
    const { launch, result } = f.finished;
    const detail = result ? `build #${launch.attempt} ${result.outcome} ${short(result.commit ?? 'nothing')}` : `build #${launch.attempt} wrote no result`;
    return out('recording build', detail, { kind: 'record-build', launch, result });
  }
  if (f.finishedFeedback) {
    const { launch, result } = f.finishedFeedback;
    const detail = `feedback #${launch.attempt} on ${short(launch.sha ?? '')}: ${result ? `${result.items.length} items` : 'no output'}`;
    return out('recording feedback', detail, { kind: 'record-feedback', launch, result });
  }

  if (f.pr?.state === 'merged') return out('merged', f.pr.url);
  const abandoned = f.decisions.find((d) => d.next === 'abandon');
  if (abandoned) return f.pr?.state === 'open' ? out('abandoning', f.pr.url, { kind: 'close-pr' }) : out('abandoned', f.pr?.url ?? '');
  if (f.pr?.state === 'closed') return out('pr closed', `${f.pr.url}: reopen it, or remove the sdlc label`);

  // Every run the issue has had numbers the next, so a new approval never reuses a session name or result file.
  const ever = (stage: Launch['stage']) => f.allLaunches.filter((l) => l.stage === stage).length;
  const nextBuild = ever('build') + 1;
  const retried = (stage: Launch['stage']) => last(f.retries.filter((r) => r.stage === stage))?.at ?? null;
  const builds = f.launches.filter((l) => l.stage === 'build');
  const outcomes = f.outcomes.filter((o) => !f.epoch || o.at >= f.epoch);
  const build = (base: string, why: string, feedback: string | null = null) =>
    out('building', why, { kind: 'launch-build', attempt: nextBuild, base, branch: f.pr?.branch ?? f.branch, feedback });
  const stalled = (stage: Launch['stage'], why: string) => out('stalled', `${stage}: ${why}`);

  // A build that asked stops at the question gate before anything runs on what it pushed.
  const lastOutcome = last(outcomes);
  if (lastOutcome?.outcome === 'asked') {
    const d = last(f.decisions.filter((x) => x.gate === 'questions' && x.build === lastOutcome.attempt));
    const gate = `/questions/${f.key}/${lastOutcome.attempt}`;
    if (!d) return { ...out('questions', `build #${lastOutcome.attempt} asked`), gate };
    if (d.next === 'respec') return { ...out('waiting for spec change', `build #${lastOutcome.attempt}'s questions`), gate };
    return build(lastOutcome.commit ?? 'none', `continuing build #${lastOutcome.attempt} with the answers`, d.file ?? null);
  }

  if (!f.pr) {
    if (!builds.length) return build('none', 'approved, nothing built yet');
    const misses = failedInARow(
      outcomes.map((o) => ({ at: o.at, ok: o.outcome !== 'none' })),
      retried('build'),
    );
    if (misses >= STALL_AFTER) return stalled('build', `${misses} builds in a row ended without a pull request`);
    return build('none', 'the last build ended without a pull request');
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
  if (!lastReport) return out('verifying', short(head), { kind: 'launch-verify', attempt: ever('verify') + 1, sha: head }, ...review);
  if (lastReport.result === 'invalid') {
    const misses = failedInARow(
      reports.map((r) => ({ at: r.at, ok: r.result !== 'invalid' })),
      retried('verify'),
    );
    if (misses >= STALL_AFTER) return stalled('verify', `${misses} verify runs in a row on ${short(head)} ended without evidence`);
    return out('verifying', `retrying ${short(head)}`, { kind: 'launch-verify', attempt: ever('verify') + 1, sha: head });
  }

  // Verify has a valid result. The round ends when CI and review have too; feedback then reads all of it at once.
  const feedbacks = f.feedbacks.filter((o) => o.sha === head && o.at > lastReport.at);
  const lastFeedback = last(feedbacks);
  if (!lastFeedback || lastFeedback.outcome === 'none') {
    const misses = failedInARow(
      feedbacks.map((o) => ({ at: o.at, ok: o.outcome !== 'none' })),
      retried('feedback'),
    );
    if (misses >= STALL_AFTER) return stalled('feedback', `${misses} feedback runs in a row on ${short(head)} ended without an output`);
    const round = f.round;
    if (round?.state === 'waiting') return out('waiting for the round', `${short(head)}: ${round.pending.join(', ')}`);
    return out('reading feedback', short(head), { kind: 'launch-feedback', attempt: ever('feedback') + 1, sha: head, run: lastReport.run ?? null });
  }

  // The round's gate: nothing starts on the issue until a person decides it, or the head changes.
  const d = last(f.decisions.filter((x) => x.gate === 'round' && x.sha === head && x.at > lastFeedback.at));
  const gate = `/round/${f.key}/${head}`;
  if (!d) return { ...out('gate open', `round on ${short(head)}`), gate };
  if (d.next === 'respec') return { ...out('waiting for spec change', `round on ${short(head)}`), gate };
  // The review threads the decision answers with the person's words go first: nothing else needs a session for them.
  if (d.replies && d.file && !f.replied.includes(head))
    return {
      ...out('replying', `${d.replies} review thread${d.replies > 1 ? 's' : ''} on ${short(head)}`, { kind: 'post-replies', sha: head, file: d.file }),
      gate,
    };
  if (d.next === 'build') {
    const since = [d.at, retried('build') ?? ''].sort().pop()!;
    const after = outcomes.filter((o) => o.at > since);
    if (!after.length) return build(head, `the decision on ${short(head)}`, d.file ?? null);
    // The build ran and the head is unchanged: fine when it only had replies to word.
    if (d.commit) return stalled('build', `build #${last(after)!.attempt} ended without a new commit after the decision on ${short(head)}`);
  }
  if (!f.merge) return { ...out('decided', `round on ${short(head)}`), gate };
  if (!f.merge.ready) return { ...out('waiting to merge', `#${f.pr.number} ${f.merge.why}`), gate };
  return { ...out('ready to merge', f.pr.url, ...(f.readies.includes(head) ? [] : [{ kind: 'ready' as const, sha: head }])), gate };
};
