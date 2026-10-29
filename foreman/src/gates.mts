// A gate as the dashboard shows and saves it: shown from the last tick and the archive's files, without asking Jira or
// GitHub anything, and saved to Jira first (the decided document attached, then the `[sdlc] decided` comment the tick acts
// on), then to the archive. Foreman decides only from Jira, so a lost archive loses no decision.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { questionsDir, roundDir } from './archive.mts';
import { HOME } from './config.mts';
import type { Jira } from './jira.mts';
import { decidedComment, retryComment } from './ledger.mts';
import { fromDecision, LABEL, needsCommit, nextOf, problemsFile, repliesOf, type Next } from './round.mts';
import { readForm, type Audit, type DecidedItem, type Evidence, type GateView } from './round-page.mts';
import type { FeedbackItem, Mergeability, Stage } from './types.mts';

/** What the last tick knows about the issue: a gate page shows from it and the archive, and asks nobody. */
export interface Row {
  key: string;
  summary: string;
  url: string;
  pr: string | null;
  head?: string | null;
  merge?: Mergeability | null;
  nextBuild?: number;
}

const readJson = <T,>(file: string): T | null => (existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as T) : null);

/** A decided document: foreman's copy of the gate's items with the person's decisions, and when and what was decided. */
interface DecidedDoc {
  decided?: { at: string; next: Next };
  items: DecidedItem[];
}

const prOf = (row: Row) => (row.pr ? { number: Number(row.pr.split('/').pop()), url: row.pr } : null);

/** The issue's rounds, oldest first: a round's number is its place here. */
const rounds = (key: string) => {
  const dir = join(HOME, 'archive', key, 'rounds');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((sha) => existsSync(join(dir, sha, 'feedback.json')))
    .map((sha) => ({ sha, at: statSync(join(dir, sha, 'feedback.json')).mtimeMs }))
    .sort((a, b) => a.at - b.at)
    .map((r) => r.sha);
};

/** The verification run of a head, as the launcher named it in the archive: the latest one. */
const runOf = (key: string, sha: string) => {
  const dir = join(HOME, 'archive', key, 'verify');
  return existsSync(dir)
    ? (readdirSync(dir)
        .filter((n) => n.endsWith(`-${sha.slice(0, 7)}`))
        .sort()
        .pop() ?? null)
    : null;
};

/** A round's gate: its feedback, the verification run's evidence, what was decided, and the round before. */
export const loadRound = (row: Row, sha: string): GateView => {
  const dir = roundDir(row.key, sha);
  const feedback = readJson<{ items: FeedbackItem[] }>(join(dir, 'feedback.json'));
  if (!feedback) throw new Error(`${row.key} has no round on ${sha.slice(0, 7)} in the archive`);
  const decided = readJson<DecidedDoc>(join(dir, 'feedback-decided.json'));
  const run = runOf(row.key, sha);
  const runDir = run ? join(HOME, 'archive', row.key, 'verify', run) : null;
  const shas = rounds(row.key);
  const n = shas.indexOf(sha) + 1;
  const prevSha = shas[n - 2];
  const prevItems = prevSha
    ? (
        readJson<DecidedDoc>(join(roundDir(row.key, prevSha), 'feedback-decided.json')) ??
        readJson<DecidedDoc>(join(roundDir(row.key, prevSha), 'feedback.json'))
      )?.items
    : null;
  return {
    kind: 'round',
    key: row.key,
    summary: row.summary,
    url: row.url,
    pr: prOf(row),
    n,
    sha,
    head: row.head ?? null,
    readAt: new Date(statSync(join(dir, 'feedback.json')).mtimeMs).toISOString(),
    run,
    items: feedback.items,
    decided: decided?.decided ? { ...decided.decided, items: decided.items } : null,
    evidence: runDir ? readJson<Evidence>(join(runDir, 'evidence.json')) : null,
    audit: runDir ? readJson<Audit>(join(runDir, 'audit.json')) : null,
    previous: prevItems ? { n: n - 1, items: prevItems } : null,
    merge: row.merge ?? null,
    nextBuild: row.nextBuild ?? 1,
    base: `/round/${row.key}/${sha}`,
    respec: decided?.decided?.next === 'respec' ? respecOf(row, join(dir, 'problems.md')) : null,
    error: null,
  };
};

