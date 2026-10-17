// What the archived runs add up to: per run, per feature and per period. Read-only, from the archive alone.
import type { Run } from './archive.mts';
import { addUsage, cacheHit, cost, emptyUsage, fmtDuration, fmtTokens, fmtUsd, type Price, type Usage } from './usage.mts';

/** A run's time: a verify launcher's whole run when the journal has it, else the session's wall clock. */
export const runSeconds = (r: Run) => r.launcher?.seconds ?? r.usage?.seconds ?? 0;

export interface Totals {
  runs: number;
  usage: Usage;
  seconds: number;
  usd: number;
  /** Models without a price, whose tokens the dollars leave out. */
  unpriced: string[];
}

export const totals = (runs: Run[], prices: Record<string, Price>): Totals => {
  const usage = emptyUsage();
  let seconds = 0;
  for (const r of runs) {
    if (r.usage) addUsage(usage, r.usage);
    seconds += runSeconds(r);
  }
  usage.seconds = seconds;
  const c = cost(usage, prices);
  return { runs: runs.length, usage, seconds, usd: c.usd, unpriced: c.unpriced };
};

export interface FeatureStats extends Totals {
  key: string;
  builds: number;
  verifies: number;
  /** Verify results in order, e.g. failed → passed. */
  results: string[];
  first: string;
  last: string;
}

export const byFeature = (runs: Run[], prices: Record<string, Price>): FeatureStats[] => {
  const keys = [...new Set(runs.map((r) => r.key))];
  return keys.map((key) => {
    const mine = runs.filter((r) => r.key === key);
    return {
      key,
      ...totals(mine, prices),
      builds: mine.filter((r) => r.stage === 'build').length,
      verifies: mine.filter((r) => r.stage === 'verify').length,
      results: mine.filter((r) => r.stage === 'verify').map((r) => r.outcome),
      first: mine[0]!.at,
      last: mine.at(-1)!.at,
    };
  });
};

/** `7d`, `24h` or a date. */
export const parseSince = (s: string, now = Date.now()) => {
  const m = s.match(/^(\d+)([dh])$/);
  if (m) return new Date(now - Number(m[1]) * (m[2] === 'd' ? 86400e3 : 3600e3)).toISOString();
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new Error(`--since ${s}: use 7d, 24h or a date like 2026-10-01`);
  return new Date(t).toISOString();
};

// ---- terminal tables

const grid = (head: string[], rows: string[][], right: Set<number>) => {
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (r: string[]) =>
    r
      .map((c, i) => (i === r.length - 1 ? c : right.has(i) ? c.padStart(w[i]!) : c.padEnd(w[i]!)))
      .join('  ')
      .trimEnd();
  return [line(head), ...rows.map(line)].join('\n');
};

const money = (t: Totals) => `${fmtUsd(t.usd)}${t.unpriced.length ? '*' : ''}`;
const tokens = (u: Usage) =>
  `${fmtTokens(u.tokens.input + u.tokens.cacheRead + u.tokens.cacheWrite5m + u.tokens.cacheWrite1h)} / ${fmtTokens(u.tokens.output)}`;
const pct = (n: number) => `${Math.round(n * 100)}%`;
const unpricedNote = (t: Totals) => (t.unpriced.length ? `\n* not priced, add to "prices" in the config: ${t.unpriced.join(', ')}` : '');

const topTools = (u: Usage, n = 6) =>
  Object.entries(u.tools)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([name, c]) => `${name} ${c}`)
    .join(', ');

export const featureTable = (features: FeatureStats[], all: Totals) => {
  if (!features.length) return '(nothing archived yet)';
  const rows = features.map((f) => [
    f.key,
    String(f.builds),
    String(f.verifies),
    f.results.join(' → ') || '-',
    String(f.usage.turns),
    tokens(f.usage),
    pct(cacheHit(f.usage.tokens)),
    money(f),
    fmtDuration(f.seconds),
  ]);
  const verified = features.filter((f) => f.results.length);
  const passed = verified.filter((f) => f.results.includes('passed'));
  const firstPass = verified.filter((f) => f.results[0] === 'passed');
  const passedTotals = { usd: passed.reduce((n, f) => n + f.usd, 0), seconds: passed.reduce((n, f) => n + f.seconds, 0) };
  const summary = [
    `total: ${all.runs} runs, ${all.usage.turns} turns, ${tokens(all.usage)} tokens in / out, cache hit ${pct(cacheHit(all.usage.tokens))}, ${all.usage.subagents} subagents, ${money(all)}, ${fmtDuration(all.seconds)}`,
    `features: ${features.length}, passed ${passed.length}, first-pass ${firstPass.length}/${verified.length}, builds per passed feature ${passed.length ? (passed.reduce((n, f) => n + f.builds, 0) / passed.length).toFixed(1) : '-'}` +
      (passed.length
        ? `, per passed feature ${fmtUsd(passedTotals.usd / passed.length)} and ${fmtDuration(Math.round(passedTotals.seconds / passed.length))}`
        : ''),
    `tools: ${topTools(all.usage) || '-'}`,
  ];
  return `${grid(['ISSUE', 'BUILDS', 'VERIFIES', 'RESULTS', 'TURNS', 'TOKENS IN/OUT', 'CACHE', 'COST', 'TIME'], rows, new Set([1, 2, 4, 5, 6, 7, 8]))}\n\n${summary.join('\n')}${unpricedNote(all)}`;
};

export const runTable = (runs: Run[], prices: Record<string, Price>) => {
  if (!runs.length) return '(nothing archived for it)';
  const rows = runs.map((r) => {
    const t = totals([r], prices);
    return [
      r.at.slice(0, 16).replace('T', ' '),
      r.stage + (r.attempt ? ` #${r.attempt}` : r.sha ? ` ${r.sha.slice(0, 7)}` : ''),
      r.outcome + (r.launcher && r.launcher.code !== 0 ? ` (exit ${r.launcher.code})` : ''),
      r.usage ? String(r.usage.turns) : '-',
      r.usage ? tokens(r.usage) : 'no transcript',
      r.usage ? pct(cacheHit(r.usage.tokens)) : '-',
      r.usage ? String(r.usage.subagents) : '-',
      r.usage ? money(t) : '-',
      fmtDuration(runSeconds(r)),
      r.usage ? topTools(r.usage, 4) : '',
    ];
  });
  const all = totals(runs, prices);
  return `${grid(['STARTED', 'STAGE', 'OUTCOME', 'TURNS', 'TOKENS IN/OUT', 'CACHE', 'SUBAGENTS', 'COST', 'TIME', 'TOOLS'], rows, new Set([3, 4, 5, 6, 7, 8]))}\n\ntotal: ${money(all)}, ${fmtDuration(all.seconds)}${unpricedNote(all)}`;
};
