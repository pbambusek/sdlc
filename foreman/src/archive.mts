// A record of every stage run per feature: transcripts and verify evidence, kept past Claude Code's transcript cleanup.
// The tick writes it and never reads it to decide anything, so deleting it loses history, not correctness.
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { HOME } from './config.mts';
import { journalPath } from './journal.mts';
import { readBuildResult, readFeedbackResult, type AgentSession } from './sessions.mts';
import type { Evidence, Launch } from './types.mts';
import { sessionUsage, type Usage } from './usage.mts';

export const archiveDir = () => join(HOME, 'archive');
const featureDir = (key: string) => join(archiveDir(), key);
const projectsDir = () => join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects');

/** Where Claude Code keeps a session's transcript, while it does. */
export const findTranscript = (sessionId: string): string | null => {
  const root = projectsDir();
  if (!existsSync(root)) return null;
  for (const d of readdirSync(root)) {
    const p = join(root, d, `${sessionId}.jsonl`);
    if (existsSync(p)) return p;
  }
  return null;
};

const manifest = (key: string, entry: Record<string, unknown>) => {
  mkdirSync(featureDir(key), { recursive: true });
  appendFileSync(join(featureDir(key), 'manifest.jsonl'), JSON.stringify({ archivedAt: new Date().toISOString(), ...entry }) + '\n');
};

/** The transcript and the session's folder beside it, which holds its subagents' transcripts. */
const copyTranscript = (key: string, sessionId: string): string | null => {
  const src = findTranscript(sessionId);
  if (!src) return null;
  const dir = join(featureDir(key), 'transcripts');
  const dest = join(dir, `${sessionId}.jsonl`);
  mkdirSync(dir, { recursive: true });
  cpSync(src, dest);
  const folder = src.replace(/\.jsonl$/, '');
  if (existsSync(folder)) cpSync(folder, join(dir, sessionId), { recursive: true });
  return dest;
};

const usageOf = (transcript: string | null): Usage | null => {
  if (!transcript) return null;
  try {
    return sessionUsage(transcript);
  } catch {
    return null;
  }
};

/** Build sessions that have finished and are not archived yet. */
export const archiveSessions = (key: string, launches: Launch[], sessions: AgentSession[]) => {
  for (const l of launches) {
    if (!l.session || existsSync(join(featureDir(key), 'transcripts', `${l.session}.jsonl`))) continue;
    const s = sessions.find((x) => x.sessionId === l.session);
    if (s && s.state !== 'done') continue;
    const transcript = copyTranscript(key, l.session);
    const outcome = (l.stage === 'feedback' ? readFeedbackResult(l.result) : readBuildResult(l.result))?.outcome ?? 'none';
    if (transcript)
      manifest(key, {
        stage: l.stage,
        attempt: l.attempt,
        base: l.base,
        launchedAt: l.at,
        session: l.session,
        outcome,
        transcript,
        usage: usageOf(transcript),
      });
  }
};

/** The launcher's exit code and run time, which the shell waiting for it wrote to the journal. */
const launcherExit = (log: string) => {
  if (!existsSync(journalPath())) return null;
  const line = readFileSync(journalPath(), 'utf8')
    .split('\n')
    .findLast((l) => l.endsWith(`; log: ${log}`) && l.includes('launcher exited with code'));
  const m = line?.match(/launcher exited with code (\d+) after (\d+) s/);
  return m ? { code: Number(m[1]), seconds: Number(m[2]) } : null;
};

/** The verifier session a launcher has started, once its log names it. */
export const verifierSession = (log: string | null | undefined) =>
  log && existsSync(log) ? (readFileSync(log, 'utf8').match(/verifying headless, session ([0-9a-f-]{36})/)?.[1] ?? null) : null;

/** A reported verify run: its evidence folder, its log and the verifier's transcript. */
export const archiveVerify = (key: string, e: Evidence) => {
  const dest = join(featureDir(key), 'verify', e.dir ? basename(e.dir) : `${e.at.replace(/[:.]/g, '-')}-${e.sha.slice(0, 7)}`);
  mkdirSync(dest, { recursive: true });
  if (e.dir && existsSync(e.dir)) cpSync(e.dir, dest, { recursive: true });
  if (e.log && existsSync(e.log)) cpSync(e.log, join(dest, 'launcher.log'));
  const verifier = verifierSession(e.log);
  const transcript = verifier ? copyTranscript(key, verifier) : null;
  const launcher = e.log ? launcherExit(e.log) : null;
  manifest(key, {
    stage: 'verify',
    sha: e.sha,
    result: e.result,
    ranAt: e.at,
    evidence: dest,
    session: verifier,
    transcript,
    launcher,
    usage: usageOf(transcript),
  });
};

// ---- reading back, for stats and the dashboard

export interface Run {
  key: string;
  stage: 'build' | 'verify' | 'feedback';
  /** When it started: the session's launch, or the verify run's time. */
  at: string;
  attempt?: number;
  sha?: string;
  /** A build's or feedback run's outcome, or a verify run's result. */
  outcome: string;
  session: string | null;
  launcher?: { code: number; seconds: number } | null;
  usage: Usage | null;
}

/** Every archived run, oldest first. An entry archived before usage was recorded is read from its transcript. */
export const loadRuns = (only?: string): Run[] => {
  if (!existsSync(archiveDir())) return [];
  const runs: Run[] = [];
  for (const key of readdirSync(archiveDir())) {
    if (only && key !== only) continue;
    const file = join(archiveDir(), key, 'manifest.jsonl');
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line) continue;
      const m = JSON.parse(line);
      const transcript = m.transcript ?? null;
      runs.push({
        key,
        stage: m.stage,
        at: m.launchedAt ?? m.ranAt ?? m.archivedAt,
        attempt: m.attempt,
        sha: m.sha,
        outcome: m.outcome ?? m.result ?? '?',
        session: m.session ?? null,
        launcher: m.launcher,
        usage: m.usage ?? (transcript && existsSync(transcript) ? usageOf(transcript) : null),
      });
    }
  }
  return runs.sort((a, b) => a.at.localeCompare(b.at));
};

/** A recorded feedback output: kept under its own name, which the ledger names and the next build reads. */
export const archiveFeedback = (key: string, src: string) => {
  const dir = join(featureDir(key), 'feedback');
  mkdirSync(dir, { recursive: true });
  cpSync(src, join(dir, basename(src)));
  return basename(src);
};

export const feedbackPath = (key: string, file: string) => join(featureDir(key), 'feedback', file);
