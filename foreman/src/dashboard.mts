// The dashboard's pages, in foreman's look: now (totals, what needs a person, what runs) and history (what has ended,
// the activity, spend per day). Rendered from the last tick, the archive and the journal; nothing decides from any of it.
import type { Run } from './archive.mts';
import type { Activity, Journal, Quiet, Step } from './history.mts';
import { at, esc, link, plural, prLink, TIMES, when } from './html.mts';
import type { FeatureStats } from './stats.mts';
import type { Seen } from './status.mts';
import type { TickResult, Totals } from './tick.mts';
import { fmtDuration, fmtUsd } from './usage.mts';

export type Row = TickResult['decisions'][number];

export interface Extra {
  agent: { loaded: boolean; lastExit: number | null; every: number | null } | null;
  journal: Journal | null;
  /** Cost per day, oldest first, for the last 14 days. */
  days: { day: string; usd: number }[] | null;
  seen: Record<string, Seen>;
  stats: FeatureStats[];
  journalPath: string;
  /** Gates a person has decided since the last tick: their cards say foreman is acting on them. */
  decided?: Set<string>;
}

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
const BAD = new Set(['failed', 'blocked', 'invalid', 'asked', 'none', 'parked', 'abandon']);

const chip = (s: Step) => {
  if (s.outcome === 'running') return `<span class="chip run" title="running now">${esc(s.label)} running…</span>`;
  if (s.kind === 'park') return `<span class="chip bad" title="${esc(s.note ?? '')}">⏸ parked</span>`;
  if (s.kind === 'gate') return `<span class="chip ev" title="${esc(`decided on ${s.sha?.slice(0, 7) ?? ''}`)}">${esc(s.label)} → ${esc(s.outcome)}</span>`;
  if (s.kind === 'review') return `<span class="chip ev">review requested</span>`;
  const word = s.kind === 'build' && s.outcome === 'built' ? '' : ` ${s.outcome === 'ended' ? 'ended, not recorded' : s.outcome}`;
  const cls = GOOD.has(s.outcome) ? 'ok' : BAD.has(s.outcome) ? 'bad' : '';
  return `<span class="chip ${cls}" title="${esc(`${s.kind} ${s.outcome}${s.sha ? ` on ${s.sha.slice(0, 7)}` : ''}`)}">${esc(s.label)} ${SYMBOL[s.outcome] ?? ''}${esc(word)}</span>`;
};
const chips = (steps: Step[] | undefined) =>
  steps?.length ? `<span class="chips">${steps.map(chip).join('<span class="arrow">→</span>')}</span>` : '<span class="muted">no runs yet</span>';

const fact = (text: string, cls = '') => `<span class="fact ${cls}">${text}</span>`;
const lastAt = (d: Row) => d.steps?.at(-1)?.at;

