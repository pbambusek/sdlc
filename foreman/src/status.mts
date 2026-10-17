// The tick's view of every feature: a terminal table, and a static page each tick rewrites. The page is a board: what
// needs a person, each feature's rounds, the journal's activity, recent runs and done features. History comes from the
// ledger rows, the archive, the journal and a small index of the features each tick saw; nothing decides from any of it.
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadRuns, type Run } from './archive.mts';
import { HOME, type Config } from './config.mts';
import { readJournal, type Activity, type Journal, type Quiet, type Step } from './history.mts';
import { journalPath } from './journal.mts';
import { agentState } from './launchd.mts';
import { byFeature, runSeconds, totals, type FeatureStats } from './stats.mts';
import type { Spent, TickResult } from './tick.mts';
import { fmtDuration, fmtTokens, fmtUsd, type Price } from './usage.mts';

export const lastTickPath = () => join(HOME, 'last-tick.json');
export const statusPagePath = () => join(HOME, 'status.html');
/** Every feature a saved tick has seen, as it last saw it: the page's Done section, once a feature leaves the JQL. */
export const featuresPath = () => join(HOME, 'features.json');

type Row = TickResult['decisions'][number];
interface Seen {
  summary: string;
  url: string;
  pr: string | null;
  state: string;
  steps: Step[];
  first: string;
  last: string;
}

export const saveTick = (r: TickResult, config: Config) => {
  mkdirSync(HOME, { recursive: true });
  writeFileSync(lastTickPath(), JSON.stringify(r, null, 2) + '\n');
  const seen = remember(r);
  writeFileSync(statusPagePath(), page(r, gather(r, config, seen)));
};

export const loadLastTick = (): TickResult | null => (existsSync(lastTickPath()) ? JSON.parse(readFileSync(lastTickPath(), 'utf8')) : null);

// Metrics are for people: a broken index, archive or journal must never fail a tick, only leave its section out.
const attempt = <T,>(fn: () => T): T | null => {
  try {
    return fn();
  } catch {
    return null;
  }
};

const remember = (r: TickResult): Record<string, Seen> => {
  const seen: Record<string, Seen> = attempt(() => JSON.parse(readFileSync(featuresPath(), 'utf8'))) ?? {};
  for (const d of r.decisions) {
    seen[d.key] = { summary: d.summary, url: d.url, pr: d.pr, state: d.state, steps: d.steps ?? [], first: seen[d.key]?.first ?? r.at, last: r.at };
  }
  attempt(() => writeFileSync(featuresPath(), JSON.stringify(seen, null, 2) + '\n'));
  return seen;
};

/** The end of the journal: it is never rotated, and the page needs only the last day or so. */
const journalTail = (bytes = 512 * 1024) => {
  const fd = openSync(journalPath(), 'r');
  try {
    const size = fstatSync(fd).size;
    const buf = Buffer.alloc(Math.min(bytes, size));
    readSync(fd, buf, 0, buf.length, size - buf.length);
    const text = buf.toString('utf8');
    return size > bytes ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    closeSync(fd);
  }
};

interface Done {
  key: string;
  summary: string;
  url: string;
  pr: string | null;
  state: string;
  last: string;
  steps: Step[];
  stats: FeatureStats | undefined;
}

interface Extra {
  tookSeconds: number;
  agent: ReturnType<typeof agentState> | null;
  journal: Journal | null;
  runs: Run[] | null;
  prices: Record<string, Price>;
  done: Done[];
  issueUrl: (key: string) => string;
}

