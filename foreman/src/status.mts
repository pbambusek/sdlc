// What a tick leaves for people: the last tick, as a file the dashboard reads and as a terminal table, and a small index of
// the features each tick saw, for the history page once a feature leaves the JQL. Nothing decides from any of it.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HOME } from './config.mts';
import type { Step } from './history.mts';
import type { TickResult } from './tick.mts';

export const lastTickPath = () => join(HOME, 'last-tick.json');
/** Every feature a saved tick has seen, as it last saw it: the history page's Done table, once a feature leaves the JQL. */
export const featuresPath = () => join(HOME, 'features.json');

export interface Seen {
  summary: string;
  url: string;
  pr: string | null;
  state: string;
  steps: Step[];
  first: string;
  last: string;
}

export const saveTick = (r: TickResult) => {
  mkdirSync(HOME, { recursive: true });
  writeFileSync(lastTickPath(), JSON.stringify(r, null, 2) + '\n');
  remember(r);
};

export const loadLastTick = (): TickResult | null => (existsSync(lastTickPath()) ? JSON.parse(readFileSync(lastTickPath(), 'utf8')) : null);

// A broken index must never fail a tick, only leave the history page without it.
export const loadSeen = (): Record<string, Seen> => {
  try {
    return JSON.parse(readFileSync(featuresPath(), 'utf8'));
  } catch {
    return {};
  }
};

const remember = (r: TickResult) => {
  const seen = loadSeen();
  for (const d of r.decisions) {
    seen[d.key] = { summary: d.summary, url: d.url, pr: d.pr, state: d.state, steps: d.steps ?? [], first: seen[d.key]?.first ?? r.at, last: r.at };
  }
  try {
    writeFileSync(featuresPath(), JSON.stringify(seen, null, 2) + '\n');
  } catch {}
};

// ---- terminal

const ago = (iso: string) => {
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
};

export const table = (r: TickResult): string => {
  const rows = r.decisions.map((d) => [d.key, d.state, d.done.join('; ') || d.detail.split('\n')[0]!]);
  const head = ['ISSUE', 'STATE', 'DETAIL'];
  const w = [0, 1].map((i) => Math.max(head[i]!.length, ...rows.map((x) => x[i]!.length)));
  const line = (x: string[]) => `${x[0]!.padEnd(w[0]!)}  ${x[1]!.padEnd(w[1]!)}  ${x[2]}`;
  const out = [line(head), ...rows.map(line)];
  if (!rows.length) out.push('(no issues match the JQL)');
  for (const e of r.errors) out.push(`! ${e}`);
  return out.join('\n');
};

export const header = (r: TickResult | null, label: string) =>
  r ? `${label} ${ago(r.at)} (${r.at})${r.dryRun ? ', dry run' : ''}${r.errors.length ? `, ${r.errors.length} error(s)` : ''}` : `${label}: never`;
