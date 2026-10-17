// One tick: observe every feature in the ledger, decide with the table, act. Running it twice in a row is harmless.
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { archiveFeedback, archiveSessions, archiveVerify, feedbackPath, findTranscript, loadRuns, verifierSession } from './archive.mts';
import { HOME, type Config } from './config.mts';
import { decide, settle } from './decide.mts';
import { findEvidence } from './evidence.mts';
import { timeline, withRuns, type Step } from './history.mts';
import { findPr, labelPr, markReady, postStatus, readChecks, requestReview } from './github.mts';
import type { Issue, Jira } from './jira.mts';
import {
  buildComment,
  feedbackComment,
  LABELS,
  launchComment,
  noticeComment,
  parkComment,
  readApproval,
  readComments,
  reportComment,
  reviewComment,
  unparks,
} from './ledger.mts';
import {
  launchBuild,
  launchFeedback,
  launchVerify,
  listSessions,
  readBuildResult,
  readFeedbackResult,
  removeWorktree,
  runningFor,
  sessionName,
  specSnapshot,
  sweepWorktrees,
  type AgentSession,
} from './sessions.mts';
import { runSeconds, totals } from './stats.mts';
import type { Action, Decision, Feature } from './types.mts';
import { cost, sessionUsage } from './usage.mts';

export interface Observed {
  issue: Issue;
  feature: Feature;
  /** Its whole history, for people: decide never sees it. */
  steps: Step[];
}

export const observe = async (config: Config, jira: Jira, issue: Issue, sessions: AgentSession[]): Promise<Omit<Observed, 'issue'>> => {
  const [changelog, comments] = await Promise.all([jira.changelog(issue.key), jira.comments(issue.key)]);
  const { approval, epoch } = readApproval(issue.labels, changelog, config.approvers, issue.created);
  const ledger = readComments(comments);
  const since = <T extends { at: string }>(xs: T[]) => (epoch ? xs.filter((x) => x.at >= epoch) : []);
  const repo = config.repos[issue.key.split('-')[0]!] ?? null;
  const running = runningFor(issue.key, sessions);

  const branch = ledger.outcomes.filter((o) => o.branch).pop()?.branch ?? null;
  const pr = repo && approval.ok && branch ? findPr(repo, branch) : null;
  const launches = since(ledger.launches);

  // The last build, once its session has ended and before its outcome is in the ledger.
  const lastBuild = ledger.launches.filter((l) => l.stage === 'build').pop();
  const recorded = lastBuild && ledger.outcomes.some((o) => o.attempt === lastBuild.attempt && o.session === lastBuild.session && o.at >= lastBuild.at);
  const finished =
    lastBuild && !recorded && !running.some((r) => r.stage === 'build') ? { launch: lastBuild, result: readBuildResult(lastBuild.result) } : null;
  const lastVerify = pr && launches.filter((l) => l.stage === 'verify' && l.sha === pr.head).pop();
  const evidence =
    repo && pr && lastVerify
      ? findEvidence(
          repo.path,
          issue.key,
          pr.head,
          lastVerify,
          running.some((r) => r.stage === 'verify'),
        )
      : null;

  // The last feedback run, once its session has ended and before its outcome is in the ledger.
  const lastFeedback = ledger.launches.filter((l) => l.stage === 'feedback').pop();
  const feedbackRecorded =
    lastFeedback && ledger.feedbacks.some((o) => o.attempt === lastFeedback.attempt && o.session === lastFeedback.session && o.at >= lastFeedback.at);
  const finishedFeedback =
    lastFeedback && !feedbackRecorded && !running.some((r) => r.stage === 'feedback')
      ? { launch: lastFeedback, result: readFeedbackResult(lastFeedback.result) }
      : null;

  // The head's round, once it has a valid verify result: what CI and the reviewer still run on it.
  const firstVerify = pr && launches.find((l) => l.stage === 'verify' && l.sha === pr.head);
  const validReport = pr && since(ledger.reports).some((r) => r.sha === pr.head && r.result !== 'invalid');
  const round =
    repo && pr?.state === 'open' && firstVerify && validReport
      ? settle(readChecks(repo, pr.head), repo.review?.check ?? null, firstVerify.at, new Date().toISOString(), config.limits)
      : null;

  const feature: Feature = {
    key: issue.key,
    summary: issue.summary,
    url: issue.url,
    parked: issue.labels.includes(LABELS.parked),
    approval,
    epoch,
    repo,
    branch,
    pr,
    launches,
    allLaunches: ledger.launches,
    reports: since(ledger.reports),
    notices: ledger.notices,
    outcomes: ledger.outcomes,
    running,
    finished,
    evidence,
    feedbacks: since(ledger.feedbacks),
    reviewRequests: since(ledger.reviewRequests),
    finishedFeedback,
    round,
  };
  return { feature, steps: timeline(ledger, unparks(changelog), running) };
};