const gather = (r: TickResult, config: Config, seen: Record<string, Seen>): Extra => {
  const runs = attempt(() => loadRuns());
  const stats = runs ? byFeature(runs, config.prices) : [];
  const current = new Set(r.decisions.map((d) => d.key));
  const keys = new Set([...Object.keys(seen), ...stats.map((s) => s.key)].filter((k) => !current.has(k)));
  const issueUrl = (key: string) => seen[key]?.url ?? `${config.jira.baseUrl}/browse/${key}`;
  const done = [...keys]
    .map((key): Done => {
      const s = stats.find((x) => x.key === key);
      const x = seen[key];
      return {
        key,
        summary: x?.summary ?? '',
        url: issueUrl(key),
        pr: x?.pr ?? null,
        state: x?.state ?? '',
        last: x?.last ?? s?.last ?? '',
        steps: x?.steps ?? [],
        stats: s,
      };
    })
    .sort((a, b) => b.last.localeCompare(a.last));
  return {
    tookSeconds: Math.round((Date.now() - Date.parse(r.at)) / 100) / 10,
    agent: attempt(agentState),
    journal: attempt(() => readJournal(journalTail(), Date.now())),
    runs,
    prices: config.prices,
    done,
    issueUrl,
  };
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

// ---- page

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const link = (url: string | null, text: string) => (url ? `<a href="${esc(url)}">${esc(text)}</a>` : esc(text));
const prLink = (url: string | null) => (url ? link(url, `#${url.split('/').pop()}`) : '');
const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
/** A time the page's script keeps current: `3 min ago`, with the moment on hover. */
const when = (iso: string) => `<time datetime="${esc(iso)}" data-ago title="${esc(iso)}">${esc(iso)}</time>`;
/** A moment in the viewer's local time, filled in by the page's script. */
const at = (iso: string, style: 'time' | 'date' | 'datetime' = 'datetime') =>
  `<time datetime="${esc(iso)}" data-at="${style}">${esc(iso.slice(0, 16).replace('T', ' '))}</time>`;

/** Where a feature sits on the board, from its state. */
const group = (state: string) =>
  ['parked', 'parking', 'approval invalid', 'pr closed', 'no repo'].includes(state) || state.endsWith('waiting for input')
    ? 'needs'
    : state === 'ready for review' || state === 'merged'
      ? 'ready'
      : state === 'waiting for approval'
        ? 'approval'
        : state.startsWith('build') || state === 'recording build'
          ? 'building'
          : 'round';

/** Why a feature needs a person, and what to do, or null when it does not. */
const needs = (d: Row): { why: string; todo: string; ok?: boolean } | null => {
  const s = d.state;
  if (s === 'parked' || s === 'parking') {
    const why = d.steps?.filter((x) => x.kind === 'park').at(-1)?.note || d.detail.split('\n')[0]!;
    return { why: s === 'parking' ? d.detail.split('\n')[0]! : why, todo: 'Remove the sdlc-parked label to continue.' };
  }
  if (s.endsWith('waiting for input')) return { why: `${d.detail} is waiting for permission.`, todo: `Attach to the session: claude attach <id>.` };
  if (s === 'approval invalid') return { why: d.detail, todo: 'Fix the approval in Jira.' };
  if (s === 'pr closed') return { why: 'The pull request was closed without merging.', todo: 'Reopen it, or remove the sdlc label.' };
  if (s === 'no repo') return { why: d.detail, todo: 'Add the project under repos in ~/.sdlc/config.json.' };
  if (s === 'ready for review') return { why: 'Verify, CI and review are clean on the head.', todo: 'Review and merge the pull request.', ok: true };
  if (s === 'merged') return { why: 'The pull request is merged.', todo: 'Resolve the issue in Jira to take it off the board.', ok: true };
  return null;
};

const SYMBOL: Record<string, string> = {
  built: '✓',
  passed: '✓',
  clean: '✓',
  failed: '✗',
  blocked: '⊘',
  invalid: '⊘',
  fix: '↻',
  asked: '?',
  none: '–',
  ended: '…',
};
const GOOD = new Set(['passed', 'clean']);
const BAD = new Set(['failed', 'blocked', 'invalid', 'asked', 'none', 'parked']);

const chip = (s: Step) => {
  if (s.outcome === 'running') return `<span class="chip run" title="running now">${esc(s.label)} running…</span>`;
  if (s.kind === 'park') return `<span class="chip bad" title="${esc(s.note ?? '')}">⏸ parked</span>`;
  if (s.kind === 'unpark') return `<span class="chip ev">unparked</span>`;
  if (s.kind === 'review') return `<span class="chip ev">review requested</span>`;
  const word = s.kind === 'build' && s.outcome === 'built' ? '' : ` ${s.outcome === 'ended' ? 'ended, not recorded' : s.outcome}`;
  const cls = GOOD.has(s.outcome) ? 'ok' : BAD.has(s.outcome) ? 'bad' : '';
  return `<span class="chip ${cls}" title="${esc(`${s.kind} ${s.outcome}${s.sha ? ` on ${s.sha.slice(0, 7)}` : ''}`)}">${esc(s.label)} ${SYMBOL[s.outcome] ?? ''}${esc(word)}</span>`;
};
const chips = (steps: Step[] | undefined) =>
  steps?.length ? `<span class="chips">${steps.map(chip).join('<span class="arrow">→</span>')}</span>` : '<span class="muted">no runs yet</span>';

const spentCell = (s: Spent | undefined) => {
  if (!s || (!s.live && !s.builds && !s.verifies)) return '';
  const live = s.live ? `<br><span class="live">running: ${fmtUsd(s.live.usd)}, ${fmtDuration(s.live.seconds)} so far</span>` : '';
  return `<span class="num">${fmtUsd(s.usd)}</span><br><span class="detail">${fmtTokens(s.tokens)} tokens, ${fmtDuration(s.seconds)}</span>${live}`;
};

const stepName = (s: Step) => (s.kind === 'build' ? `build #${s.label.slice(1)}` : `${s.kind}${s.sha ? ` ${s.sha.slice(0, 7)}` : ''}`);

const runsTable = (d: Row) => {
  const rows = (d.steps ?? []).map((s) =>
    s.kind === 'park' || s.kind === 'unpark' || s.kind === 'review'
      ? `<tr><td class="num">${at(s.at)}</td><td colspan="5" class="muted">${s.kind === 'park' ? `parked${s.note ? `: ${esc(s.note)}` : ''}` : s.kind === 'unpark' ? 'unparked: a new epoch, every limit but the build limit starts again' : `review requested on ${esc(s.sha?.slice(0, 7) ?? '')}`}</td></tr>`
      : `<tr><td class="num">${at(s.at)}</td><td>${esc(stepName(s))}</td><td>${chip(s)}</td><td class="r num hide-s">${s.turns ?? ''}</td><td class="r num">${s.seconds ? fmtDuration(s.seconds) : ''}</td><td class="r num">${s.usd != null ? fmtUsd(s.usd) : ''}</td></tr>`,
  );
  return `<div class="scroll"><table><thead><tr><th>Started</th><th>Run</th><th>Outcome</th><th class="r hide-s">Turns</th><th class="r">Time</th><th class="r">Cost</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>
<div class="note">Now: ${esc([d.detail, ...d.done].filter(Boolean).join('; '))}. <code>foreman stats ${esc(d.key)}</code> has every run's tokens and tools.</div>`;
};

const healthLine = (r: TickResult, x: Extra) => {
  const a = x.agent;
  const launchd = !a
    ? ''
    : a.loaded
      ? `<span>launchd <b class="${a.lastExit ? 'warn' : ''}">loaded, last exit ${a.lastExit ?? '–'}</b>${a.every ? `, every ${fmtDuration(a.every)}` : ''}</span>`
      : `<span class="warn">launchd not loaded: ticks run only by hand (<code>foreman install</code>)</span>`;
  const j = x.journal;
  const day = j
    ? `<span>24 h: <b>${j.ticks24h}</b> ticks, <b>${j.actions24h}</b> actions, <b class="${j.errors24h ? 'warn' : ''}">${plural(j.errors24h, 'error')}</b></span>`
    : '';
  const errors = r.errors.length
    ? `<div class="banner">This tick had ${plural(r.errors.length, 'error')}:<ul>${r.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>`
    : '';
  return `<div class="banner" id="stale" hidden data-every="${a?.loaded ? (a.every ?? 300) : 0}" data-at="${esc(r.at)}"></div>${errors}
<div class="health"><span>Last tick <b>${when(r.at)}</b> (${at(r.at, 'time')}, ${x.tookSeconds} s${r.dryRun ? ', dry run' : ''})</span>${launchd}${day}</div>`;
};

const needsSection = (r: TickResult) => {
  const xs = r.decisions.map((d) => ({ d, n: needs(d) })).filter((x) => x.n);
  const body = xs.length
    ? `<div class="needs">${xs
        .map(
          ({
            d,
            n,
          }) => `<div class="card ${n!.ok ? 'ready' : ''}"><div class="top"><span>${link(d.url, d.key)} <span class="muted">${esc(d.summary)}</span></span><span class="${n!.ok ? 'ready' : 'parked'}">${esc(d.state)}</span></div>
<div class="why">${esc(n!.why)}</div><div class="todo">→ ${esc(n!.todo)}${d.pr ? ` · PR ${prLink(d.pr)}` : ''}</div></div>`,
        )
        .join('')}</div>`
    : `<div class="quiet">Nothing needs you. ${r.decisions.length ? `${plural(r.decisions.length, 'feature')} in flight; the tick carries on.` : 'No issue matches the JQL.'}</div>`;
  return `<h2>Needs you ${xs.length ? `<span class="count">${xs.length}</span>` : ''}</h2>${body}`;
};

const spendSection = (r: TickResult, x: Extra) => {
  const s = r.spend;
  if (!s) return '';
  const tile = (label: string, t: { usd: number; runs: number; seconds: number }) =>
    `<div class="tile"><div class="label">${label}</div><div class="value">${fmtUsd(t.usd)}</div><div class="detail">${plural(t.runs, 'run')}, ${fmtDuration(t.seconds)}</div></div>`;
  let chart = '';
  if (x.runs) {
    const days = [...Array(14)].map((_, i) => {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - 13 + i);
      return d;
    });
    const usd = days.map((d, i) => {
      const end = days[i + 1] ?? new Date(d.getTime() + 86400e3);
      return totals(
        x.runs!.filter((r) => r.at >= d.toISOString() && r.at < end.toISOString()),
        x.prices,
      ).usd;
    });
    const max = Math.max(...usd, 0.01);
    const label = (d: Date) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    const bars = usd
      .map(
        (v, i) =>
          `<span class="b" tabindex="0" data-tip="${label(days[i]!)}: ${v ? fmtUsd(v) : 'no runs'}"><i style="height:${((v / max) * 100).toFixed(1)}%"></i></span>`,
      )
      .join('');
    chart = `<div class="chart"><div class="label">Cost per day, last 14 days</div><div class="bars">${bars}</div><div class="axis"><span>${label(days[0]!)}</span><span>today</span></div></div>`;
  }
  return `<h2>Spend</h2><div class="money"><div class="tiles">${tile('Today', s.today)}${tile('Last 7 days', s.week)}${tile('All time', s.all)}</div>${chart}</div>
<div class="note">Finished runs from the archive at list price; <code>foreman stats</code> breaks it down.</div>`;
};

