// GitHub through the gh CLI: the build's PR and whether it can merge, its label, the sdlc/verify and sdlc/ready commit
// statuses, a head's checks, its review request, closing an abandoned PR, and answering a review thread.
import { execFileSync, spawnSync } from 'node:child_process';
import type { Mergeability, PullRequest, RepoConfig, Result } from './types.mts';

const gh = (...args: string[]) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'pipe'] });
/** A `--json` list: some gh commands print nothing, not `[]`, when nothing matches (`gh label list` since 2.10x). */
const ghList = <T,>(...args: string[]): T[] => {
  const out = gh(...args).trim();
  return out ? (JSON.parse(out) as T[]) : [];
};

export const PR_LABEL = 'sdlc';
export const STATUS_CONTEXT = 'sdlc/verify';
export const READY_CONTEXT = 'sdlc/ready';

/** The build's PR: the one on the branch its build result named. An open one wins over closed ones. */
export const findPr = (repo: RepoConfig, branch: string): PullRequest | null => {
  const prs = ghList<{ number: number; url: string; headRefName: string; headRefOid: string; state: string; createdAt: string }>(
    'pr',
    'list',
    '-R',
    repo.github,
    '--head',
    branch,
    '--state',
    'all',
    '--limit',
    '20',
    '--json',
    'number,url,headRefName,headRefOid,state,createdAt',
  );
  const mine = prs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const pick = mine.find((p) => p.state === 'OPEN') ?? mine[0];
  if (!pick) return null;
  const state = pick.state === 'OPEN' ? 'open' : pick.state === 'MERGED' ? 'merged' : 'closed';
  return { number: pick.number, url: pick.url, branch: pick.headRefName, head: pick.headRefOid, state };
};

/** The label has to exist before gh can add it, so the tick creates it in a repo that has none. */
const ensureLabel = (repo: RepoConfig) => {
  const labels = ghList<{ name: string }>('label', 'list', '-R', repo.github, '--search', PR_LABEL, '--limit', '100', '--json', 'name');
  if (!labels.some((l) => l.name === PR_LABEL)) gh('label', 'create', PR_LABEL, '-R', repo.github, '--description', 'Built by the foreman tick');
};

/** The build opens the PR; the tick marks it as one of its own. */
export const labelPr = (repo: RepoConfig, url: string) => {
  ensureLabel(repo);
  gh('pr', 'edit', url, '-R', repo.github, '--add-label', PR_LABEL);
};

const STATE: Record<Result, string> = { passed: 'success', failed: 'failure', blocked: 'failure', invalid: 'error' };

export const postStatus = (repo: RepoConfig, sha: string, result: Result, description: string) =>
  gh(
    'api',
    '-X',
    'POST',
    `repos/${repo.github}/statuses/${sha}`,
    '-f',
    `state=${STATE[result]}`,
    '-f',
    `context=${STATUS_CONTEXT}`,
    '-f',
    `description=${description.slice(0, 139)}`,
  );

/** What reports on a commit: each check run and whether it has finished, and the commit statuses still pending. The tick's own `sdlc/` statuses are left out. */
export const readChecks = (repo: RepoConfig, sha: string) => {
  const checks = gh('api', '--paginate', `repos/${repo.github}/commits/${sha}/check-runs?per_page=100`, '--jq', '.check_runs[] | {name, status}')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { name: string; status: string })
    .map((c) => ({ name: c.name, done: c.status === 'completed' }));
  const pendingStatuses = gh('api', `repos/${repo.github}/commits/${sha}/status`, '--jq', '.statuses[] | select(.state == "pending") | .context')
    .split('\n')
    .filter((c) => c && !c.startsWith('sdlc/'));
  return { checks, pendingStatuses };
};

/** The build opens a ready PR; one left a draft (an older build skill, a person) is marked ready, so code owners (a reviewer bot among them) are asked for a review. */
export const markReady = (repo: RepoConfig, url: string) => {
  const draft = gh('pr', 'view', url, '-R', repo.github, '--json', 'isDraft', '--jq', '.isDraft').trim() === 'true';
  if (draft) gh('pr', 'ready', url, '-R', repo.github);
};

/**
 * Asks for a review of the PR's head the way the repo's config says: by its trigger label, by requesting a reviewer, or both.
 * A reviewer already asked, or one that has already reviewed this head (a code owner asked when the PR went ready), is not
 * asked again; one that reviewed an earlier head is, which re-requests its review.
 */
