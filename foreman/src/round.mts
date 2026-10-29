// A gate's items and the person's choices on them: which items need a decision, what each choice offers, what it becomes
// in the decided document the build reads, and what foreman does next. Pure: the tick decides from it, and the gate page
// states it before the person saves.
import type { FeedbackItem } from './types.mts';

/** What a person picks for an item; the build reads only the decision each one becomes. */
export type Choice = 'fix' | 'leave' | 'follow-up' | 'change-claim' | 'answer';

/** The decision the build reads: `fix`, `reply`, `merge` and `answer` it acts on; the others it ignores. */
export interface ItemDecision {
  do: 'fix' | 'reply' | 'merge' | 'answer' | 'leave' | 'follow-up' | 'change-claim';
  hint?: string;
}

export const LABEL: Record<Choice, string> = { fix: 'Fix', leave: 'Ignore it', 'follow-up': 'Follow up', 'change-claim': 'Change the claim', answer: 'Answer' };

export const MEANS: Record<Choice, string> = {
  fix: 'The next build fixes it; your text, if any, says how.',
  leave: 'Nothing is done about it; on a review thread, foreman replies with your text.',
  'follow-up': 'Nothing changes now; it is recorded as a follow-up, and on a review thread foreman says so there.',
  'change-claim': 'The claim is wrong: you revise the spec with the spec skill, from a problems file foreman writes, and approve it again.',
  answer: 'The next build continues with your text as the answer; empty takes the build’s recommendation.',
};

/** The fixed order of a feedback file, by name: the page shows the items the same way every round. */
const ORDER = ['claim:', 'probe:', 'review:', 'thread:', 'check:', 'audit', 'question:', 'base'];
export const rank = (name: string) => {
  const i = ORDER.findIndex((o) => name.startsWith(o));
  return i < 0 ? ORDER.length : i;
};
export const ordered = <T extends { item: string }>(items: T[]) =>
  items
    .map((it, i) => ({ it, i }))
    .sort((a, b) => rank(a.it.item) - rank(b.it.item) || a.i - b.i)
    .map((x) => x.it);

/** An item that needs no decision: what its source reports is fine as it is. */
export const isGood = (it: FeedbackItem) => {
  const kind = it.item.split(':')[0];
  if (kind === 'claim' || kind === 'probe') return it.status === 'shown';
  // foreman's own `sdlc/` statuses repeat what the round already shows: verification's result, readiness.
  if (kind === 'check') return it.item.startsWith('check:sdlc/') || (['success', 'skipped', 'neutral'].includes(it.status) && !it.rule);
  // A review's own body: an approval or a plain comment is information; its line comments are thread items of their own.
  if (kind === 'review') return it.status === 'approved' || it.status === 'commented';
  if (kind === 'audit' || kind === 'base') return it.status === 'clean';
  return false;
};

/** The choices an item offers, the default first. */
export const choicesFor = (it: FeedbackItem): Choice[] => {
  if (it.item.startsWith('question:')) return ['answer', ...(aboutClaim(it) ? (['change-claim'] as Choice[]) : [])];
  // A probe is the verifier's own finding: no claim of the spec to change.
  return it.item.startsWith('claim:') ? ['fix', 'leave', 'follow-up', 'change-claim'] : ['fix', 'leave', 'follow-up'];
};

const aboutClaim = (it: FeedbackItem) => (it.about ?? []).some((a) => a.startsWith('claim:') || /^C?\d+$/.test(a));

/** What a choice and its text become in the decided document. */
export const toDecision = (it: FeedbackItem, choice: Choice, text: string): ItemDecision => {
  const hint = text.trim();
  const h = hint ? { hint } : {};
  if (choice === 'answer') return { do: 'answer', hint: hint || it.recommended || '' };
  if (choice === 'fix') return { do: it.item === 'base' ? 'merge' : 'fix', ...h };
  // Ignoring a review thread is a reply: foreman answers it with the person's words, so feedback never reads it again.
  if (choice === 'leave') return { do: it.item.startsWith('thread:') ? 'reply' : 'leave', ...h };
  return { do: choice, ...h };
};