const COLUMNS: [string, string][] = [
  ['approval', 'Approval'],
  ['building', 'Building'],
  ['round', 'In round'],
  ['needs', 'Needs you'],
  ['ready', 'Ready for review'],
  ['done', 'Done · 7 days'],
];

const featuresSection = (r: TickResult, x: Extra) => {
  const rows = r.decisions
    .map((d) => {
      const g = group(d.state);
      const cls = g === 'needs' ? 'parked' : g === 'ready' ? 'ready' : '';
      return `<tr class="feature" data-key="${esc(d.key)}" tabindex="0" aria-expanded="false"><td><span class="caret">▸</span>${link(d.url, d.key)}<br><span class="detail">${esc(d.summary)}</span></td>
<td class="${cls}">${esc(d.state)}</td><td class="c-chips">${chips(d.steps)}</td><td>${prLink(d.pr)}</td><td>${spentCell(d.spent)}</td></tr>
<tr class="runs" data-for="${esc(d.key)}" hidden><td colspan="5">${d.steps?.length ? runsTable(d) : `<span class="muted">${esc(d.detail)}</span>`}</td></tr>`;
    })
    .join('\n');
  const list = `<table class="features"><thead><tr><th>Issue</th><th>State</th><th>Rounds</th><th>PR</th><th>Spent</th></tr></thead><tbody>
${rows || '<tr><td colspan="5" class="muted">No issue matches the JQL.</td></tr>'}</tbody></table>
<div class="note">Click a row for its runs. ✓ built / passed / clean · ✗ failed · ⊘ blocked or invalid · ↻ fix requested · ? asked · … ended, not recorded yet.</div>`;

  const weekAgo = new Date(Date.now() - 7 * 86400e3).toISOString();
  const card = (
    d: Row,
  ) => `<div class="card"><div>${link(d.url, d.key)}${d.pr ? ` <span class="muted">· ${prLink(d.pr)}</span>` : ''}</div><div class="detail">${esc(d.summary)}</div>${chips(d.steps)}
<div class="small">${esc(d.detail.split('\n')[0]!)}${d.spent?.usd ? ` · ${fmtUsd(d.spent.usd)}` : ''}</div></div>`;
  const doneCard = (
    f: Done,
  ) => `<div class="card"><div>${link(f.url, f.key)} <span class="muted">${esc(f.state || 'archived')}</span></div><div class="detail">${esc(f.summary)}</div>
<div class="small">left ${at(f.last, 'date')}${f.stats ? ` · ${fmtUsd(f.stats.usd)}` : ''}</div></div>`;
  const board = `<div class="board">${COLUMNS.map(([g, name]) => {
    const items = g === 'done' ? x.done.filter((f) => f.last >= weekAgo).map(doneCard) : r.decisions.filter((d) => group(d.state) === g).map(card);
    return `<div class="col"><h3>${name} ${items.length}</h3>${items.join('') || '<div class="small muted">none</div>'}</div>`;
  }).join('')}</div>`;

  return `<h2>In flight <span class="count">${r.decisions.length}</span><span class="switch" role="group" aria-label="Layout"><button type="button" data-view="list" aria-pressed="true">List</button><button type="button" data-view="board" aria-pressed="false">Board</button></span></h2>
<div data-pane="list">${list}</div><div data-pane="board" hidden>${board}</div>`;
};

