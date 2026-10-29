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
  questions?: { id?: string; about?: string[]; question: string; recommended?: string }[];
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

/** One item of a feedback file: a signal named by what it is about, with its status in its source's own terms. */
export interface FeedbackItem {
  item: string;
  status: string;
  observed?: string;
  reason?: string;
  rule?: string;
  where?: string;
  link?: string;
  by?: string;
  mark?: string;
  calls?: string[];
  /** A build's question: the claims or items it is about, and the build's recommended answer. */
  about?: string[];
  recommended?: string;
}

/** What the feedback skill writes to its output file. */
export interface FeedbackResult {
  commit: string;
  pr?: string;
  items: FeedbackItem[];
}

/** A `[sdlc] feedback-result …` comment: how a feedback run ended, `none` when it wrote no output. */
export interface FeedbackOutcome {
  at: string;
  attempt: number;
  sha: string;
  session?: string;
  outcome: 'read' | 'none';
  /** The round's feedback file, and its Jira attachment id. */
  file?: string;
  attachment?: string;
}

/** A `[sdlc] decided …` comment: a person's decisions at a gate, attached to the issue as the decided document. */
export interface Decided {
  at: string;
  gate: 'round' | 'questions';
  /** round: the head it decided; questions: the commit the build asked on, or `none`. */
  sha: string;
  /** questions: the build that asked. */
  build?: number;
  next: 'abandon' | 'respec' | 'build' | 'done';
  /** Whether the build it starts must push a commit. */
  commit: boolean;
  /** How many review threads foreman answers with the person's words. */
  replies: number;
  file?: string;
  attachment?: string;
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

/** Whether GitHub would merge the PR with nothing missing but a person's approval, and why not. */
export interface Mergeability {
  ready: boolean;
  why: string;
  base: string;
}

export interface Feature {
  key: string;
  summary: string;
  url: string;
  approval: Approval;
  /** Everything before this (the latest approval) is history and no longer counts. */
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
  /** Since the epoch: every gate a person decided. */
  decisions: Decided[];
  /** Since the epoch: when a person asked a stalled stage to run again. */
  retries: { at: string; stage: Stage }[];
  /** Heads foreman marked ready to merge. */
  readies: string[];
  /** Heads whose decided review threads foreman has answered. */
  replied: string[];
  /** Whether the PR can merge, read once a round on its head is decided. */
  merge: Mergeability | null;
}

export type Action =
  | { kind: 'launch-build'; attempt: number; base: string; branch: string | null; feedback: string | null }
  | { kind: 'record-build'; launch: Launch; result: BuildResult | null }
  | { kind: 'launch-verify'; attempt: number; sha: string }
  | { kind: 'request-review'; sha: string }
  | { kind: 'launch-feedback'; attempt: number; sha: string; run: string | null }
  | { kind: 'record-feedback'; launch: Launch; result: FeedbackResult | null }
  | { kind: 'report'; evidence: Evidence }
  | { kind: 'ready'; sha: string }
  | { kind: 'close-pr' }
  | { kind: 'post-replies'; sha: string; file: string }
  | { kind: 'notice'; code: string; text: string };

export interface Decision {
  key: string;
  state: string;
  detail: string;
  actions: Action[];
  /** The dashboard page where a person decides or follows this state, when there is one. */
  gate?: string;
}

export interface Limits {
  /** Minutes after a head's first verify launch that the round stops waiting for checks still running. */
  roundTimeoutMinutes: number;
}
