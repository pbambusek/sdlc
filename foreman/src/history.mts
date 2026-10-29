// What has happened, for people: each feature's rounds from its ledger, and the activity in the journal. Pure: the
// dashboard reads them, nothing decides from them.
import type { Run } from './archive.mts';
import type { readComments } from './ledger.mts';
import { runSeconds } from './stats.mts';
import type { Running } from './types.mts';
import { cost, type Price } from './usage.mts';

/** One thing on a feature's timeline: a stage run, a review request, or a park and un-park. */
export interface Step {
  at: string;
  kind: 'build' | 'verify' | 'feedback' | 'review' | 'park' | 'unpark';
  /** `B2`, `V`, `F`, … */
  label: string;
  /** built, asked, passed, failed, blocked, invalid, fix, clean, none; `running` while it runs, `ended` once it has and is not recorded yet. */
  outcome: string;
  sha?: string;
  session?: string;
  /** From the archive, once the run is in it. */
  seconds?: number;
  usd?: number;
  turns?: number;
  /** A park's reason. */
  note?: string;
}

type Ledger = ReturnType<typeof readComments>;

/** Every stage run and park in a feature's ledger, oldest first, across epochs. */
export const timeline = (ledger: Ledger, unparks: string[], running: Running[]): Step[] => {
  const steps: Step[] = [];
  const isRunning = (stage: string) => running.some((r) => r.stage === stage);
  const lastOf = (stage: string) => ledger.launches.filter((l) => l.stage === stage).at(-1);
  const open = (stage: string, l: Ledger['launches'][number]) => (isRunning(stage) && lastOf(stage) === l ? 'running' : 'ended');

  for (const l of ledger.launches) {
    if (l.stage === 'build') {
      const o = ledger.outcomes.find((x) => x.attempt === l.attempt && x.session === l.session && x.at >= l.at);
      steps.push({ at: l.at, kind: 'build', label: `B${l.attempt}`, outcome: o?.outcome ?? open('build', l), sha: o?.commit, session: l.session });
    } else if (l.stage === 'verify') {
      const next = ledger.launches.find((x) => x.stage === 'verify' && x.sha === l.sha && x.at > l.at);
      const r = ledger.reports.find((x) => x.sha === l.sha && x.at >= l.at && (!next || x.at < next.at));
      steps.push({ at: l.at, kind: 'verify', label: 'V', outcome: r?.result ?? open('verify', l), sha: l.sha });
    } else {
      const o = ledger.feedbacks.find((x) => x.attempt === l.attempt && x.session === l.session && x.at >= l.at);
      steps.push({ at: l.at, kind: 'feedback', label: 'F', outcome: o?.outcome ?? open('feedback', l), sha: l.sha, session: l.session });
    }
  }
  for (const r of ledger.reviewRequests) steps.push({ at: r.at, kind: 'review', label: 'review', outcome: 'requested', sha: r.sha });
  for (const p of ledger.parks) steps.push({ at: p.at, kind: 'park', label: 'parked', outcome: 'parked', note: p.reason });
  for (const at of unparks) steps.push({ at, kind: 'unpark', label: 'unparked', outcome: 'unparked' });
  return steps.sort((a, b) => a.at.localeCompare(b.at));
};

/**
 * Each step's time, cost and turns from the archive. Builds and feedback runs match by session; verify runs, whose
 * verifier session the ledger never names, match the archived runs of the same commit in order.
 */
export const withRuns = (steps: Step[], runs: Run[], prices: Record<string, Price>): Step[] => {
  const used = new Set<Run>();
  return steps.map((s) => {
    const r =
      s.kind === 'verify'
        ? s.outcome !== 'running' && s.outcome !== 'ended'
          ? runs.find((x) => x.stage === 'verify' && x.sha === s.sha && !used.has(x))
          : undefined
        : s.session && (s.kind === 'build' || s.kind === 'feedback')
          ? runs.find((x) => x.session === s.session)
          : undefined;
    if (!r) return s;
    used.add(r);
    return { ...s, seconds: runSeconds(r), usd: r.usage ? cost(r.usage, prices).usd : undefined, turns: r.usage?.turns };
  });
};