const activitySection = (x: Extra) => {
  const j = x.journal;
  if (!j) return `<h2>Activity</h2><div class="quiet">The journal (<code>${esc(journalPath())}</code>) could not be read.</div>`;
  let day = '';
  const items = j.items
    .map((a) => {
      const key = 'quiet' in a ? a.to : a.at;
      const d = key.slice(0, 10);
      const head = d !== day ? `<li class="day"><time datetime="${esc(key)}" data-at="day">${d}</time></li>` : '';
      day = d;
      if ('quiet' in a) {
        const q = a as Quiet;
        return `${head}<li class="fold" data-kind="quiet"><span class="quietline">· ${plural(q.quiet, 'tick')} with nothing to do, ${at(q.from, 'time')}–${at(q.to, 'time')}</span></li>`;
      }
      const e = a as Activity;
      return `${head}<li data-kind="${e.kind}"><span class="t">${at(e.at, 'time')}</span><span>${e.key ? link(x.issueUrl(e.key), e.key) : ''}</span><span class="${e.kind === 'error' ? 'error' : ''}">${e.kind === 'error' ? '✖ ' : ''}${esc(e.text)} <span class="src">${esc(e.run)}</span></span></li>`;
    })
    .join('');
  const errors = j.items.filter((a) => !('quiet' in a) && a.kind === 'error').length;
  const filters = ['all', 'actions', 'errors']
    .map((f) => `<button type="button" data-filter="${f}" aria-pressed="${f === 'all'}">${f}${f === 'errors' && errors ? ` ${errors}` : ''}</button>`)
    .join('');
  return `<h2>Activity <span class="filters" role="group" aria-label="Filter">${filters}</span></h2>
<ul class="feed">${items || '<li class="fold"><span class="quietline">Nothing in the journal yet.</span></li>'}</ul><div class="note">From <code>${esc(journalPath())}</code>; <code>foreman log -f</code> follows it.</div>`;
};

