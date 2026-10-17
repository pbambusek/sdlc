// GitHub through the gh CLI: the build's PR, its label, the sdlc/verify commit status, a head's checks and its review request.
import { execFileSync } from 'node:child_process';
import type { PullRequest, RepoConfig, Result } from './types.mts';

const gh = (...args: string[]) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'pipe'] });
/** A `--json` list: some gh commands print nothing, not `[]`, when nothing matches (`gh label list` since 2.10x). */
const ghList = <T,>(...args: string[]): T[] => {
  const out = gh(...args).trim();
  return out ? (JSON.parse(out) as T[]) : [];
};

export const PR_LABEL = 'sdlc';
export const STATUS_CONTEXT = 'sdlc/verify';

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