/** What a feature needs from a person, as a card of facts and what to do, or null when it needs nothing. */
const needCard = (d: Row, decided: Set<string> = new Set()): string | null => {
  const s = d.state;
  const card = (cls: string, todo: string) => {
    const last = lastAt(d);
    const facts = [
      fact(esc(d.detail.split('\n')[0]!), cls === 'merge' ? 'good' : ''),
      last ? fact(when(last)) : '',
      d.spent?.usd ? fact(fmtUsd(d.spent.usd)) : '',
    ];
    return `<div class="ncard ${cls}"><div class="top"><span>${link(d.url, d.key, 'key')} <span class="title">${esc(d.summary)}</span></span><span class="state">${esc(s)}</span></div>
<div class="facts">${facts.join('')}</div><div class="go">${todo}${d.pr ? ` ${prLink(d.pr)}` : ''}</div></div>`;
  };
  const open = (text: string) => (d.gate ? `<a class="btn" href="${esc(d.gate)}">${text}</a>` : text);
  if ((s === 'gate open' || s === 'questions') && d.gate && decided.has(d.gate)) return card('wait', 'Decided: foreman is acting on it.');
  if (s === 'gate open') return card('decide', open('Decide the round'));
  if (s === 'questions') return card('decide', open('Answer the build’s questions'));
  if (s === 'waiting for spec change') return card('unblock', open('Revise the spec, then approve it again'));
  if (s === 'stalled') {
    const stage = d.detail.split(':')[0]!;
    const sha = d.gate?.split('/').pop() ?? '';
    return card(
      'unblock',
      `<form method="post" action="/retry/${esc(d.key)}" class="inline"><input type="hidden" name="stage" value="${esc(stage)}"><button class="btn">Retry the ${esc(stage)}</button></form>` +
        `<form method="post" action="/abandon/${esc(d.key)}" class="inline" onsubmit="return confirm('Abandon ${esc(d.key)}? Foreman closes its PR and starts nothing more on it.')"><input type="hidden" name="sha" value="${esc(sha)}"><button class="btn danger">Abandon</button></form>`,
    );
  }
  if (s === 'ready to merge') return card('merge', open('Review and merge the pull request'));
  if (s === 'waiting to merge') return card('wait', d.gate ? link(d.gate, 'Open the round') : '');
  if (s.endsWith('waiting for input')) return card('wait', 'Attach to the session: <code>claude attach &lt;id&gt;</code>.');
  if (s === 'approval invalid') return card('unblock', 'Fix the approval in Jira.');
  if (s === 'pr closed') return card('unblock', 'Reopen the pull request, or remove the <code>sdlc</code> label.');
  if (s === 'no repo') return card('unblock', 'Add the project under <code>repos</code> in the config.');
  return null;
};

const topBar = (page: 'now' | 'history', r: TickResult | null, x: Extra) => {
  const a = x.agent;
  const launchd = !a
    ? ''
    : a.loaded
      ? `<span>launchd <b class="${a.lastExit ? 'warn' : ''}">loaded, last exit ${a.lastExit ?? '–'}</b>${a.every ? `, every ${fmtDuration(a.every)}` : ''}</span>`
      : `<span class="warn">launchd not loaded: ticks run only by hand (<code>foreman install</code>)</span>`;
  const j = x.journal;
  const day = j ? `<span><b class="${j.errors24h ? 'warn' : ''}">${plural(j.errors24h, 'error')}</b> in 24 h</span>` : '';
  const errors = r?.errors.length
    ? `<div class="banner">The last tick had ${plural(r.errors.length, 'error')}:<ul>${r.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>`
    : '';
  return `<div class="topbar"><h1>foreman</h1><nav class="nav"><a href="/" ${page === 'now' ? 'aria-current="page"' : ''}>Now</a><a href="/history" ${page === 'history' ? 'aria-current="page"' : ''}>History</a></nav><span class="grow"></span>
<div class="health">${r ? `<span>Last tick <b>${when(r.at)}</b></span>` : '<span class="warn">No tick yet: <code>foreman tick</code></span>'}${launchd}${day}<form method="post" action="/tick" class="inline"><button class="tickbtn" title="Run a tick now: launchd's when it is loaded, else one of the dashboard's own">Tick now</button></form></div></div>
<div class="banner" id="stale" hidden data-every="${a?.loaded ? (a.every ?? 300) : 0}" data-at="${esc(r?.at ?? '')}"></div>${errors}`;
};

const tiles = (t: Totals | undefined) => {
  if (!t) return '';
  const since = t.since ? `since ${at(t.since, 'date')}` : 'nothing archived yet';
  const runs = t.tasks.build + t.tasks.verify + t.tasks.feedback;
  const by = [plural(t.tasks.build, 'build'), `${t.tasks.verify} verify`, `${t.tasks.feedback} feedback`].join(' · ');
  return `<div class="tiles">
<div class="tile"><div class="tlabel">Spend</div><div class="value">${fmtUsd(t.usd)}</div><div class="detail">${since}, at list price</div></div>
<div class="tile"><div class="tlabel">Agent time</div><div class="value">${fmtDuration(t.seconds)}</div><div class="detail">${since}</div></div>
<div class="tile"><div class="tlabel">Tasks run</div><div class="value">${runs}</div><div class="detail">${by}</div></div></div>`;
};