export const requestReview = (repo: RepoConfig, url: string, sha: string) => {
  const r = repo.review;
  if (!r) return;
  if (r.label) gh('pr', 'edit', url, '-R', repo.github, '--add-label', r.label);
  if (!r.reviewer) return;
  const pr = JSON.parse(gh('pr', 'view', url, '-R', repo.github, '--json', 'reviewRequests,reviews')) as {
    reviewRequests: { login?: string; slug?: string }[];
    reviews: { author: { login: string }; commit?: { oid: string } }[];
  };
  const who = r.reviewer.toLowerCase();
  const asked = pr.reviewRequests.some((q) => (q.login ?? q.slug ?? '').toLowerCase() === who);
  const reviewed = pr.reviews.some((v) => v.author.login.toLowerCase() === who && v.commit?.oid === sha);
  if (!asked && !reviewed) gh('pr', 'edit', url, '-R', repo.github, '--add-reviewer', r.reviewer);
};

/** `sdlc/ready` on a head foreman found ready to merge; a new head has none until its own round says so. */
export const postReady = (repo: RepoConfig, sha: string) =>
  gh(
    'api',
    '-X',
    'POST',
    `repos/${repo.github}/statuses/${sha}`,
    '-f',
    'state=success',
    '-f',
    `context=${READY_CONTEXT}`,
    '-f',
    'description=Ready to merge: only an approval is missing',
  );

/** The required checks on the PR's head; `gh pr checks` exits non-zero while one fails or is pending, and prints them all the same. */
const requiredChecks = (repo: RepoConfig, pr: number): { name: string; bucket: string }[] => {
  const r = spawnSync('gh', ['pr', 'checks', String(pr), '-R', repo.github, '--required', '--json', 'name,bucket'], { encoding: 'utf8' });
  if (r.error) throw r.error;
  const out = r.stdout.trim();
  if (out.startsWith('[')) return JSON.parse(out);
  if (/no required checks/i.test(r.stderr) || r.status === 0) return [];
  throw new Error(`gh pr checks ${pr}: ${r.stderr.trim()}`);
};

/**
 * Whether GitHub would merge the PR with nothing missing but a person's approval: no conflict, up to date with its base when
 * its protection asks for it, and every required check passed on the head. foreman's own `sdlc/` statuses never count, so a
 * protection that requires `sdlc/ready` doesn't keep it from being posted. `BLOCKED` passes only when what blocks it is the
 * missing approval.
 */
export const readMerge = (repo: RepoConfig, pr: number): Mergeability => {
  const v = JSON.parse(gh('pr', 'view', String(pr), '-R', repo.github, '--json', 'mergeable,mergeStateStatus,reviewDecision,baseRefName,isDraft')) as {
    mergeable: string;
    mergeStateStatus: string;
    reviewDecision: string;
    baseRefName: string;
    isDraft: boolean;
  };
  const base = v.baseRefName;
  const no = (why: string): Mergeability => ({ ready: false, why, base });
  if (v.isDraft) return no('is a draft');
  if (v.mergeable === 'CONFLICTING' || v.mergeStateStatus === 'DIRTY') return no(`conflicts with ${base}`);
  if (v.mergeStateStatus === 'BEHIND') return no(`is behind ${base}`);
  if (v.mergeable === 'UNKNOWN' || v.mergeStateStatus === 'UNKNOWN') return no('is still being checked for conflicts by GitHub');
  const failing = requiredChecks(repo, pr).filter((c) => !c.name.startsWith('sdlc/') && c.bucket !== 'pass' && c.bucket !== 'skipping');
  if (failing.length) return no(`has required checks that have not passed: ${failing.map((c) => c.name).join(', ')}`);
  if (v.reviewDecision === 'CHANGES_REQUESTED') return no('has a review requesting changes');
  if (v.mergeStateStatus === 'BLOCKED' && v.reviewDecision !== 'REVIEW_REQUIRED') return no(`is blocked by a rule on ${base} other than an approval`);
  return { ready: true, why: 'can merge once approved', base };
};

/** An abandoned issue's PR is closed, with nothing posted on it. */
export const closePr = (repo: RepoConfig, url: string) => gh('pr', 'close', url, '-R', repo.github);

/** Answers a review thread with a person's decided words: in the thread its item names (`thread:<url of its first comment>`). */
export const postReply = (repo: RepoConfig, pr: number, item: string, body: string) => {
  const id = item.match(/#discussion_r(\d+)$/)?.[1];
  if (!id) throw new Error(`${item} names no review comment to reply to`);
  gh('api', '-X', 'POST', `repos/${repo.github}/pulls/${pr}/comments/${id}/replies`, '-f', `body=${body}`);
};