const describe = (a: Action) =>
  a.kind === 'launch-build'
    ? `launch build #${a.attempt} from ${a.base === 'none' ? 'the default branch' : a.base.slice(0, 7)}${a.feedback ? ' with the feedback' : ''}`
    : a.kind === 'record-build'
      ? `record build #${a.launch.attempt}: ${a.result?.outcome ?? 'no result'}`
      : a.kind === 'launch-verify'
        ? `launch verify #${a.attempt} of ${a.sha.slice(0, 7)}`
        : a.kind === 'request-review'
          ? `request a review of ${a.sha.slice(0, 7)}`
          : a.kind === 'launch-feedback'
            ? `launch feedback #${a.attempt} on ${a.sha.slice(0, 7)}`
            : a.kind === 'record-feedback'
              ? `record feedback #${a.launch.attempt}: ${a.result?.outcome ?? 'no output'}`
              : a.kind === 'report'
                ? `report ${a.evidence.result} for ${a.evidence.sha.slice(0, 7)}`
                : a.kind === 'park'
                  ? `park: ${a.reason.split('\n')[0]}`
                  : `notice ${a.code}`;

/** What a feature has used: its archived runs, plus what a running build or verifier has used so far. */
export interface Spent {
  usd: number;
  tokens: number;
  seconds: number;
  builds: number;
  verifies: number;
  /** Of that, the running session's share. */
  live: { usd: number; tokens: number; seconds: number } | null;
}

/** Archived runs by when they started. */
export interface Spend {
  today: { usd: number; runs: number; seconds: number };
  week: { usd: number; runs: number; seconds: number };
  all: { usd: number; runs: number; seconds: number };
}

export interface TickResult {
  at: string;
  dryRun: boolean;
  decisions: (Decision & { summary: string; url: string; pr: string | null; done: string[]; spent?: Spent; steps?: Step[] })[];
  errors: string[];
  spend?: Spend;
}

const allTokens = (t: { input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number }) =>
  t.input + t.output + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h;

/** The session a running stage writes to: a build's or feedback run's own, or the verifier the launcher has started. */
const liveSession = (f: Feature) => {
  const stage = f.running[0]?.stage;
  if (!stage) return null;
  const launch = f.allLaunches.filter((l) => l.stage === stage).pop();
  return stage === 'verify' ? verifierSession(launch?.log) : (launch?.session ?? null);
};

// Metrics are for people: a broken transcript or archive must never fail a tick.
const spentFor = (config: Config, f: Feature): Spent | undefined => {
  try {
    const runs = loadRuns(f.key);
    const t = totals(runs, config.prices);
    const session = liveSession(f);
    const transcript = session ? findTranscript(session) : null;
    let live: Spent['live'] = null;
    if (transcript) {
      const u = sessionUsage(transcript);
      live = { usd: cost(u, config.prices).usd, tokens: allTokens(u.tokens), seconds: u.start ? Math.round((Date.now() - Date.parse(u.start)) / 1000) : 0 };
    }
    return {
      usd: t.usd + (live?.usd ?? 0),
      tokens: allTokens(t.usage.tokens) + (live?.tokens ?? 0),
      seconds: t.seconds + (live?.seconds ?? 0),
      builds: runs.filter((r) => r.stage === 'build').length,
      verifies: runs.filter((r) => r.stage === 'verify').length,
      live,
    };
  } catch {
    return undefined;
  }
};