const ENDED = new Set(['merged', 'pr closed', 'abandoned']);

export const nowPage = (r: TickResult | null, x: Extra) => {
  const rows = r?.decisions ?? [];
  const needs = rows.map((d) => ({ d, card: needCard(d, x.decided) })).filter((n) => n.card);
  const running = rows.flatMap((d) => (d.steps ?? []).filter((s) => s.outcome === 'running').map((s) => ({ d, s })));
  const rest = rows.filter((d) => !needCard(d, x.decided) && !running.some((x) => x.d === d) && !ENDED.has(d.state));
  const runRows = running
    .map(
      ({ d, s }) =>
        `<tr><td>${link(d.url, d.key)} <span class="muted">${esc(d.summary)}</span></td><td>${esc(s.kind)} ${esc(s.label)} <span class="muted">· <time datetime="${esc(s.at)}" data-for>${esc(s.at)}</time></span></td><td class="hide-s">${chips(d.steps)}</td><td class="r num muted">${d.spent ? fmtUsd(d.spent.usd) : ''}</td></tr>`,
    )
    .join('');
  const restRows = rest
    .map(
      (d) =>
        `<tr><td>${link(d.url, d.key)} <span class="muted">${esc(d.summary)}</span></td><td>${esc(d.state)}</td><td class="hide-s">${chips(d.steps)}</td><td>${prLink(d.pr)}</td></tr>`,
    )
    .join('');
  const body = `${topBar('now', r, x)}${tiles(r?.totals)}
<h2>Needs you <span class="count">${needs.length}</span></h2>
${needs.length ? `<div class="needs">${needs.map((n) => n.card).join('')}</div>` : `<div class="quiet">Nothing needs you.${rows.length ? ` ${plural(rows.length, 'issue')} in flight.` : ''}</div>`}
<h2>Running <span class="count">${running.length}</span></h2>
${runRows ? `<div class="scroll"><table class="runs"><tbody>${runRows}</tbody></table></div>` : '<div class="quiet">Nothing runs now.</div>'}
${restRows ? `<h2>In flight <span class="count">${rest.length}</span></h2><div class="scroll"><table class="runs"><tbody>${restRows}</tbody></table></div>` : ''}`;
  return shell('foreman', body);
};

const feed = (x: Extra) => {
  const j = x.journal;
  if (!j) return `<div class="quiet">The journal (<code>${esc(x.journalPath)}</code>) could not be read.</div>`;
  let day = '';
  const items = j.items
    .map((a) => {
      const key = 'quiet' in a ? a.to : a.at;
      const d = key.slice(0, 10);
      const head = d !== day ? `<li class="day"><time datetime="${esc(key)}" data-at="day">${d}</time></li>` : '';
      day = d;
      if ('quiet' in a) {
        const q = a as Quiet;
        return `${head}<li class="fold"><span class="src">· ${plural(q.quiet, 'tick')} with nothing to do, ${at(q.from, 'time')}–${at(q.to, 'time')}</span></li>`;
      }
      const e = a as Activity;
      return `${head}<li><span class="t">${at(e.at, 'time')}</span><span>${e.key ? esc(e.key) : ''}</span><span class="${e.kind === 'error' ? 'warn' : ''}">${e.kind === 'error' ? '✖ ' : ''}${esc(e.text)} <span class="src">${esc(e.run)}</span></span></li>`;
    })
    .join('');
  return `<ul class="feed">${items || '<li class="fold"><span class="src">Nothing in the journal yet.</span></li>'}</ul>`;
};

