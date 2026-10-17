// The facts a tick observes about one feature, and what it decides to do about them.

export type Stage = 'build' | 'verify' | 'feedback';
export type Result = 'passed' | 'failed' | 'blocked' | 'invalid';

export interface RepoConfig {
  /** Local checkout the stages run in. */
  path: string;
  /** owner/name on GitHub. */
  github: string;
  /** Gitignored files the verify launcher copies into a run, as the repo's VERIFY.md lists them. */
  verifyCopy: string[];
  /**
   * How to ask for a code review of each new head: a label that triggers the reviewer, a reviewer to request, or both.
   * `check` is the check run the reviewer posts on the commit: the round waits for it to exist and finish. None: no review.
   */
  review: { label?: string; reviewer?: string; check?: string } | null;
}

/** A `[sdlc] launched …` comment. */
export interface Launch {
  stage: Stage;
  at: string;
  attempt: number;
  /** build: the commit it started from, or `none` for the default branch. */
  base?: string;
  /** verify and feedback: the commit it is about. */
  sha?: string;
  session?: string;
  log?: string;
  /** build: the worktree it runs in, and the file its result lands in. */
  work?: string;
  result?: string;
}

/** What the build skill writes to its result file. */
export interface BuildResult {
  outcome: 'built' | 'asked';
  branch?: string;
  commit?: string | null;
  review?: string | null;
  questions?: { about?: string[]; question: string; recommended?: string }[];
}

/** A `[sdlc] build-result …` comment: how a build ended, `none` when it wrote no result. */
export interface BuildOutcome {
  at: string;
  attempt: number;
  session?: string;
  outcome: BuildResult['outcome'] | 'none';
  branch?: string;
  commit?: string;
  review?: string;
}

/** A `[sdlc] reported …` comment: a verify result, projected into the ledger. */
export interface Report {
  at: string;
  sha: string;
  result: Result;
  /** Jira attachment ids of the run's full evidence.json and evidence.html, unchanged. */
  evidence?: string;
  page?: string;
  /** The run folder's name: its copy is under the archive, for the next build. */
  run?: string;
}

/** What the feedback skill writes to its output file; the tick reads only the outcome. */
export interface FeedbackResult {
  commit: string;
  outcome: 'fix' | 'blocked' | 'clean';
  findings: { id: string; source: string; kind: string; about?: string[]; severity: 'blocking' | 'advisory'; observed: string }[];
  blocked: { source: string; reason: string }[];
}

/** A `[sdlc] feedback-result …` comment: how a feedback run ended, `none` when it wrote no output. */
export interface FeedbackOutcome {
  at: string;
  attempt: number;
  sha: string;
  session?: string;
  outcome: FeedbackResult['outcome'] | 'none';
  /** The output's name under the archive, for the next build. */
  file?: string;
}

/** A `[sdlc] review-requested …` comment. */
export interface ReviewRequest {
  at: string;
  sha: string;
}

/**
 * Whether everything that reports on the head has finished: CI and the reviewer's check. `timed-out` when some has not
 * after the limit; feedback then runs anyway and lists what is still pending as blocked.
 */
export interface Round {
  state: 'waiting' | 'done' | 'timed-out';
  pending: string[];
}

/** A `[sdlc] notice …` comment, posted once per cause. */
export interface Notice {
  at: string;
  code: string;
}

export type Approval =
  | { ok: true; at: string; by: string }
  | { ok: false; code: 'not-approved' | 'approval-unknown' | 'approver-not-allowed' | 'edited-after-approval'; reason: string; since: string };

export interface PullRequest {
  number: number;
  url: string;
  branch: string;
  head: string;
  state: 'open' | 'merged' | 'closed';
}

export interface Running {
  stage: Stage;
  label: string;
  /** `working`, `blocked` (waiting for a person) or `running` for a verify launcher. */
  state: string;
}

/** A verify result found on disk and not yet in the ledger. */
export interface Evidence {
  sha: string;
  at: string;
  result: Result;
  summary: string;
  dir: string | null;
  log: string | null;
}

export interface Feature {
  key: string;
  summary: string;
  url: string;
  parked: boolean;
  approval: Approval;
  /** Everything before this (the latest approval or un-park) is history and no longer counts. */
  epoch: string | null;
  repo: RepoConfig | null;
  /** The build's branch, as the latest build result named it. */
  branch: string | null;
  pr: PullRequest | null;
  /** Since the epoch. */
  launches: Launch[];
  /** Every launch ever, for the archive. */
  allLaunches: Launch[];
  reports: Report[];
  notices: Notice[];
  /** Every build outcome ever: the branch and an asked head outlive an epoch. */
  outcomes: BuildOutcome[];
  running: Running[];
  /** A build session that has ended and is not in the ledger yet, with its result if it wrote one. */
  finished: { launch: Launch; result: BuildResult | null } | null;
  evidence: Evidence | null;
  /** Since the epoch. */
  feedbacks: FeedbackOutcome[];
  reviewRequests: ReviewRequest[];
  /** A feedback session that has ended and is not in the ledger yet, with its output if it wrote one. */
  finishedFeedback: { launch: Launch; result: FeedbackResult | null } | null;
  /** The PR head's round, once it has been verified; null before. */
  round: Round | null;
}

export type Action =
  | { kind: 'launch-build'; attempt: number; base: string; branch: string | null; feedback: string | null }
  | { kind: 'record-build'; launch: Launch; result: BuildResult | null }
  | { kind: 'launch-verify'; attempt: number; sha: string }
  | { kind: 'request-review'; sha: string }
  | { kind: 'launch-feedback'; attempt: number; sha: string; run: string | null }
  | { kind: 'record-feedback'; launch: Launch; result: FeedbackResult | null }
  | { kind: 'report'; evidence: Evidence }
  | { kind: 'park'; reason: string }
  | { kind: 'notice'; code: string; text: string };

export interface Decision {
  key: string;
  state: string;
  detail: string;
  actions: Action[];
}

export interface Limits {
  /** Builds per feature over its whole life, first build and fix rounds together: an un-park does not reset it. */
  maxBuilds: number;
  /** Verify runs per commit that end without a valid result. */
  maxInvalidVerifies: number;
  /** Feedback runs per commit that end without an output. */
  maxFeedbackRuns: number;
  /** Minutes after a head's first verify launch that the round stops waiting for checks still running. */
  roundTimeoutMinutes: number;
}