const stepsFor = (config: Config, key: string, steps: Step[]) => {
  try {
    return withRuns(steps, loadRuns(key), config.prices);
  } catch {
    return steps;
  }
};

const spendSince = (config: Config, now: number): Spend | undefined => {
  try {
    const runs = loadRuns();
    const day = new Date(now);
    day.setHours(0, 0, 0, 0);
    const sum = (from: string) => {
      const mine = runs.filter((r) => r.at >= from);
      return { usd: totals(mine, config.prices).usd, runs: mine.length, seconds: mine.reduce((n, r) => n + runSeconds(r), 0) };
    };
    return { today: sum(day.toISOString()), week: sum(new Date(now - 7 * 86400e3).toISOString()), all: sum('') };
  } catch {
    return undefined;
  }
};

export const tick = async (config: Config, jira: Jira, opts: { dryRun: boolean; only?: string; log: (s: string) => void }): Promise<TickResult> => {
  const result: TickResult = { at: new Date().toISOString(), dryRun: opts.dryRun, decisions: [], errors: [] };
  const sessions = listSessions();
  if (!opts.dryRun) for (const w of sweepWorktrees(Object.values(config.repos), sessions)) opts.log(`removed worktree ${w}`);
  let issues = await jira.search();
  if (opts.only) issues = issues.filter((i) => i.key === opts.only);

  const features: Observed[] = [];
  for (const issue of issues) {
    try {
      features.push({ issue, ...(await observe(config, jira, issue, sessions)) });
    } catch (e) {
      result.errors.push(`${issue.key}: ${(e as Error).message}`);
    }
  }

  let busy = features.reduce((n, f) => n + f.feature.running.length, 0);
  for (const { issue, feature, steps } of features) {
    const d = decide(feature, config.limits);
    const done: string[] = [];
    const row: TickResult['decisions'][number] = { ...d, summary: issue.summary, url: issue.url, pr: feature.pr?.url ?? null, done };
    result.decisions.push(row);
    if (!opts.dryRun && feature.repo) archiveSessions(feature.key, feature.allLaunches, sessions);

    for (const a of d.actions) {
      const what = describe(a);
      if (a.kind.startsWith('launch') && busy >= config.maxConcurrent) {
        done.push(`deferred (${busy} running): ${what}`);
        continue;
      }
      if (opts.dryRun) {
        done.push(`would ${what}`);
        continue;
      }
      try {
        await act(config, jira, issue, feature, a);
        if (a.kind.startsWith('launch')) busy++;
        done.push(what);
        opts.log(`${issue.key}: ${what}`);
      } catch (e) {
        result.errors.push(`${issue.key}: ${what}: ${(e as Error).message}`);
      }
    }
    // After acting: a verify run reported in this tick is archived by now.
    row.spent = spentFor(config, feature);
    row.steps = stepsFor(config, feature.key, steps);
  }
  result.spend = spendSince(config, Date.now());
  return result;
};

const approvedAt = (f: Feature) => (f.approval.ok ? f.approval.at : new Date().toISOString());