export const historyPage = (r: TickResult | null, x: Extra) => {
  const rows = r?.decisions ?? [];
  const current = new Set(rows.map((d) => d.key));
  const ended = [
    ...rows
      .filter((d) => ENDED.has(d.state))
      .map((d) => ({ key: d.key, url: d.url, summary: d.summary, state: d.state, pr: d.pr, steps: d.steps ?? [], last: r!.at })),
    ...Object.entries(x.seen)
      .filter(([k]) => !current.has(k))
      .map(([key, s]) => ({ key, url: s.url, summary: s.summary, state: s.state || 'left the JQL', pr: s.pr, steps: s.steps, last: s.last })),
  ].sort((a, b) => b.last.localeCompare(a.last));
  const done = ended
    .map((f) => {
      const s = x.stats.find((y) => y.key === f.key);
      const rounds = f.steps.filter((y) => y.kind === 'feedback' && y.outcome !== 'none' && y.outcome !== 'running' && y.outcome !== 'ended').length;
      const how = f.state === 'merged' ? `<span class="ok">merged</span>` : `<span class="muted">${esc(f.state)}</span>`;
      return `<tr><td>${link(f.url, f.key)}<br><span class="muted">${esc(f.summary)}</span></td><td>${how}${f.pr ? ` <span class="muted">· ${prLink(f.pr)}</span>` : ''}<br><span class="muted">${at(f.last, 'date')}</span></td><td class="hide-s">${plural(rounds, 'round')}<br>${chips(f.steps)}</td><td class="r num hide-s">${s ? fmtDuration(s.seconds) : ''}</td><td class="r num">${s ? fmtUsd(s.usd) : ''}</td></tr>`;
    })
    .join('');
  const max = Math.max(...(x.days ?? []).map((d) => d.usd), 0.01);
  const bars = x.days
    ? `<div class="bars">${x.days.map((d) => `<span class="b" tabindex="0" data-tip="${esc(d.day)}: ${d.usd ? fmtUsd(d.usd) : 'no runs'}"><i style="height:${((d.usd / max) * 100).toFixed(1)}%"></i></span>`).join('')}</div><div class="axis"><span>${esc(x.days[0]?.day ?? '')}</span><span>today</span></div>`
    : '<div class="quiet">The archive could not be read.</div>';
  const body = `${topBar('history', r, x)}${tiles(r?.totals)}
<h2>Done <span class="count">${ended.length}</span></h2>
${done ? `<div class="scroll"><table><thead><tr><th>Issue</th><th>Ended</th><th class="hide-s">Rounds</th><th class="r hide-s">Agent time</th><th class="r">Cost</th></tr></thead><tbody>${done}</tbody></table></div>` : '<div class="quiet">Nothing has ended yet.</div>'}
<div class="cols2"><div><h2>Activity</h2>${feed(x)}<div class="note">From <code>${esc(x.journalPath)}</code>; <code>foreman log -f</code> follows it.</div></div>
<div><h2>Spend per day <span class="count">last 14 days</span></h2>${bars}</div></div>`;
  return shell('foreman · history', body);
};

export const daysOf = (runs: Run[], usdOf: (rs: Run[]) => number, now = Date.now()) => {
  const days = [...Array(14)].map((_, i) => {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - 13 + i);
    return d;
  });
  return days.map((d, i) => {
    const end = days[i + 1] ?? new Date(d.getTime() + 86400e3);
    return {
      day: d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }),
      usd: usdOf(runs.filter((r) => r.at >= d.toISOString() && r.at < end.toISOString())),
    };
  });
};