/** A build's questions, and what was decided on them. */
export const loadQuestions = (row: Row, build: number): GateView => {
  const dir = questionsDir(row.key, build);
  const doc = readJson<{ commit: string | null; items: FeedbackItem[] }>(join(dir, 'questions.json'));
  if (!doc) throw new Error(`${row.key} has no questions from build #${build} in the archive`);
  const decided = readJson<DecidedDoc>(join(dir, 'questions-decided.json'));
  return {
    kind: 'questions',
    key: row.key,
    summary: row.summary,
    url: row.url,
    pr: prOf(row),
    n: build,
    sha: doc.commit ?? 'none',
    head: null,
    readAt: null,
    run: null,
    items: doc.items,
    decided: decided?.decided ? { ...decided.decided, items: decided.items } : null,
    evidence: null,
    audit: null,
    previous: null,
    merge: null,
    nextBuild: row.nextBuild ?? 1,
    base: `/questions/${row.key}/${build}`,
    respec: decided?.decided?.next === 'respec' ? respecOf(row, join(dir, 'problems.md')) : null,
    error: null,
  };
};

const respecOf = (issue: { url: string }, file: string) => ({ file, command: `/sdlc:spec revise ${issue.url} --problems ${file}` });

/**
 * Saves a person's decisions on an open gate: Jira first, so a failure leaves the gate open to save again, then the archive.
 * Refuses a gate already decided, and a round whose head is no longer the PR's.
 */
export const saveGate = async (jira: Jira, v: GateView, form: URLSearchParams) => {
  if (v.decided) throw new Error('This gate is already decided.');
  const { decisions, abandon, sha } = readForm(v.items, form);
  if (sha !== v.sha) throw new Error('The page is about another commit: reload it.');
  if (v.kind === 'round' && v.head !== v.sha) throw new Error(`This round is outdated: the PR's head is now ${v.head?.slice(0, 7) ?? 'gone'}.`);
  const items: DecidedItem[] = v.items.map((it) => (decisions[it.item] ? { ...it, decision: decisions[it.item] } : it));
  const list = Object.entries(decisions).map(([item, d]) => ({ item, ...d }));
  const next = nextOf(list, abandon);
  const dir = v.kind === 'round' ? roundDir(v.key, v.sha) : questionsDir(v.key, v.n);
  const name = v.kind === 'round' ? 'feedback-decided.json' : 'questions-decided.json';
  const file = join(dir, name);
  mkdirSync(dir, { recursive: true });
  const doc = { commit: v.sha, pr: v.pr?.url, decided: { at: new Date().toISOString(), next }, items };
  writeFileSync(`${file}.tmp`, JSON.stringify(doc, null, 2) + '\n');
  const files = [{ name: `sdlc-${v.kind}-${v.kind === 'round' ? v.sha.slice(0, 7) : `build-${v.n}`}-decided.json`, path: `${file}.tmp` }];
  if (next === 'respec') {
    writeFileSync(join(dir, 'problems.md'), problemsFile(v.key, items));
    files.push({ name: `sdlc-${v.kind}-${v.kind === 'round' ? v.sha.slice(0, 7) : `build-${v.n}`}-problems.md`, path: join(dir, 'problems.md') });
  }
  const [attachment] = await jira.attach(v.key, files);
  const lines = [
    ...items.filter((it) => it.decision).map((it) => `- ${it.item}: ${LABEL[fromDecision(it.decision!)]}${it.decision!.hint ? ` — ${it.decision!.hint}` : ''}`),
    ...(abandon ? ['Abandon.'] : []),
  ];
  const record = {
    gate: v.kind,
    sha: v.sha,
    ...(v.kind === 'questions' ? { build: v.n } : {}),
    next,
    commit: needsCommit(list),
    replies: repliesOf(list).length,
    file,
    attachment,
  };
  await jira.comment(v.key, decidedComment(record, lines.length ? lines : ['Nothing to decide.']));
  renameSync(`${file}.tmp`, file);
  return next;
};

/** A stalled stage runs again at the next tick. */
export const retry = (jira: Jira, key: string, stage: Stage) => jira.comment(key, retryComment(stage, 'A person on the dashboard'));

/** Abandons an issue from a card that has no gate (a stalled stage): the tick closes its PR and starts nothing more. */
export const abandon = (jira: Jira, key: string, sha: string) =>
  jira.comment(key, decidedComment({ gate: 'round', sha, next: 'abandon', commit: false, replies: 0 }, ['Abandon.']));