// Each action writes its ledger record first, so a crash mid-action counts as an attempt and is never silently repeated.
const act = async (config: Config, jira: Jira, issue: Issue, f: Feature, a: Action) => {
  const repo = f.repo!;
  switch (a.kind) {
    case 'launch-build': {
      const spec = specSnapshot(issue, approvedAt(f));
      const feedback = a.feedback ? feedbackPath(f.key, a.feedback) : null;
      const { session, work, result, run } = launchBuild(config, repo, issue, { attempt: a.attempt, base: a.base, branch: a.branch, spec, feedback });
      const note = `Session "${sessionName(f.key, 'build', a.attempt)}": claude attach ${session.slice(0, 8)}`;
      await jira.comment(f.key, launchComment({ stage: 'build', attempt: a.attempt, base: a.base, session, work, result }, note));
      run();
      return;
    }
    case 'record-build': {
      await jira.comment(f.key, buildComment(a.launch, a.result));
      if (a.launch.work) removeWorktree(repo, a.launch.work);
      if (a.result?.outcome === 'built' && a.result.review) {
        labelPr(repo, a.result.review);
        markReady(repo, a.result.review);
      }
      return;
    }
    case 'launch-verify': {
      const { log, run } = launchVerify(config, repo, issue, specSnapshot(issue, approvedAt(f)), a.sha, a.attempt);
      await jira.comment(
        f.key,
        launchComment({ stage: 'verify', attempt: a.attempt, sha: a.sha, log }, `Verifying ${f.pr?.url ?? a.sha} against this issue's description.`),
      );
      run();
      return;
    }
    case 'request-review': {
      const how = [repo.review?.label && `label ${repo.review.label}`, repo.review?.reviewer && `reviewer ${repo.review.reviewer}`]
        .filter(Boolean)
        .join(' and ');
      await jira.comment(f.key, reviewComment(a.sha, `Asked for a review of ${f.pr?.url ?? a.sha} (${how}).`));
      requestReview(repo, f.pr!.url, a.sha);
      return;
    }
    case 'launch-feedback': {
      const spec = specSnapshot(issue, approvedAt(f));
      const verifyRun = a.run ? join(HOME, 'archive', f.key, 'verify', a.run) : null;
      const { session, work, result, run } = launchFeedback(config, repo, issue, { attempt: a.attempt, sha: a.sha, pr: f.pr!.number, spec, run: verifyRun });
      const note = `Reading CI, verify and review on ${a.sha.slice(0, 7)}. Session "${sessionName(f.key, 'feedback', a.attempt)}": claude attach ${session.slice(0, 8)}`;
      await jira.comment(f.key, launchComment({ stage: 'feedback', attempt: a.attempt, sha: a.sha, session, work, result }, note));
      run();
      return;
    }
    case 'record-feedback': {
      // The output goes into the ledger unchanged: attached for people, archived for the next build.
      const file = a.result && a.launch.result ? archiveFeedback(f.key, a.launch.result) : undefined;
      if (file) await jira.attach(f.key, [{ name: `sdlc-${file}`, path: feedbackPath(f.key, file) }]);
      await jira.comment(f.key, feedbackComment(a.launch, a.result, file));
      if (a.launch.work) removeWorktree(repo, a.launch.work);
      return;
    }
    case 'report': {
      const e = a.evidence;
      postStatus(repo, e.sha, e.result, `${e.result}: ${e.summary.split('\n')[0]}`);
      // The full report goes into the ledger unchanged, for people and for the next build: never a condensed version.
      let files: { evidence: string; page: string } | undefined;
      const run = e.dir ? basename(e.dir) : null;
      if (e.dir && existsSync(join(e.dir, 'evidence.json'))) {
        const pagePath = join(e.dir, 'evidence.html');
        const [evidence, page] = await jira.attach(f.key, [
          { name: `sdlc-verify-${run}.json`, path: join(e.dir, 'evidence.json') },
          ...(existsSync(pagePath) ? [{ name: `sdlc-verify-${run}.html`, path: pagePath }] : []),
        ]);
        files = { evidence: evidence!, page: page || 'none' };
      }
      const next = e.result === 'invalid' ? '' : '\nFeedback reads this run together with CI and review once they have finished on this commit.';
      const attached = files
        ? `\nFull report attached: sdlc-verify-${run}.json (evidence) and sdlc-verify-${run}.html (page, with screenshots and the audit).`
        : '';
      await jira.comment(f.key, reportComment(e.sha, e.result, e.summary + attached + next, files, run ?? undefined));
      archiveVerify(f.key, e);
      return;
    }
    case 'park':
      await jira.comment(f.key, parkComment(a.reason));
      await jira.addLabel(f.key, LABELS.parked);
      return;
    case 'notice':
      await jira.comment(f.key, noticeComment(a.code, a.text));
      return;
  }
};
