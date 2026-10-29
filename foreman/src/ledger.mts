// What the tick writes into Jira comments, and what it reads back from them and from the changelog.
import { isGood } from './round.mts';
import type {
  Approval,
  BuildOutcome,
  BuildResult,
  Decided,
  FeedbackOutcome,
  FeedbackResult,
  Launch,
  Notice,
  Report,
  Result,
  ReviewRequest,
  Stage,
} from './types.mts';

export const MARK = '[sdlc]';
export const LABELS = { optIn: 'sdlc', approved: 'sdlc-approved' } as const;

const fields = (line: string) => Object.fromEntries([...line.matchAll(/(\w+)=(\S+)/g)].map((m) => [m[1]!, m[2]!]));

// ---- writing

export const launchComment = (l: Omit<Launch, 'at'>, note: string) =>
  `${MARK} launched stage=${l.stage} attempt=${l.attempt}` +
  (l.base ? ` base=${l.base}` : '') +
  (l.sha ? ` sha=${l.sha}` : '') +
  (l.session ? ` session=${l.session}` : '') +
  (l.log ? ` log=${l.log}` : '') +
  (l.work ? ` work=${l.work}` : '') +
  (l.result ? ` result=${l.result}` : '') +
  `\n${note}`;

/** How a build ended, from its result file: the fields the tick acts on, then the questions for people. */
export const buildComment = (l: Launch, r: BuildResult | null) => {
  const head =
    `${MARK} build-result attempt=${l.attempt}` +
    (l.session ? ` session=${l.session}` : '') +
    ` outcome=${r?.outcome ?? 'none'}` +
    (r?.branch ? ` branch=${r.branch}` : '') +
    (r?.commit ? ` commit=${r.commit}` : '') +
    (r?.review ? ` review=${r.review}` : '');
  if (!r) return `${head}\nThe build ended without writing a result.`;
  const questions = (r.questions ?? []).map(
    (q, i) => `${i + 1}. ${q.about?.length ? `(${q.about.join(', ')}) ` : ''}${q.question}${q.recommended ? `\n   Recommended: ${q.recommended}` : ''}`,
  );
  if (r.outcome === 'asked') return `${head}\nThe build asked:\n${questions.join('\n')}`;
  return `${head}\nBuilt ${r.commit ?? 'nothing'}${r.review ? `: ${r.review}` : ''}`;
};

export const reportComment = (sha: string, result: Result, summary: string, files?: { evidence: string; page: string }, run?: string) =>
  `${MARK} reported sha=${sha} result=${result}` +
  (files ? ` evidence=${files.evidence} page=${files.page}` : '') +
  (run ? ` run=${run}` : '') +
  `\n${summary}`;
/** How a feedback run ended: the fields the tick acts on, then the items that need a decision, for people. The full output is attached. */
export const feedbackComment = (l: Launch, r: FeedbackResult | null, file?: string, attachment?: string) => {
  const head =
    `${MARK} feedback-result attempt=${l.attempt} sha=${l.sha}` +
    (l.session ? ` session=${l.session}` : '') +
    ` outcome=${r ? 'read' : 'none'}` +
    (file ? ` file=${file}` : '') +
    (attachment ? ` attachment=${attachment}` : '');
  if (!r) return `${head}\nThe feedback run ended without writing an output.`;
  const open = r.items.filter((x) => !isGood(x));
  const lines = [`${r.items.length} items, ${open.length} to decide.`, ...open.map((x) => `- ${x.item}: ${x.status}`)];
  return `${head}\n${lines.join('\n')}\nThe round's gate is open on the dashboard.`;
};

/** A person's decisions at a gate: the fields the tick acts on, then each decided item, for people. The decided document is attached. */
export const decidedComment = (d: Omit<Decided, 'at'>, lines: string[]) =>
  `${MARK} decided gate=${d.gate} sha=${d.sha}` +
  (d.build ? ` build=${d.build}` : '') +
  ` next=${d.next} commit=${d.commit ? 'yes' : 'no'}` +
  (d.replies ? ` replies=${d.replies}` : '') +
  (d.file ? ` file=${d.file}` : '') +
  (d.attachment ? ` attachment=${d.attachment}` : '') +
  `\n${lines.join('\n')}`;

export const retryComment = (stage: Stage, who: string) => `${MARK} retry stage=${stage}\n${who} asked for the stalled ${stage} to run again.`;
export const repliedComment = (sha: string, items: string[]) =>
  `${MARK} replied sha=${sha}\nAnswered ${items.length} review thread${items.length > 1 ? 's' : ''} with the decision's words:\n${items.map((i) => `- ${i}`).join('\n')}`;
export const readyComment = (sha: string, pr: string) => `${MARK} ready sha=${sha}\nReady to merge: ${pr} can merge with only an approval missing.`;

export const reviewComment = (sha: string, how: string) => `${MARK} review-requested sha=${sha}\n${how}`;
export const noticeComment = (code: string, text: string) => `${MARK} notice code=${code}\n${text}`;

// ---- reading

export interface Comment {
  at: string;
  text: string;
}