const STYLE = `
:root { --bg: #fff; --fg: #1a1a1a; --muted: #6b6b6b; --line: #e4e4e4; --warn: #b42318; --ok: #067647; --bar: #4a7bd0; --soft: #f6f6f6; --amber: #9a6200; --warn-soft: #fef3f2; }
@media (prefers-color-scheme: dark) { :root:not([data-theme='light']) { --bg: #161616; --fg: #ececec; --muted: #9a9a9a; --line: #2e2e2e; --warn: #f97066; --ok: #47cd89; --bar: #7aa2e8; --soft: #1f1f1f; --amber: #f1b440; --warn-soft: #2a1715; color-scheme: dark; } }
:root[data-theme='dark'] { --bg: #161616; --fg: #ececec; --muted: #9a9a9a; --line: #2e2e2e; --warn: #f97066; --ok: #47cd89; --bar: #7aa2e8; --soft: #1f1f1f; --amber: #f1b440; --warn-soft: #2a1715; color-scheme: dark; }
* { box-sizing: border-box; } [hidden] { display: none !important; }
body { background: var(--bg); color: var(--fg); font: 14px/1.5 -apple-system, system-ui, sans-serif; margin: 24px 16px 64px; }
h1 { font-size: 18px; margin: 0; } h2 { font-size: 15px; margin: 32px 0 10px; display: flex; align-items: baseline; gap: 10px; } h2 .count { color: var(--muted); font-weight: 400; font-size: 13px; }
a { color: inherit; } code { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; } .muted { color: var(--muted); } .ok { color: var(--ok); } .warn { color: var(--warn); } .note { color: var(--muted); margin-top: 6px; }
a:focus-visible { outline: 2px solid var(--bar); outline-offset: 1px; }
.topbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; } .topbar .grow { flex: 1; }
.nav { display: inline-flex; gap: 2px; } .nav a { text-decoration: none; color: var(--muted); padding: 2px 10px; border-radius: 6px; font-size: 13px; } .nav a[aria-current='page'] { background: var(--soft); color: var(--fg); }
.health { display: flex; flex-wrap: wrap; gap: 4px 14px; color: var(--muted); font-size: 13px; } .health b { color: var(--fg); font-weight: 500; } .health b.warn { color: var(--warn); }
.banner { border: 1px solid var(--warn); background: var(--warn-soft); color: var(--warn); border-radius: 8px; padding: 8px 12px; margin-top: 12px; } .banner ul { margin: 4px 0 0; padding-left: 20px; }
.tiles { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 20px; }
.tile { border: 1px solid var(--line); border-radius: 8px; padding: 8px 14px; min-width: 170px; } .tile .tlabel { color: var(--muted); font-size: 12px; } .tile .value { font-size: 20px; font-variant-numeric: tabular-nums; } .tile .detail { color: var(--muted); font-size: 12px; }
.needs { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px; }
.ncard { border: 1px solid var(--line); border-left: 3px solid var(--bar); border-radius: 8px; padding: 10px 12px; display: grid; gap: 8px; align-content: start; min-width: 0; }
.ncard.merge { border-left-color: var(--ok); } .ncard.wait { border-left-color: var(--amber); } .ncard.unblock { border-left-color: var(--warn); }
.ncard .top { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px; align-items: baseline; } .ncard .state { font-size: 12px; white-space: nowrap; font-weight: 500; color: var(--bar); }
.ncard.merge .state { color: var(--ok); } .ncard.wait .state { color: var(--amber); } .ncard.unblock .state { color: var(--warn); } .ncard .key { font-weight: 600; } .ncard .title { color: var(--muted); }
.facts { display: flex; flex-wrap: wrap; gap: 4px; } .fact { font-size: 12px; border: 1px solid var(--line); border-radius: 999px; padding: 0 8px; line-height: 20px; color: var(--muted); max-width: 100%; overflow-wrap: anywhere; }
.fact.good { border-color: var(--ok); color: var(--ok); }
.go { color: var(--muted); font-size: 13px; }
.ncard.decide { border-left-color: var(--accent, #3446c9); } .ncard.decide .state { color: var(--accent, #3446c9); font-weight: 650; }
.go .btn { display: inline-block; font: inherit; font-size: 13px; font-weight: 600; padding: 4px 12px; border-radius: 7px; border: 1px solid var(--line); background: var(--fg); color: var(--bg); text-decoration: none; cursor: pointer; margin-right: 6px; }
.go .btn.danger { background: none; color: var(--warn); } .go form.inline { display: inline; }
.health form.inline { display: inline; } .tickbtn { font: inherit; font-size: 12.5px; font-weight: 600; padding: 2px 10px; border-radius: 7px; border: 1px solid var(--line); background: none; color: inherit; cursor: pointer; }
.quiet { color: var(--muted); border: 1px dashed var(--line); border-radius: 8px; padding: 10px 12px; }
table { border-collapse: collapse; width: 100%; } th, td { text-align: left; padding: 8px; border-bottom: 1px solid var(--line); vertical-align: top; } th { color: var(--muted); font-weight: 500; }
.num { font-variant-numeric: tabular-nums; } td.r, th.r { text-align: right; } .scroll { overflow-x: auto; }
.chips { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; } .chip { font-size: 12px; border: 1px solid var(--line); border-radius: 999px; padding: 0 7px; white-space: nowrap; line-height: 20px; }
.chip.ok { border-color: var(--ok); color: var(--ok); } .chip.bad { border-color: var(--warn); color: var(--warn); } .chip.run { border-style: dashed; border-color: var(--ok); color: var(--ok); } .chip.ev { border-style: dotted; color: var(--muted); } .arrow { color: var(--muted); font-size: 11px; }
.feed { list-style: none; margin: 0; padding: 0; } .feed li { display: grid; grid-template-columns: 52px 72px 1fr; gap: 8px; padding: 6px 0; border-bottom: 1px solid var(--line); }
.feed li.day { display: block; color: var(--muted); font-size: 12px; font-weight: 500; padding: 12px 0 4px; } .feed li.fold { display: block; } .feed .t { color: var(--muted); } .feed .src { color: var(--muted); font-size: 12px; }
.bars { display: flex; align-items: flex-end; gap: 2px; height: 64px; margin-top: 6px; border-bottom: 1px solid var(--line); }
.bars .b { flex: 1; display: flex; align-items: flex-end; height: 100%; position: relative; } .bars .b i { display: block; width: 100%; background: var(--bar); border-radius: 4px 4px 0 0; }
.bars .b:hover::after, .bars .b:focus::after { content: attr(data-tip); position: absolute; bottom: 100%; left: 50%; transform: translateX(-50%); background: var(--fg); color: var(--bg); font-size: 12px; padding: 2px 8px; border-radius: 6px; white-space: nowrap; z-index: 1; }
.axis { display: flex; justify-content: space-between; color: var(--muted); font-size: 11px; margin-top: 2px; }
.cols2 { display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); gap: 32px; } .cols2 > div { min-width: 0; }
@media (max-width: 720px) {
  .cols2 { grid-template-columns: 1fr; gap: 0; } .hide-s { display: none; }
  table.runs tr { display: grid; grid-template-columns: 1fr auto; padding: 8px 0; border-bottom: 1px solid var(--line); } table.runs td { border: 0; padding: 2px 0; }
  .feed li { grid-template-columns: 44px 1fr; } .feed li > span:nth-child(3) { grid-column: 2; }
}`;