const runLabel = (r: Run) => (r.stage === 'verify' ? `verify ${r.sha?.slice(0, 7) ?? ''}` : `${r.stage} #${r.attempt ?? '?'}`);

const recentSection = (x: Extra) => {
  if (!x.runs) return '';
  const rows = x.runs
    .slice(-10)
    .reverse()
    .map((r) => {
      const usd = r.usage ? fmtUsd(totals([r], x.prices).usd) : '–';
      const out = GOOD.has(r.outcome) || r.outcome === 'built' ? 'ok' : BAD.has(r.outcome) ? 'bad' : '';
      return `<tr><td class="num">${at(r.at)}</td><td>${link(x.issueUrl(r.key), r.key)}</td><td>${esc(runLabel(r))} <span class="chip ${out}">${esc(r.outcome)}</span>${r.launcher && r.launcher.code !== 0 ? ` <span class="warn">exit ${r.launcher.code}</span>` : ''}</td><td class="r num">${fmtDuration(runSeconds(r))}</td><td class="r num">${usd}</td></tr>`;
    })
    .join('');
  return `<h2>Recent runs</h2><div class="scroll"><table class="compact"><thead><tr><th>Started</th><th>Issue</th><th>Run</th><th class="r">Time</th><th class="r">Cost</th></tr></thead><tbody>${rows || '<tr><td colspan="5" class="muted">Nothing archived yet.</td></tr>'}</tbody></table></div>`;
};