/** The choice a decision came from, to show an earlier round's decision. */
export const fromDecision = (d: ItemDecision): Choice => (d.do === 'reply' ? 'leave' : d.do === 'merge' ? 'fix' : (d.do as Choice));

export type Next = 'abandon' | 'respec' | 'build' | 'done';

/** A decision with the item it is on. */
export type OnItem = ItemDecision & { item: string };

/** What foreman does with a decided gate: abandon, wait for the spec to change, build, or nothing (ready once the PR can merge). */
export const nextOf = (decisions: OnItem[], abandon: boolean): Next => {
  if (abandon) return 'abandon';
  if (decisions.some((d) => d.do === 'change-claim')) return 'respec';
  if (decisions.some((d) => ['fix', 'merge', 'answer'].includes(d.do))) return 'build';
  return 'done';
};

/** Whether a build that ran on a decision must push a commit: replies alone change no code. */
export const needsCommit = (decisions: ItemDecision[]) => decisions.some((d) => ['fix', 'merge', 'answer'].includes(d.do));

/** What foreman will do next, in one line, for the page to state before the person saves. */
/**
 * The review threads foreman answers itself, with the person's words: those not fixed. The build answers the ones it fixes.
 * An empty text gets a fixed sentence, so the thread is answered and feedback skips it from then on.
 */
export const repliesOf = (decisions: OnItem[]) =>
  decisions
    .filter((d) => d.item.startsWith('thread:') && d.do !== 'fix')
    .map((d) => ({ item: d.item, body: d.hint || (d.do === 'follow-up' ? 'Noted as a follow-up.' : 'Leaving this as it is.') }));

const replyLine = (n: number) => (n ? `Foreman replies in ${n} review thread${n > 1 ? 's' : ''}. ` : '');

export const describeNext = (next: Next, decisions: OnItem[], c: { pr: number | null; nextBuild: number }) => {
  const count = (d: ItemDecision['do']) => decisions.filter((x) => x.do === d).length;
  const replies = repliesOf(decisions).length;
  if (next === 'abandon') return `Abandon: foreman closes${c.pr ? ` #${c.pr}` : ' the PR'} and starts nothing more on this issue.`;
  if (next === 'respec')
    return `Foreman writes a problems file from the ${count('change-claim')} claim${count('change-claim') > 1 ? 's' : ''} to change and shows the spec-revise command; nothing runs until the spec is approved again.`;
  if (next === 'build') {
    const parts = [
      count('fix') && `fixes ${count('fix')}`,
      count('merge') && 'merges the base branch',
      count('answer') && `continues with ${count('answer')} answer${count('answer') > 1 ? 's' : ''}`,
    ].filter(Boolean);
    return `${replyLine(replies)}Build #${c.nextBuild} ${parts.join(', ')}.`;
  }
  return `${replyLine(replies)}Nothing to build: the issue is ready to merge once GitHub would merge the PR.`;
};

/** The spec-revise problems for the items decided `change-claim`, in the shape the spec skill reads: each item with its words. */
export const problemsFile = (key: string, items: (FeedbackItem & { decision?: ItemDecision })[]) =>
  [
    `# Problems with the spec of ${key}`,
    '',
    ...items
      .filter((it) => it.decision?.do === 'change-claim')
      .flatMap((it) => [
        `## ${it.item}`,
        '',
        `- status: ${it.status}`,
        ...(it.reason ? [`- reason: ${it.reason}`] : []),
        ...(it.observed ? [`- observed: ${it.observed}`] : []),
        ...(it.link ? [`- evidence: ${it.link}`] : []),
        ...(it.decision?.hint ? [`- hint: ${it.decision.hint}`] : []),
        '',
      ]),
  ].join('\n');