// ---- the journal

export interface Activity {
  at: string;
  /** The command and its run id, and who started it: `tick 5717aa launchd`. */
  run: string;
  key: string | null;
  kind: 'action' | 'error' | 'notice';
  text: string;
}

/** Ticks in a row that did nothing, folded into one line. */
export interface Quiet {
  quiet: number;
  from: string;
  to: string;
}

export interface Journal {
  /** Newest first. */
  items: (Activity | Quiet)[];
  ticks24h: number;
  actions24h: number;
  errors24h: number;
}

// Commands people run to look, not to act: their lines are not activity.
const LOOKING = new Set(['log', 'status', 'stats', 'whoami', 'doctor', 'help']);
const KEY = /^([A-Z][A-Z0-9]*-\d+): (.*)$/;
const LINE = /^(\S+) \[(\S+) (.+?)\] (.*)$/;

/** The journal's lines as activity: what ticks did, what failed, and what launchers and people's commands reported. */
export const readJournal = (text: string, now: number, limit = 40): Journal => {
  const ticks = new Map<string, { at: string; acted: boolean }>();
  const events: (Activity & { tick?: string })[] = [];
  for (const line of text.split('\n')) {
    const m = line.match(LINE);
    if (!m) continue;
    const [, at, cmd, rest, msg] = m as unknown as [string, string, string, string, string];
    if (LOOKING.has(cmd)) continue;
    const run = `${cmd} ${rest}`;
    if (cmd === 'verify') {
      events.push({
        at,
        run,
        key: rest.split(' ')[0] ?? null,
        kind: /exited with code 0 /.test(msg) ? 'notice' : 'error',
        text: msg.replace(/; log: .*$/, ''),
      });
      continue;
    }
    if (cmd === 'tick') {
      if (msg.startsWith('start')) ticks.set(run, { at, acted: false });
      const err = msg.startsWith('! ') ? msg.slice(2) : msg.startsWith('✖ ') ? msg.slice(2) : null;
      const k = (err ?? msg).match(KEY);
      if (err !== null) events.push({ at, run, key: k?.[1] ?? null, kind: 'error', text: k ? k[2]! : err, tick: run });
      else if (k) events.push({ at, run, key: k[1]!, kind: 'action', text: k[2]!, tick: run });
      else if (msg.startsWith('removed worktree')) events.push({ at, run, key: null, kind: 'action', text: msg, tick: run });
      else continue;
      const t = ticks.get(run);
      if (t) t.acted = true;
      continue;
    }
    const k = msg.match(KEY);
    const err = msg.startsWith('✖ ');
    events.push({ at, run, key: k?.[1] ?? null, kind: err ? 'error' : 'notice', text: (k ? k[2]! : msg).replace(/^✖ /, '') });
  }

  // Chronological, with ticks that did nothing between them folded.
  const quiet = [...ticks.values()].filter((t) => !t.acted).map((t) => ({ at: t.at, quiet: true as const }));
  const all = [...events, ...quiet].sort((a, b) => a.at.localeCompare(b.at));
  const out: (Activity | Quiet)[] = [];
  for (const e of all) {
    if ('quiet' in e) {
      const prev = out.at(-1);
      if (prev && 'quiet' in prev) {
        prev.quiet++;
        prev.to = e.at;
      } else out.push({ quiet: 1, from: e.at, to: e.at });
      continue;
    }
    const { tick: _, ...a } = e;
    out.push(a);
  }

  const since = new Date(now - 86400e3).toISOString();
  const recent = events.filter((e) => e.at >= since);
  const items: (Activity | Quiet)[] = [];
  let shown = 0;
  for (const x of out.reverse()) {
    if (shown >= limit) break;
    items.push(x);
    if (!('quiet' in x)) shown++;
  }
  return {
    items,
    ticks24h: [...ticks.values()].filter((t) => t.at >= since).length,
    actions24h: recent.filter((e) => e.kind === 'action').length,
    errors24h: recent.filter((e) => e.kind === 'error').length,
  };
};