const doneSection = (x: Extra) => {
  if (!x.done.length) return '';
  const rows = x.done
    .map((f) => {
      const s = f.stats;
      return `<tr><td>${link(f.url, f.key)}<br><span class="detail">${esc(f.summary)}</span></td><td>${esc(f.state || 'archived')}${f.pr ? ` · ${prLink(f.pr)}` : ''}<br><span class="detail">last seen ${at(f.last, 'date')}</span></td>
<td class="hide-s">${f.steps.length ? chips(f.steps) : s ? `<span class="muted">${plural(s.builds, 'build')}, ${s.results.join(' → ') || 'no verify'}</span>` : ''}</td><td class="r num">${s ? fmtUsd(s.usd) : ''}</td><td class="r num hide-s">${s ? fmtDuration(s.seconds) : ''}</td></tr>`;
    })
    .join('');
  return `<h2>Done <span class="count">${x.done.length}</span></h2><div class="scroll"><table class="compact"><thead><tr><th>Issue</th><th>Last state</th><th class="hide-s">Rounds</th><th class="r">Cost</th><th class="r hide-s">Time</th></tr></thead><tbody>${rows}</tbody></table></div>
<div class="note">Features no longer in the JQL, from <code>${esc(featuresPath())}</code> and the archive.</div>`;
};

