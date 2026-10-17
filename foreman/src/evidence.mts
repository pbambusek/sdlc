// Reading a finished verify run from <repo>/.verify/<KEY>/<timestamp>-<sha7>/ into one result.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Evidence, Launch, Result } from './types.mts';

interface EvidenceJson {
  claims: { id: string; items: { status: string; reason?: string }[] }[];
}

// The same rule as the evidence page: not shown if any item is not shown, shown when every item is, blocked otherwise.
const claimStatus = (items: { status: string }[]) =>
  items.some((i) => i.status === 'not-shown') ? 'not-shown' : items.every((i) => i.status === 'shown') ? 'shown' : 'blocked';

/** The launcher names a run `<ISO time with - for :>-<sha7>`. */
const runTime = (name: string) => {
  const m = name.match(/^(\d{4}-\d\d-\d\dT\d\d)-(\d\d)-(\d\dZ)-[0-9a-f]{7}$/);
  return m ? new Date(`${m[1]}:${m[2]}:${m[3]}`).toISOString() : null;
};

export const classify = (evidence: EvidenceJson | null, audit: { clean: boolean; verdict: string } | null): { result: Result; summary: string } => {
  if (!evidence) return { result: 'invalid', summary: 'The verify run wrote no evidence.' };
  if (!audit?.clean) return { result: 'invalid', summary: audit?.verdict ?? 'The verify run has no audit.' };
  const claims = evidence.claims.map((c) => ({ id: c.id, status: claimStatus(c.items), reason: c.items.find((i) => i.status !== 'shown')?.reason }));
  if (!claims.length) return { result: 'invalid', summary: 'The verify run checked no claims.' };
  const count = (s: string) => claims.filter((c) => c.status === s).length;
  const lines = [`${count('shown')} shown, ${count('not-shown')} not shown, ${count('blocked')} blocked.`];
  for (const c of claims.filter((c) => c.status !== 'shown')) lines.push(`${c.id} ${c.status}: ${c.reason ?? ''}`);
  const result: Result = count('blocked') ? 'blocked' : count('not-shown') ? 'failed' : 'passed';
  return { result, summary: lines.join('\n') };
};

/**
 * The result of the last verify launch for `sha`: its run folder if one appeared after the launch,
 * or `invalid` when the launcher has stopped without writing one.
 */
export const findEvidence = (repoPath: string, key: string, sha: string, launch: Launch, launcherRunning: boolean): Evidence | null => {
  // The launcher copies the run folder file by file at the end; read it only once the launcher has exited.
  if (launcherRunning) return null;
  const root = join(repoPath, '.verify', key);
  const runs = existsSync(root)
    ? readdirSync(root)
        .filter((n) => n.endsWith(`-${sha.slice(0, 7)}`))
        .map((n) => ({ n, at: runTime(n) }))
        .filter((r): r is { n: string; at: string } => !!r.at && r.at >= launch.at.slice(0, 19))
        .sort((a, b) => a.at.localeCompare(b.at))
    : [];
  const run = runs.pop();
  if (!run) {
    return {
      sha,
      at: new Date().toISOString(),
      result: 'invalid',
      summary: `The verify launcher stopped without a run folder. Log: ${launch.log ?? 'none'}`,
      dir: null,
      log: launch.log ?? null,
    };
  }
  const dir = join(root, run.n);
  const read = <T,>(f: string): T | null => (existsSync(join(dir, f)) ? (JSON.parse(readFileSync(join(dir, f), 'utf8')) as T) : null);
  const { result, summary } = classify(read<EvidenceJson>('evidence.json'), read<{ clean: boolean; verdict: string }>('audit.json'));
  return { sha, at: run.at, result, summary: `${summary}\nEvidence: ${join(dir, 'evidence.html')}`, dir, log: launch.log ?? null };
};