export const readComments = (comments: Comment[]) => {
  const launches: Launch[] = [];
  const reports: Report[] = [];
  const notices: Notice[] = [];
  const outcomes: BuildOutcome[] = [];
  const feedbacks: FeedbackOutcome[] = [];
  const reviewRequests: ReviewRequest[] = [];
  const parks: { at: string; reason: string }[] = [];
  const decisions: Decided[] = [];
  const retries: { at: string; stage: Stage }[] = [];
  const readies: string[] = [];
  const replied: string[] = [];
  for (const c of comments) {
    const first = c.text.split('\n', 1)[0]!.trim();
    if (!first.startsWith(MARK)) continue;
    const f = fields(first);
    if (first.startsWith(`${MARK} launched`) && (f.stage === 'build' || f.stage === 'verify' || f.stage === 'feedback')) {
      launches.push({
        stage: f.stage as Stage,
        at: c.at,
        attempt: Number(f.attempt ?? 1),
        base: f.base,
        sha: f.sha,
        session: f.session,
        log: f.log,
        work: f.work,
        result: f.result,
      });
    } else if (first.startsWith(`${MARK} build-result`) && f.outcome) {
      outcomes.push({
        at: c.at,
        attempt: Number(f.attempt ?? 1),
        session: f.session,
        outcome: f.outcome as BuildOutcome['outcome'],
        branch: f.branch,
        commit: f.commit,
        review: f.review?.replace(/^\[(.*?)\]\(.*\)$/, '$1'),
      });
    } else if (first.startsWith(`${MARK} reported`) && f.sha && f.result) {
      reports.push({ at: c.at, sha: f.sha, result: f.result as Result, evidence: f.evidence, page: f.page, run: f.run });
    } else if (first.startsWith(`${MARK} feedback-result`) && f.sha && f.outcome) {
      feedbacks.push({
        at: c.at,
        attempt: Number(f.attempt ?? 1),
        sha: f.sha,
        session: f.session,
        // An outcome written before items: any output was read.
        outcome: f.outcome === 'none' ? 'none' : 'read',
        file: f.file,
        attachment: f.attachment,
      });
    } else if (first.startsWith(`${MARK} decided`) && f.sha && f.next) {
      decisions.push({
        at: c.at,
        gate: f.gate === 'questions' ? 'questions' : 'round',
        sha: f.sha,
        build: f.build ? Number(f.build) : undefined,
        next: f.next as Decided['next'],
        commit: f.commit === 'yes',
        replies: Number(f.replies ?? 0),
        file: f.file,
        attachment: f.attachment,
      });
    } else if (first.startsWith(`${MARK} retry`) && (f.stage === 'build' || f.stage === 'verify' || f.stage === 'feedback')) {
      retries.push({ at: c.at, stage: f.stage });
    } else if (first.startsWith(`${MARK} replied`) && f.sha) {
      replied.push(f.sha);
    } else if (first.startsWith(`${MARK} ready`) && f.sha) {
      readies.push(f.sha);
    } else if (first.startsWith(`${MARK} review-requested`) && f.sha) {
      reviewRequests.push({ at: c.at, sha: f.sha });
    } else if (first.startsWith(`${MARK} notice`) && f.code) {
      notices.push({ at: c.at, code: f.code });
    } else if (first === `${MARK} parked`) {
      parks.push({ at: c.at, reason: c.text.split('\n')[1]?.trim() ?? '' });
    }
  }
  const byTime = <T extends { at: string }>(xs: T[]) => xs.sort((a, b) => a.at.localeCompare(b.at));
  return {
    launches: byTime(launches),
    outcomes: byTime(outcomes),
    reports: byTime(reports),
    notices: byTime(notices),
    feedbacks: byTime(feedbacks),
    reviewRequests: byTime(reviewRequests),
    parks: byTime(parks),
    decisions: byTime(decisions),
    retries: byTime(retries),
    readies,
    replied,
  };
};

export interface ChangelogEntry {
  at: string;
  accountId: string;
  who: string;
  items: { field: string; fromString: string | null; toString: string | null }[];
}

const labelSet = (s: string | null) => new Set((s ?? '').split(/\s+/).filter(Boolean));
const added = (e: ChangelogEntry, label: string) =>
  e.items.some((i) => i.field === 'labels' && labelSet(i.toString).has(label) && !labelSet(i.fromString).has(label));

/**
 * The spec is the live description, valid only when an approver added the approved label
 * and nobody has edited the description since.
 */
export const readApproval = (
  labels: string[],
  changelog: ChangelogEntry[],
  approvers: string[],
  created: string,
): { approval: Approval; epoch: string | null } => {
  const log = [...changelog].sort((a, b) => a.at.localeCompare(b.at));
  if (!labels.includes(LABELS.approved)) return { approval: { ok: false, code: 'not-approved', reason: 'not approved', since: created }, epoch: null };

  const approval = log.filter((e) => added(e, LABELS.approved)).pop();
  if (!approval) {
    const reason = `The ${LABELS.approved} label has no history: remove it and add it again.`;
    return { approval: { ok: false, code: 'approval-unknown', reason, since: created }, epoch: null };
  }
  if (!approvers.includes(approval.accountId)) {
    const reason = `${approval.who} added ${LABELS.approved} but is not on the approvers list. An approver has to add it.`;
    return { approval: { ok: false, code: 'approver-not-allowed', reason, since: approval.at }, epoch: null };
  }
  const edit = log.filter((e) => e.at > approval.at && e.items.some((i) => i.field === 'description')).pop();
  if (edit) {
    const reason = `${edit.who} edited the description after it was approved. Review it, then remove ${LABELS.approved} and add it again.`;
    return { approval: { ok: false, code: 'edited-after-approval', reason, since: edit.at }, epoch: null };
  }
  return { approval: { ok: true, at: approval.at, by: approval.who }, epoch: approval.at };
};