const STYLE = `
:root { --bg: #fff; --fg: #1a1a1a; --muted: #6b6b6b; --line: #e4e4e4; --warn: #b42318; --ok: #067647; --bar: #4a7bd0; --soft: #f6f6f6; --warn-soft: #fef3f2; }
@media (prefers-color-scheme: dark) { :root { --bg: #161616; --fg: #ececec; --muted: #9a9a9a; --line: #2e2e2e; --warn: #f97066; --ok: #47cd89; --bar: #7aa2e8; --soft: #1f1f1f; --warn-soft: #2a1715; color-scheme: dark; } }
* { box-sizing: border-box; }
body { background: var(--bg); color: var(--fg); font: 14px/1.5 -apple-system, system-ui, sans-serif; margin: 24px 16px; }
h1 { font-size: 18px; margin: 0 0 4px; } h2 { font-size: 15px; margin: 32px 0 8px; display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
h2 .count { color: var(--muted); font-weight: 400; font-size: 13px; }
.muted, .detail { color: var(--muted); } .note { color: var(--muted); margin-top: 6px; } .small { color: var(--muted); font-size: 12px; margin-top: 6px; }
a { color: inherit; } td > a:first-child, .feed a { white-space: nowrap; } code { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
table { border-collapse: collapse; width: 100%; } th, td { text-align: left; padding: 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { color: var(--muted); font-weight: 500; } .num { font-variant-numeric: tabular-nums; } td.r, th.r { text-align: right; } .scroll { overflow-x: auto; }
.parked, .warn, .error { color: var(--warn); } .ready, .ok, .live { color: var(--ok); }
.health { display: flex; flex-wrap: wrap; gap: 4px 16px; color: var(--muted); } .health b { color: var(--fg); font-weight: 500; } .health b.warn { color: var(--warn); }
.banner { border: 1px solid var(--warn); background: var(--warn-soft); color: var(--warn); border-radius: 8px; padding: 8px 12px; margin-bottom: 12px; } .banner ul { margin: 4px 0 0; padding-left: 20px; }
.needs { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; }
.card { border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; min-width: 0; }
.needs .card { border-left: 3px solid var(--warn); } .needs .card.ready { border-left-color: var(--ok); }
.card .top { display: flex; justify-content: space-between; gap: 8px; } .card .why { margin: 4px 0; } .card .todo { color: var(--muted); font-size: 13px; }
.quiet { color: var(--muted); border: 1px dashed var(--line); border-radius: 8px; padding: 10px 12px; }
.money { display: flex; flex-wrap: wrap; gap: 12px; } .tiles { display: flex; flex-wrap: wrap; gap: 12px; }
.tile { border: 1px solid var(--line); border-radius: 8px; padding: 8px 12px; min-width: 120px; }
.tile .label, .chart .label { color: var(--muted); font-size: 12px; } .tile .value { font-size: 20px; font-variant-numeric: tabular-nums; } .tile .detail { font-size: 12px; }
.chart { border: 1px solid var(--line); border-radius: 8px; padding: 8px 12px; flex: 1 1 320px; min-width: 0; }
.bars { display: flex; align-items: flex-end; gap: 2px; height: 64px; margin-top: 6px; border-bottom: 1px solid var(--line); }
.bars .b { flex: 1; display: flex; align-items: flex-end; height: 100%; position: relative; }
.bars .b i { display: block; width: 100%; background: var(--bar); border-radius: 4px 4px 0 0; }
.bars .b:hover i, .bars .b:focus i { opacity: .75; }
.bars .b:hover::after, .bars .b:focus::after { content: attr(data-tip); position: absolute; bottom: 100%; left: 50%; transform: translateX(-50%); background: var(--fg); color: var(--bg); font-size: 12px; padding: 2px 8px; border-radius: 6px; white-space: nowrap; z-index: 1; }
.bars .b:first-child:hover::after, .bars .b:first-child:focus::after { left: 0; transform: none; } .bars .b:last-child:hover::after, .bars .b:last-child:focus::after { left: auto; right: 0; transform: none; }
.axis { display: flex; justify-content: space-between; color: var(--muted); font-size: 11px; margin-top: 2px; }
.switch { display: inline-flex; border: 1px solid var(--line); border-radius: 6px; overflow: hidden; font-size: 12px; font-weight: 400; }
.switch button, .filters button { font: inherit; background: none; color: var(--muted); border: 0; padding: 2px 10px; cursor: pointer; }
.switch button[aria-pressed="true"], .filters button[aria-pressed="true"] { background: var(--soft); color: var(--fg); }
.filters { display: inline-flex; gap: 4px; font-size: 12px; font-weight: 400; } .filters button { border: 1px solid var(--line); border-radius: 999px; padding: 0 8px; }
button:focus-visible, tr.feature:focus-visible, .bars .b:focus-visible { outline: 2px solid var(--bar); outline-offset: 1px; }
tr.feature { cursor: pointer; } tr.feature:hover td { background: var(--soft); }
.caret { display: inline-block; width: 12px; color: var(--muted); } tr.feature[aria-expanded="true"] .caret { transform: rotate(90deg); }
tr.runs > td { background: var(--soft); padding: 4px 8px 12px 28px; } .runs table td, .runs table th, table.compact td, table.compact th { padding: 6px 8px; font-size: 13px; }
.chips { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.chip { font-size: 12px; border: 1px solid var(--line); border-radius: 999px; padding: 0 7px; white-space: nowrap; line-height: 20px; }
.chip.ok { border-color: var(--ok); color: var(--ok); } .chip.bad { border-color: var(--warn); color: var(--warn); } .chip.run { border-style: dashed; border-color: var(--ok); color: var(--ok); }
.chip.ev { border-style: dotted; color: var(--muted); } .arrow { color: var(--muted); font-size: 11px; }
.board { display: grid; grid-template-columns: repeat(6, minmax(200px, 1fr)); gap: 12px; overflow-x: auto; padding-bottom: 4px; }
.col h3 { font-size: 12px; color: var(--muted); font-weight: 500; margin: 0 0 8px; text-transform: uppercase; letter-spacing: .04em; }
.col .card { margin-bottom: 8px; } .col .card .chips { margin-top: 6px; }
.feed { list-style: none; margin: 0; padding: 0; } .feed li { display: grid; grid-template-columns: 52px 72px 1fr; gap: 8px; padding: 6px 0; border-bottom: 1px solid var(--line); }
.feed li.day { display: block; color: var(--muted); font-size: 12px; font-weight: 500; padding: 12px 0 4px; } .feed li.fold { display: block; }
.feed .t { color: var(--muted); font-variant-numeric: tabular-nums; } .feed .src, .feed .quietline { color: var(--muted); font-size: 12px; }
.cols2 { display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); gap: 32px; } .cols2 > div { min-width: 0; }
@media (max-width: 720px) {
  .cols2 { grid-template-columns: 1fr; gap: 0; }
  table.features thead { display: none; } table.features tr.feature { display: grid; grid-template-columns: 1fr auto; padding: 8px 0; border-bottom: 1px solid var(--line); }
  table.features tr.feature td { border: 0; padding: 2px 0; } table.features td.c-chips { grid-column: 1 / -1; }
  table.features tr.runs:not([hidden]) { display: block; } table.features tr.runs > td { display: block; padding: 4px 8px 12px; }
  .hide-s { display: none; }
  .feed li { grid-template-columns: 44px 1fr; row-gap: 0; } .feed li > span:nth-child(2), .feed li > span:nth-child(3) { grid-column: 2; }
  .board { grid-template-columns: repeat(6, 240px); }
}`;

