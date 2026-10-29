// Starting stages on this machine and seeing which are still running.
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { HOME, type Config } from './config.mts';
import { verifyRunDir } from './evidence.mts';
import { journalPath } from './journal.mts';
import type { BuildResult, FeedbackResult, RepoConfig, Running } from './types.mts';

/** Every session the tick starts is named `sdlc:<stage> <KEY> #<attempt>`, so `claude agents` shows what it belongs to. */
/** Stages run the skills of the checkout foreman runs from, never an installed copy, so the runner and the skills always match. */
export const PLUGIN_DIR = resolve(import.meta.dirname, '../../plugins/sdlc');
/** Verify's runner: it makes the run's workspace, starts the verifier and audits it. */
export const LAUNCHER = join(import.meta.dirname, 'verify', 'launch.mts');

export const sessionName = (key: string, stage: string, attempt: number) => `sdlc:${stage} ${key} #${attempt}`;

/** Reads a session name back into its issue and stage; also the older `sdlc <KEY> <stage> #<attempt>`, for sessions started before the rename. */
const parseSessionName = (name: string | undefined): { key: string; stage: Running['stage'] } | null => {
  const m = name?.match(/^sdlc:(build|verify|feedback) (\S+) #\d+/);
  if (m) return { key: m[2], stage: m[1] as Running['stage'] };
  const old = name?.match(/^sdlc (\S+) (build|verify|feedback) #\d+/);
  return old ? { key: old[1], stage: old[2] as Running['stage'] } : null;
};

/** Where builds and feedback runs work: one detached worktree per session, owned by the tick. */
export const WORK = join(HOME, 'work');

export interface AgentSession {
  id: string;
  sessionId: string;
  name?: string;
  cwd: string;
  status?: string;
  state?: string;
}

/**
 * `state` is Claude Code's reading of the session's last message, so a turn that ends on a question reads `blocked`.
 * A `blocked` session still in its turn waits for permission; an `idle` one has ended, and its result file says how.
 */
const isRunning = (s: AgentSession) => s.state === 'working' || (s.state === 'blocked' && s.status !== 'idle');

/** Throws when Claude Code can't list its sessions: a tick that can't see them must not launch or record anything. */
export const listSessions = (): AgentSession[] =>
  JSON.parse(execFileSync('claude', ['agents', '--json', '--all'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));

/** Verify launchers are plain node processes, found by their command line. */
const verifyProcesses = (): string[] => {
  try {
    return execFileSync('ps', ['-axo', 'command='], { encoding: 'utf8' })
      .split('\n')
      .filter((l) => l.includes('launch.mts') && l.includes('--slug'));
  } catch {
    return [];
  }
};

export const runningFor = (key: string, sessions: AgentSession[], processes = verifyProcesses()): Running[] => {
  const out: Running[] = [];
  for (const s of sessions) {
    const parsed = parseSessionName(s.name);
    if (parsed?.key === key && isRunning(s)) out.push({ stage: parsed.stage, label: `${s.name} (${s.id})`, state: s.state! });
  }
  // One entry per issue: the launcher and the shell that waits for its exit both carry its command line.
  if (processes.some((p) => new RegExp(`--slug ${key}(\\s|$)`).test(p)))
    out.push({ stage: 'verify', label: `verify launcher for ${key}: foreman log ${key} -f`, state: 'running' });
  return out;
};

/** A build's result file, or null when it wrote none or not one the tick can read. */
export const readBuildResult = (path: string | undefined): BuildResult | null => {
  if (!path || !existsSync(path)) return null;
  try {
    const r = JSON.parse(readFileSync(path, 'utf8')) as BuildResult;
    return r.outcome === 'built' || r.outcome === 'asked' ? r : null;
  } catch {
    return null;
  }
};

/** A feedback run's output, or null when it wrote none or not one the tick can read. */
export const readFeedbackResult = (path: string | undefined): FeedbackResult | null => {
  if (!path || !existsSync(path)) return null;
  try {
    const r = JSON.parse(readFileSync(path, 'utf8')) as FeedbackResult;
    return ['fix', 'blocked', 'clean'].includes(r.outcome) && Array.isArray(r.findings) && Array.isArray(r.blocked) ? r : null;
  } catch {
    return null;
  }
};

/** The approved spec as one file, written once per approval: build and verify read the same text. */
export const specSnapshot = (issue: { key: string; summary: string; description: string }, approvedAt: string) => {
  const dir = join(HOME, 'runs', issue.key);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `spec-${approvedAt.replace(/[:.]/g, '-')}.md`);
  if (!existsSync(path)) writeFileSync(path, `# ${issue.summary}\n\n${issue.description}\n`);
  return path;
};

// A tick started from inside a Claude Code session must not hand that session's identity to what it launches.
const cleanEnv = (extra: Record<string, string> = {}) => {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_JOB_DIR', 'CLAUDE_CODE_SSE_PORT']) delete env[k];
  return env;
};

const git = (repo: string, ...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** The commit a build starts from: `base`, or the remote default branch's head for `none`. */
const resolveBase = (repo: string, base: string) => {
  if (base !== 'none') {
    git(repo, 'fetch', '--quiet', 'origin', base);
    return base;
  }
  const head = git(repo, 'ls-remote', '--symref', 'origin', 'HEAD').match(/^ref: refs\/heads\/(\S+)\s+HEAD$/m)?.[1];
  if (!head) throw new Error('could not find the remote default branch');
  git(repo, 'fetch', '--quiet', 'origin', head);
  return git(repo, 'rev-parse', 'FETCH_HEAD');
};

/**
 * A background Claude Code session running the build skill in a detached worktree of its own. The build never checks out
 * the PR branch: it pushes to it, so no other worktree can hold the branch it needs.
 */
export const launchBuild = (
  config: Config,
  repo: RepoConfig,
  issue: { key: string; url: string },
  build: { attempt: number; base: string; branch: string | null; spec: string; feedback: string | null },
) => {
  const session = randomUUID();
  const id = `${issue.key}-${build.attempt}-${session.slice(0, 8)}`;
  const work = join(WORK, id);
  const result = join(HOME, 'runs', issue.key, `build-${id}.json`);
  const prompt = [
    config.build.skill,
    build.spec,
    '--source',
    issue.url,
    ...(build.branch ? ['--branch', build.branch] : []),
    ...(build.feedback ? ['--feedback', build.feedback] : []),
    '--out',
    result,
    '--headless',
  ].join(' ');
  const args = ['--bg', '--plugin-dir', PLUGIN_DIR, '--session-id', session, '-n', sessionName(issue.key, 'build', build.attempt)];
  if (config.build.permissionMode) args.push('--permission-mode', config.build.permissionMode);
  if (config.build.model) args.push('--model', config.build.model);
  if (config.build.disallowedTools.length) args.push('--disallowedTools', ...config.build.disallowedTools);
  args.push('--', prompt);
  return {
    session,
    work,
    result,
    run: () => {
      mkdirSync(WORK, { recursive: true });
      git(repo.path, 'worktree', 'add', '--detach', work, resolveBase(repo.path, build.base));
      execFileSync('claude', args, { cwd: work, env: cleanEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    },
  };
};

/**
 * A background Claude Code session running the feedback skill on one commit, in a detached worktree at that commit, so it
 * reads the repo's FEEDBACK.md and CI configuration as they are there. It reads only; the worktree goes once it ends.
 */
export const launchFeedback = (
  config: Config,
  repo: RepoConfig,
  issue: { key: string },
  feedback: { attempt: number; sha: string; pr: number; spec: string; run: string | null },
) => {
  const session = randomUUID();
  const id = `${issue.key}-feedback-${feedback.attempt}-${session.slice(0, 8)}`;
  const work = join(WORK, id);
  const result = join(HOME, 'runs', issue.key, `feedback-${feedback.sha.slice(0, 7)}-${feedback.attempt}.json`);
  const prompt = [
    config.feedback.skill,
    feedback.sha,
    '--pr',
    String(feedback.pr),
    '--spec',
    feedback.spec,
    ...(feedback.run ? ['--verify', feedback.run] : []),
    '--out',
    result,
    '--headless',
  ].join(' ');
  const args = ['--bg', '--plugin-dir', PLUGIN_DIR, '--session-id', session, '-n', sessionName(issue.key, 'feedback', feedback.attempt)];
  const permissionMode = config.feedback.permissionMode ?? config.build.permissionMode;
  const model = config.feedback.model ?? config.build.model;
  if (permissionMode) args.push('--permission-mode', permissionMode);
  if (model) args.push('--model', model);
  args.push('--', prompt);
  return {
    session,
    work,
    result,
    run: () => {
      mkdirSync(WORK, { recursive: true });
      git(repo.path, 'worktree', 'add', '--detach', work, resolveBase(repo.path, feedback.sha));
      execFileSync('claude', args, { cwd: work, env: cleanEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    },
  };
};

export const removeWorktree = (repo: RepoConfig, work: string) => {
  if (existsSync(work)) git(repo.path, 'worktree', 'remove', '--force', work);
  git(repo.path, 'worktree', 'prune');
};

/** Removes every build worktree no running session works in: what a crash or an unrecorded build left behind. */
export const sweepWorktrees = (repos: RepoConfig[], sessions: AgentSession[]) => {
  const busy = new Set(sessions.filter(isRunning).map((s) => s.cwd));
  const removed: string[] = [];
  for (const repo of repos) {
    const paths = git(repo.path, 'worktree', 'list', '--porcelain')
      .split('\n')
      .filter((l) => l.startsWith('worktree '))
      .map((l) => l.slice('worktree '.length));
    for (const p of paths) {
      if (!p.startsWith(WORK + '/') || busy.has(p)) continue;
      removeWorktree(repo, p);
      removed.push(p);
    }
  }
  return removed;
};

// Waits for the launcher and writes its exit code to its log and to the journal: the tick that launched it is long gone.
const AWAIT_EXIT = `journal=$1 tag=$2 log=$3; shift 3
start=$(date +%s); node "$@"; code=$?
echo "▶ foreman: launcher exited with code $code" >&2
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [verify $tag] launcher exited with code $code after $(( $(date +%s) - start )) s; log: $log" >> "$journal"
exit $code`;

/**
 * The verify launcher as a detached process. It gets the spec snapshot as the claims, the issue URL as their source,
 * and the commit. Its output goes to a log; its run folder is in the feature's archive, named after the log.
 */
export const launchVerify = (config: Config, repo: RepoConfig, issue: { key: string; url: string }, spec: string, sha: string, attempt: number) => {
  const dir = join(HOME, 'runs', issue.key);
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const log = join(dir, `${stamp}-${sha.slice(0, 7)}-verify.log`);
  return {
    log,
    run: () => {
      git(repo.path, 'fetch', '--quiet', 'origin', sha);
      const args = [
        LAUNCHER,
        '--claims',
        spec,
        '--source',
        issue.url,
        '--slug',
        issue.key,
        '--out',
        verifyRunDir(issue.key, log),
        ...repo.verifyCopy.flatMap((c) => ['--copy', c]),
        ...(config.verify.model ? ['--model', config.verify.model] : []),
        sha,
      ];
      const fd = openSync(log, 'a');
      writeFileSync(fd, `▶ foreman: verify ${issue.key} ${sha} attempt ${attempt}\n`);
      const tag = `${issue.key} #${attempt} ${sha.slice(0, 7)}`;
      const child = spawn('/bin/sh', ['-c', AWAIT_EXIT, 'sh', journalPath(), tag, log, ...args], {
        cwd: repo.path,
        env: cleanEnv({ VERIFY_NO_OPEN: '1' }),
        detached: true,
        stdio: ['ignore', fd, fd],
      });
      child.unref();
    },
  };
};
