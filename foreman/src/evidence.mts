// Reading a finished verify run from the feature's archive into one result.
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { HOME } from './config.mts';
import type { Evidence, Launch, Result } from './types.mts';

interface EvidenceJson {
  claims: { id: string; items: { status: string; reason?: string }[] }[];
}

// The same rule as the evidence page: not shown if any item is not shown, shown when every item is, blocked otherwise.
const claimStatus = (items: { status: string }[]) =>
  items.some((i) => i.status === 'not-shown') ? 'not-shown' : items.every((i) => i.status === 'shown') ? 'shown' : 'blocked';

/** Only a run with no evidence is invalid. A flagged audit is a warning: the claims keep the status their evidence gives them. */
export const classify = (evidence: EvidenceJson | null, audit: { clean: boolean; verdict: string } | null): { result: Result; summary: string } => {
  if (!evidence) return { result: 'invalid', summary: 'The verify run wrote no evidence.' };
  const claims = evidence.claims.map((c) => ({ id: c.id, status: claimStatus(c.items), reason: c.items.find((i) => i.status !== 'shown')?.reason }));
  if (!claims.length) return { result: 'invalid', summary: 'The verify run checked no claims.' };
  const count = (s: string) => claims.filter((c) => c.status === s).length;
  const lines = [`${count('shown')} shown, ${count('not-shown')} not shown, ${count('blocked')} blocked.`];
  if (!audit?.clean) lines.push(`Warning: ${audit?.verdict ?? 'the verify run has no audit.'}`);
  for (const c of claims.filter((c) => c.status !== 'shown')) lines.push(`${c.id} ${c.status}: ${c.reason ?? ''}`);
  const result: Result = count('blocked') ? 'blocked' : count('not-shown') ? 'failed' : 'passed';
  return { result, summary: lines.join('\n') };
};

/** Where the tick has the launcher write a verify run: the feature's archive, named after the launch's log. */
export const verifyRunDir = (key: string, log: string) => join(HOME, 'archive', key, 'verify', basename(log).replace(/-verify\.log$/, ''));

/**
 * The result of the last verify launch for `sha`: its run folder, or `invalid` when the launcher has stopped without writing one.
 */
export const findEvidence = (key: string, sha: string, launch: Launch, launcherRunning: boolean): Evidence | null => {
  // The launcher copies the run folder file by file at the end; read it only once the launcher has exited.
  if (launcherRunning) return null;
  const dir = launch.log ? verifyRunDir(key, launch.log) : null;
  if (!dir || !existsSync(dir)) {
    return {
      sha,
      at: new Date().toISOString(),
      result: 'invalid',
      summary: `The verify launcher stopped without a run folder. Log: ${launch.log ?? 'none'}`,
      dir: null,
      log: launch.log ?? null,
    };
  }
  const read = <T,>(f: string): T | null => (existsSync(join(dir, f)) ? (JSON.parse(readFileSync(join(dir, f), 'utf8')) as T) : null);
  const { result, summary } = classify(read<EvidenceJson>('evidence.json'), read<{ clean: boolean; verdict: string }>('audit.json'));
  return { sha, at: launch.at, result, summary: `${summary}\nEvidence: ${join(dir, 'evidence.html')}`, dir, log: launch.log ?? null };
};