// How long each running stage has run, kept current; and a banner when no tick has written for two intervals.
const SCRIPT = `${TIMES}
const running = () => { for (const t of document.querySelectorAll('time[data-for]')) { const s = Math.round((Date.now() - Date.parse(t.dateTime)) / 1000); t.textContent = s < 90 ? s + 's' : s < 5400 ? Math.round(s / 60) + ' min' : (s / 3600).toFixed(1) + ' h'; } };
const stale = () => { const b = document.getElementById('stale'); if (!b || !b.dataset.at) return; const every = Number(b.dataset.every), age = (Date.now() - Date.parse(b.dataset.at)) / 1000; b.hidden = !(every && age > 2 * every + 60); if (!b.hidden) b.textContent = 'No tick for ' + ago(b.dataset.at).replace(' ago', '') + '; launchd should tick every ' + Math.round(every / 60) + ' min, so this page is out of date. Check foreman status.'; };
running(); stale(); setInterval(() => { running(); stale(); }, 15000);
`;

const shell = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="refresh" content="60">
<title>${esc(title)}</title><style>${STYLE}</style></head><body>
${body}
<script>${SCRIPT}</script>
</body></html>
`;

/** A page for when something can't be shown: what happened, and the way back. */
export const messagePage = (title: string, text: string) =>
  shell(`foreman · ${title}`, `<p><a href="/">← foreman</a></p><h2>${esc(title)}</h2><p>${esc(text)}</p>`);
