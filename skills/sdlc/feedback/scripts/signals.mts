/**
 * Prints, as JSON, what GitHub holds about one commit: its check runs and commit statuses, the tail of each failed
 * GitHub Actions job's log, and, for the pull request whose head it is, the reviews submitted on it and every unresolved
 * review thread. It reads only, and never waits: a check still running is listed as such.
 *   node <skill dir>/scripts/signals.mts <commit> [--pr <number>] [--repo <owner/name>] [--out <file>]
 * Run it from inside the repo, with `gh` logged in to read it.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const USAGE = 'usage: signals.mts <commit> [--pr <number>] [--repo <owner/name>] [--out <file>]';
const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const args = process.argv.slice(2);
const flags = new Map<string, string>();
const positional: string[] = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  if (a.startsWith('--')) flags.set(a, args[++i] ?? fail(USAGE));
  else positional.push(a);
}
const commitArg = positional[0] ?? fail(USAGE);

// Lines kept from the end of a failed job's log: enough for a stack trace and the failing assertion,
// small enough that a dozen failed jobs still read in one pass. `fullLog` in the output fetches the rest.
const LOG_TAIL_LINES = 80;
// Characters kept of a check's own summary text: the summary is a headline, not the log.
const SUMMARY_CHARS = 2000;

const run = (cmd: string, a: string[]) => {
  try {
    return execFileSync(cmd, a, { encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    const err = e as { code?: string; stderr?: string; message: string };
    if (err.code === 'ENOENT') fail(`${cmd} is not installed; signals.mts needs it (gh: https://cli.github.com, then \`gh auth login\`).`);
    throw new Error(`${cmd} ${a.join(' ')} failed: ${(err.stderr || err.message).trim()}`);
  }
};
const gh = (...a: string[]) => run('gh', a);
const lines = (out: string) => out.split('\n').filter(Boolean).map((l) => JSON.parse(l));

try {
  gh('auth', 'status');
} catch (e) {
  fail(`gh is not logged in: ${(e as Error).message}\nRun \`gh auth login\` and try again.`);
}

const repo = flags.get('--repo') ?? gh('repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner');
let commit = commitArg;
try {
  commit = run('git', ['rev-parse', '--verify', `${commitArg}^{commit}`]);
} catch {
  if (!/^[0-9a-f]{40}$/.test(commitArg)) fail(`${commitArg} is neither a commit in this checkout nor a full sha.`);
}

const checks = lines(
  gh('api', '--paginate', `repos/${repo}/commits/${commit}/check-runs?per_page=100`, '--jq',
    '.check_runs[] | {id, name, app: .app.slug, status, conclusion, url: .html_url, title: .output.title, summary: .output.summary}'),
).map((c) => ({ ...c, summary: c.summary ? String(c.summary).slice(0, SUMMARY_CHARS) : null }));

// `sdlc/` statuses are the pipeline's own, such as sdlc/verify: feedback reads the stage itself, never its status.
const statuses = lines(
  gh('api', `repos/${repo}/commits/${commit}/status`, '--jq', '.statuses[] | {context, state, description, url: .target_url}'),
).filter((s) => !String(s.context).startsWith('sdlc/'));

const FAILED = new Set(['failure', 'timed_out', 'cancelled', 'startup_failure', 'action_required']);
for (const c of checks) {
  if (c.app !== 'github-actions' || !FAILED.has(c.conclusion)) continue;
  // For GitHub Actions, a check run's id is its job's id.
  c.fullLog = `gh run view --job ${c.id} --log-failed -R ${repo}`;
  try {
    c.logTail = gh('run', 'view', '--job', String(c.id), '--log-failed', '-R', repo).split('\n').slice(-LOG_TAIL_LINES).join('\n');
  } catch (e) {
    c.logTail = null;
    c.logError = (e as Error).message;
  }
}

const prNumber =
  flags.get('--pr')?.replace(/.*\/pull\//, '') ??
  lines(gh('api', `repos/${repo}/commits/${commit}/pulls`, '--jq', '.[] | {number, state, head: .head.sha}'))
    .sort((a, b) => Number(b.head === commit) - Number(a.head === commit) || Number(b.state === 'open') - Number(a.state === 'open'))[0]
    ?.number?.toString() ??
  // The endpoint above misses a commit whose branch was deleted or squashed; a search by sha still finds its pull request.
  lines(gh('pr', 'list', '-R', repo, '--state', 'all', '--search', commit, '--json', 'number', '--jq', '.[] | {number}'))[0]?.number?.toString();

let pullRequest = null;
if (prNumber) {
  const [owner, name] = repo.split('/');
  const pr = JSON.parse(gh('pr', 'view', prNumber, '-R', repo, '--json', 'number,url,author,headRefOid,state,isDraft,files'));
  const reviews = lines(
    gh('api', '--paginate', `repos/${repo}/pulls/${prNumber}/reviews?per_page=100`, '--jq',
      '.[] | {author: .user.login, state, commit: .commit_id, body, url: .html_url, submittedAt: .submitted_at}'),
  ).filter((r) => r.commit === commit);
  const query = `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    reviewThreads(first: 100) { nodes { isResolved isOutdated path line comments(first: 50) { nodes { author { login } body url commit { oid } } } } } } } }`;
  const threads = JSON.parse(gh('api', 'graphql', '-f', `query=${query}`, '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `number=${prNumber}`))
    .data.repository.pullRequest.reviewThreads.nodes
    .filter((t: { isResolved: boolean }) => !t.isResolved)
    .map((t: { isOutdated: boolean; path: string; line: number | null; comments: { nodes: { author: { login: string } | null; body: string; url: string; commit: { oid: string } | null }[] } }) => ({
      path: t.path,
      line: t.line,
      outdated: t.isOutdated,
      comments: t.comments.nodes.map((c) => ({ author: c.author?.login ?? null, body: c.body, url: c.url, commit: c.commit?.oid ?? null })),
    }));
  pullRequest = {
    number: pr.number,
    url: pr.url,
    // An app author reads `app/<slug>` here but signs its reviews and comments `<slug>[bot]`: use the login it comments as.
    author: pr.author?.login?.replace(/^app\/(.+)$/, '$1[bot]') ?? null,
    state: pr.state,
    draft: pr.isDraft,
    head: pr.headRefOid,
    headIsCommit: pr.headRefOid === commit,
    files: (pr.files ?? []).map((f: { path: string }) => f.path),
    reviews,
    unresolvedThreads: threads,
  };
}

const pending = [
  ...checks.filter((c) => c.status !== 'completed').map((c) => c.name),
  ...statuses.filter((s) => s.state === 'pending').map((s) => s.context),
];
const out = JSON.stringify({ repo, commit, readAt: new Date().toISOString(), pending, checks, statuses, pullRequest }, null, 2) + '\n';
const file = flags.get('--out');
if (file) writeFileSync(file, out);
else process.stdout.write(out);