// Keeps times current between reloads, flags a page no tick has rewritten, and remembers the view and open rows.
const SCRIPT = `
const store = { get(k, d) { try { return JSON.parse(localStorage.getItem('sdlc-status-' + k)) ?? d; } catch { return d; } }, set(k, v) { try { localStorage.setItem('sdlc-status-' + k, JSON.stringify(v)); } catch {} } };
const ago = (iso) => { const s = Math.round((Date.now() - Date.parse(iso)) / 1000); return s < 90 ? s + 's ago' : s < 5400 ? Math.round(s / 60) + ' min ago' : s < 172800 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' days ago'; };
const fmt = { time: { hour: '2-digit', minute: '2-digit' }, date: { day: 'numeric', month: 'short' }, datetime: { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }, day: { weekday: 'short', day: 'numeric', month: 'short' } };
for (const t of document.querySelectorAll('time[data-at]')) t.textContent = new Date(t.dateTime).toLocaleString('en-GB', fmt[t.dataset.at]);
const tick = () => {
  for (const t of document.querySelectorAll('time[data-ago]')) t.textContent = ago(t.dateTime);
  const b = document.getElementById('stale'), every = Number(b.dataset.every), age = (Date.now() - Date.parse(b.dataset.at)) / 1000;
  b.hidden = !(every && age > 2 * every + 60);
  if (!b.hidden) b.textContent = 'No tick for ' + ago(b.dataset.at).replace(' ago', '') + '; launchd should tick every ' + Math.round(every / 60) + ' min, so this page is out of date. Check foreman status and ~/.sdlc/launchd-stderr.log.';
};
tick(); setInterval(tick, 15000);
const view = (v) => { for (const p of document.querySelectorAll('[data-pane]')) p.hidden = p.dataset.pane !== v; for (const b of document.querySelectorAll('[data-view]')) b.setAttribute('aria-pressed', b.dataset.view === v); store.set('view', v); };
view(store.get('view', 'list'));
const open = new Set(store.get('open', []));
const show = (row, on) => { row.setAttribute('aria-expanded', on); const r = document.querySelector('tr.runs[data-for="' + row.dataset.key + '"]'); if (r) r.hidden = !on; };
for (const row of document.querySelectorAll('tr.feature')) show(row, open.has(row.dataset.key));
const toggle = (row) => { const k = row.dataset.key, on = !open.has(k); on ? open.add(k) : open.delete(k); show(row, on); store.set('open', [...open]); };
const filter = (f) => { for (const li of document.querySelectorAll('.feed li[data-kind]')) li.hidden = f === 'all' ? false : f === 'errors' ? li.dataset.kind !== 'error' : li.dataset.kind !== 'action' && li.dataset.kind !== 'notice'; for (const b of document.querySelectorAll('[data-filter]')) b.setAttribute('aria-pressed', b.dataset.filter === f); store.set('filter', f); };
filter(store.get('filter', 'all'));
document.addEventListener('click', (e) => {
  if (e.target.closest('a')) return;
  const v = e.target.closest('[data-view]'); if (v) return view(v.dataset.view);
  const f = e.target.closest('[data-filter]'); if (f) return filter(f.dataset.filter);
  const row = e.target.closest('tr.feature'); if (row) toggle(row);
});
document.addEventListener('keydown', (e) => { const row = e.target.closest?.('tr.feature'); if (row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggle(row); } });
`;

const page = (r: TickResult, x: Extra) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="60"><title>foreman</title>
<style>${STYLE}
</style></head><body>
<h1>foreman</h1>
${healthLine(r, x)}
${needsSection(r)}
${spendSection(r, x)}
${featuresSection(r, x)}
<div class="cols2"><div>${activitySection(x)}</div><div>${recentSection(x)}</div></div>
${doneSection(x)}
<div class="note" style="margin-top:32px">Rewritten by every tick; reloads every minute.</div>
<script>${SCRIPT}</script>
</body></html>
`;
