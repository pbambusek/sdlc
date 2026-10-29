// A gate's page: for a round, every claim with its evidence in the design of verify's evidence page (whose styles it reads
// from the skill's own template), then every item of the feedback in its fixed order with a decision on each one that
// needs it; for a build's questions, each question with its answer. Pure: the server loads the files and hands them over.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { esc, gfm, link, md, TIMES, when } from './html.mts';
import {
  choicesFor,
  describeNext,
  fromDecision,
  isGood,
  LABEL,
  MEANS,
  nextOf,
  ordered,
  toDecision,
  type Choice,
  type ItemDecision,
  type Next,
} from './round.mts';
import { PLUGIN_DIR } from './sessions.mts';
import type { FeedbackItem, Mergeability } from './types.mts';

interface EvidenceItem {
  type: string;
  payload: string;
  shows: string;
  how: string;
  status: string;
  reason?: string;
  highlight?: string[];
}
export interface Evidence {
  title?: string;
  groups?: { title: string; claims: string[] }[];
  claims: { id: string; text: string; origin: string; items: EvidenceItem[] }[];
}
export interface Audit {
  verdict: string;
  clean: boolean;
  findings?: { tool: string; input: string; why: string }[];
}

export type DecidedItem = FeedbackItem & { decision?: ItemDecision };

export interface GateView {
  kind: 'round' | 'questions';
  key: string;
  summary: string;
  url: string;
  pr: { number: number; url: string } | null;
  /** The round's number, or the build that asked. */
  n: number;
  /** The head it is about, or the commit the build asked on (`none` before it pushed). */
  sha: string;
  /** The PR's head now: a round on another head is outdated. */
  head: string | null;
  readAt: string | null;
  run: string | null;
  items: FeedbackItem[];
  /** The decided document, once a person decided this gate. */
  decided: { at: string; next: Next; items: DecidedItem[] } | null;
  evidence: Evidence | null;
  audit: Audit | null;
  /** The round before, to show its decision beside a recurring item and what was resolved since. */
  previous: { n: number; items: DecidedItem[] } | null;
  merge: Mergeability | null;
  nextBuild: number;
  /** Where the page posts its decisions and finds the run's screenshots. */
  base: string;
  /** The problems file and the command that revises the spec from it, once decided `change-claim`. */
  respec: { file: string; command: string } | null;
  error: string | null;
}

const STATUS = { shown: 'Shown', 'not-shown': 'Not shown', blocked: 'Blocked' } as Record<string, string>;
const ICON = { shown: '✓', 'not-shown': '✕', blocked: '!' } as Record<string, string>;
const ORDER = ['shown', 'not-shown', 'blocked'];
const claimStatus = (items: { status: string }[]) =>
  items.some((i) => i.status === 'not-shown') ? 'not-shown' : items.every((i) => i.status === 'shown') ? 'shown' : 'blocked';

/** Verify's evidence page's own styles: the round page is that page with decisions on it. */
export const evidenceStyle = () => {
  try {
    return readFileSync(join(PLUGIN_DIR, 'skills/verify/assets/evidence.html'), 'utf8').match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';
  } catch {
    return '';
  }
};

const groupsOf = (e: Evidence) => {
  const byId = new Map(e.claims.map((c) => [c.id, c]));
  const named = new Set((e.groups ?? []).flatMap((g) => g.claims));
  const rest = e.claims.filter((c) => !named.has(c.id) && c.origin !== 'probe');
  const probes = e.claims.filter((c) => !named.has(c.id) && c.origin === 'probe');
  return [
    ...(e.groups ?? []).map((g) => ({ title: g.title, claims: g.claims.map((id) => byId.get(id)!).filter(Boolean) })),
    ...(rest.length ? [{ title: e.groups?.length ? 'Other claims' : 'Claims', claims: rest }] : []),
    ...(probes.length ? [{ title: 'Found by the verifier', claims: probes }] : []),
  ].map((g, n) => ({ ...g, id: `group-${n + 1}` }));
};

const highlighted = (text: string, marks: string[] = []) => {
  let h = esc(text);
  for (const m of marks.filter(Boolean)) h = h.split(esc(m)).join(`<mark>${esc(m)}</mark>`);
  return `<pre class="payload">${h}</pre>`;
};

const shot = (v: GateView, payload: string) => `${v.base}/run/${payload.split('/').map(encodeURIComponent).join('/')}`;

const evidenceItem = (v: GateView, i: EvidenceItem, many: boolean) => {
  const text = `<div class="item-text"><div class="label">${many ? `<span class="pill ${i.status}">${ICON[i.status]} ${STATUS[i.status]}</span>` : ''}${i.type === 'screenshot' ? 'What the screenshot shows' : `Observed · ${esc(i.type)}`}</div>
<div class="observed">${esc(i.shows)}</div>${i.reason ? `<div class="reason ${i.status}">${esc(i.reason)}</div>` : ''}${i.type !== 'screenshot' ? highlighted(i.payload, i.highlight) : ''}
<details class="steps"><summary>How it was produced</summary><pre>${esc(i.how)}</pre></details></div>`;
  if (i.type !== 'screenshot') return `<div class="item">${text}</div>`;
  return `<div class="item has-shot">${text}<a class="shot" href="${esc(shot(v, i.payload))}" data-caption="${esc(i.shows)}"><img src="${esc(shot(v, i.payload))}" alt="${esc(i.shows)}" loading="lazy"><span>${esc(i.payload)}</span></a></div>`;
};

/** An item's anchor on the page: its name, with what a URL fragment can't hold folded away. */
const anchor = (name: string) => `i-${name.replace(/[^a-zA-Z0-9]+/g, '-')}`;

/** The rows of the spec's claims, by group, or of the verifier's probes, each with its evidence and, when it needs one, its decision. */
const claimRows = (v: GateView, which: 'claims' | 'probes', decision: (it: FeedbackItem) => string) => {
  if (!v.evidence) return '';
  const groups = groupsOf(v.evidence).filter((g) => g.claims.every((c) => (c.origin === 'probe') === (which === 'probes')));
  return groups
    .map((g) => {
      const t = Object.fromEntries(ORDER.map((s) => [s, g.claims.filter((c) => claimStatus(c.items) === s).length]));
      const rows = g.claims
        .map((c) => {
          const s = claimStatus(c.items);
          const first = c.items.find((i) => i.type === 'screenshot');
          const item = `${c.origin === 'probe' ? 'probe' : 'claim'}:${c.id}`;
          const open = v.items.find((x) => x.item === item && !isGood(x));
          return `<details class="row ${s}" id="${esc(c.id)}"${open ? ' open' : ''}><summary><span class="glyph ${s}" title="${STATUS[s]}">${ICON[s]}</span>
<div class="row-main"><div class="text"><span class="id">${esc(c.id)}</span>${esc(c.text)}</div>${s !== 'shown' ? `<div class="why">${esc(c.items.find((i) => i.status === s)?.reason ?? '')}</div>` : ''}</div>
<div class="row-side">${open ? '<span class="chip decide">to decide</span>' : ''}${first ? `<img class="mini" src="${esc(shot(v, first.payload))}" alt="" loading="lazy">` : `<span class="chip">${esc(c.items[0]?.type ?? '')}</span>`}<span class="chev" aria-hidden="true">▶</span></div></summary>
<div class="row-body">${c.origin === 'extracted' ? '<div class="origin">Read from the source’s prose: check the wording says what the source meant.</div>' : ''}
${c.items.map((i) => evidenceItem(v, i, c.items.length > 1)).join('')}${open ? decision(open) : ''}</div></details>`;
        })
        .join('');
      if (which === 'probes') return `<div class="list">${rows}</div>`;
      const bar = ORDER.map((s) => (t[s] ? `<i class="${s}" style="width:${(t[s]! / g.claims.length) * 100}%"></i>` : '')).join('');
      return `<section class="group" id="${g.id}"><div class="group-head"><h3>${esc(g.title)}</h3><span class="bar" aria-hidden="true">${bar}</span><span class="tally num">${t.shown} of ${g.claims.length} shown${t['not-shown'] ? ` · ${t['not-shown']} not shown` : ''}${t.blocked ? ` · ${t.blocked} blocked` : ''}</span></div><div class="list">${rows}</div></section>`;
    })
    .join('');
};

const BAD_STATUS = new Set(['not-shown', 'failure', 'timed_out', 'cancelled', 'missing', 'changes-requested', 'conflicts', 'flagged']);
const itemClass = (it: FeedbackItem) => (isGood(it) ? 'shown' : BAD_STATUS.has(it.status) ? 'not-shown' : 'blocked');

/** The top of the page: one tile per section of the feedback, one square per item, and the audit's line. */
const scoreboard = (v: GateView, decide: number) => {
  const items = ordered(v.items);
  const of = (...p: string[]) => items.filter((it) => p.some((x) => it.item.startsWith(x)));
  const claims = v.evidence?.claims.filter((c) => c.origin !== 'probe') ?? [];
  const probes = of('probe:');
  const reviews = of('review:', 'thread:');
  const checks = of('check:');
  const bad = (xs: FeedbackItem[]) => xs.filter((x) => !isGood(x)).length;
  const worst = (xs: { cls: string }[]) => (xs.some((x) => x.cls === 'not-shown') ? 'not-shown' : xs.some((x) => x.cls === 'blocked') ? 'blocked' : 'shown');
  const tile = (href: string, cls: string, big: string, label: string) =>
    `<a class="stat ${cls}" href="#${href}"><b class="num">${big}</b><span>${label}</span></a>`;
  const claimCls = claims.map((c) => ({ cls: claimStatus(c.items) }));
  const stats = [
    tile('claims', worst(claimCls), `${claimCls.filter((c) => c.cls === 'shown').length}/${claims.length}`, 'claims shown'),
    tile('probes', probes.length ? worst(probes.map((p) => ({ cls: itemClass(p) }))) : 'shown', String(bad(probes)), 'probe findings'),
    tile('reviews', worst(reviews.map((r) => ({ cls: itemClass(r) }))), String(bad(reviews)), 'review items open'),
    tile('checks', worst(checks.map((c) => ({ cls: itemClass(c) }))), `${checks.length - bad(checks)}/${checks.length}`, 'checks fine'),
    tile('claims', 'decide', String(decide), 'to decide'),
  ].join('');
  const cell = (href: string, cls: string, title: string) =>
    `<a class="cell ${cls}" href="#${href}" title="${esc(title)}">${cls === 'shown' ? '' : ICON[cls]}</a>`;
  const group = (href: string, title: string, cells: string[], shown: number) =>
    cells.length
      ? `<div class="strip-group"><a href="#${href}">${esc(title)} <span class="num">${shown}/${cells.length}</span></a><div class="cells">${cells.join('')}</div></div>`
      : '';
  const itemCells = (xs: FeedbackItem[]) => xs.map((it) => cell(anchor(it.item), itemClass(it), `${it.item} · ${it.status}`));
  const strip = [
    ...(v.evidence ? groupsOf(v.evidence).filter((g) => g.claims.every((c) => c.origin !== 'probe')) : []).map((g) =>
      group(
        g.id,
        g.title,
        g.claims.map((c) => cell(c.id, claimStatus(c.items), `${c.id} · ${STATUS[claimStatus(c.items)]} · ${c.text}`)),
        g.claims.filter((c) => claimStatus(c.items) === 'shown').length,
      ),
    ),
    group('probes', 'Probes', itemCells(probes), probes.length - bad(probes)),
    group('reviews', 'Reviews', itemCells(reviews), reviews.length - bad(reviews)),
    group('checks', 'Checks', itemCells(checks), checks.length - bad(checks)),
  ].join('');
  const a = v.audit;
  const trust = !a
    ? '<span class="pill blocked">… No audit</span><span>The run’s audit is not in the archive.</span>'
    : a.clean
      ? '<span class="pill shown">✓ Audit clean</span><span>The verifier never looked at how the code was written.</span>'
      : `<span class="pill blocked">! Audit warning</span><span>${esc(a.verdict)}</span>`;
  return `<section class="board" aria-label="Result"><div class="stats five">${stats}</div><div class="strip" aria-label="Every item, by section">${strip}</div><div class="trust">${trust}</div></section>`;
};

const PLACEHOLDER: Record<Choice, string> = {
  fix: 'How to fix it (optional)',
  leave: 'Why it stays (optional); on a review thread, the build words a reply from this',
  'follow-up': 'What the follow-up is (optional)',
  'change-claim': 'What is wrong with the claim (optional)',
  answer: 'Your answer; empty takes the build’s recommendation',
};

/**
 * An item's decision. Collapsed, it reads as its choice (Fix, the default, with no text); "change" opens the choices and
 * the text box. A previous round's choice is preselected, and shown beside it.
 */
const decisionBlock = (v: GateView, it: FeedbackItem, decided: ItemDecision | undefined, ro: boolean) => {
  const prev = v.previous?.items.find((x) => x.item === it.item && x.decision);
  const choices = choicesFor(it);
  const chosen = decided ? fromDecision(decided) : prev?.decision && choices.includes(fromDecision(prev.decision)) ? fromDecision(prev.decision) : choices[0]!;
  const text = decided?.hint ?? '';
  const line = `<span class="chosen">${esc(LABEL[chosen])}</span><span class="hintview">${text ? ` — “${esc(text)}”` : ''}</span>`;
  const was = prev?.decision
    ? `<div class="prev">Round ${v.previous!.n}: ${esc(LABEL[fromDecision(prev.decision)])}${prev.decision.hint ? ` — “${esc(prev.decision.hint)}”` : ''}</div>`
    : '';
  if (ro) return `<div class="decision ro" id="${anchor(it.item)}"><div class="line">${line}</div>${was}</div>`;
  return `<div class="decision" id="${anchor(it.item)}"><div class="line">${line} <button type="button" class="edit">change</button></div>
<div class="editor" hidden>${was}<div class="acts" role="radiogroup" aria-label="Decision on ${esc(it.item)}">${choices
    .map(
      (c) =>
        `<label title="${esc(MEANS[c])}"><input type="radio" name="c:${esc(it.item)}" value="${c}" ${c === chosen ? 'checked' : ''}><span>${esc(LABEL[c])}</span></label>`,
    )
    .join('')}</div>
<div class="means">${esc(MEANS[chosen])}</div>
<textarea name="t:${esc(it.item)}" rows="2" placeholder="${esc(PLACEHOLDER[chosen])}">${esc(text)}</textarea></div></div>`;
};

/**
 * One item that isn't a claim with evidence (a check, a review, a thread, the audit, the base, a question), as a row like a
 * claim's: its status and what its source said, then, when it needs one, its decision.
 */
const itemRow = (v: GateView, it: FeedbackItem, decided: ItemDecision | undefined, ro: boolean) => {
  const good = isGood(it);
  const cls = itemClass(it);
  const name = it.item.startsWith('thread:') ? (it.where ?? 'review thread') : it.item.replace(/^(check|review|question):/, '');
  const what = [it.observed, it.reason, it.rule && `Rule: ${it.rule}`, it.calls?.length && it.calls.join('\n')].filter(Boolean).join('\n\n');
  const was = v.previous?.items.find((p) => p.item === it.item);
  const resolved = good && was && !isGood(was);
  const chips = [
    it.by ? `<span class="chip">${esc(it.by)}</span>` : '',
    it.mark ? `<span class="chip">${esc(it.mark)}</span>` : '',
    resolved ? `<span class="chip">resolved since round ${v.previous!.n}</span>` : '',
    good ? '' : '<span class="chip decide">to decide</span>',
  ].join('');
  // Only web links: a local path is no link in a browser.
  const src = [
    it.where ? `<code>${esc(it.where)}</code>` : '',
    it.link?.startsWith('http') ? link(it.link, 'source ↗') : '',
    it.item.startsWith('thread:') ? link(it.item.slice(7), 'thread ↗') : '',
  ].join('');
  // A reviewer's comment opens with markup and boilerplate: its first line of words says what it is about.
  const first =
    (it.observed ?? it.reason ?? '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .split('\n')
      .map((l) => l.replace(/[#*`>]/g, '').trim())
      .find(Boolean) ?? '';
  return `<details class="row ${cls}" id="${anchor(it.item)}"${good ? '' : ' open'}><summary><span class="glyph ${cls}">${ICON[cls]}</span>
<div class="row-main"><div class="text"><span class="id">${esc(name)}</span>${esc(it.status)}</div>${!good && first ? `<div class="why">${md(first)}</div>` : ''}</div>
<div class="row-side">${chips}<span class="chev" aria-hidden="true">▶</span></div></summary>
<div class="row-body">${what ? (it.by ? gfm(what) : `<div class="observed">${md(what)}</div>`) : '<div class="quiet">Nothing more from its source.</div>'}${it.recommended ? `<div class="means">Recommended: ${md(it.recommended)}</div>` : ''}
${src ? `<div class="src">${src}</div>` : ''}${good ? '' : decisionBlock(v, it, decided, ro)}</div></details>`;
};

/** A section of the page in the feedback's fixed order, with one row per item. */
const section = (id: string, title: string, rows: string[]) =>
  rows.length
    ? `<div class="section-head" id="${id}"><h2>${esc(title)}</h2><span class="num">${rows.length}</span></div><div class="list">${rows.join('')}</div>`
    : '';

/** The decisions a posted form holds, for the gate's items that need one. Throws on a choice an item doesn't offer. */
export const readForm = (items: FeedbackItem[], form: URLSearchParams) => {
  const decisions: Record<string, ItemDecision> = {};
  for (const it of items.filter((x) => !isGood(x))) {
    const c = (form.get(`c:${it.item}`) ?? choicesFor(it)[0]) as Choice;
    if (!choicesFor(it).includes(c))
      throw new Error(
        `${it.item}: choose one of ${choicesFor(it)
          .map((x) => LABEL[x])
          .join(', ')}`,
      );
    decisions[it.item] = toDecision(it, c, form.get(`t:${it.item}`) ?? '');
  }
  return { decisions, abandon: form.get('abandon') === '1', sha: form.get('sha') ?? '' };
};

/** What the gate makes foreman do, for the form as it stands. */
export const preview = (v: GateView, form: URLSearchParams) => {
  const { decisions, abandon } = readForm(v.items, form);
  const list = Object.entries(decisions).map(([item, d]) => ({ item, ...d }));
  return describeNext(nextOf(list, abandon), list, { pr: v.pr?.number ?? null, nextBuild: v.nextBuild });
};

export const gatePage = (v: GateView) => {
  const items = ordered(v.items);
  const open = items.filter((it) => !isGood(it));
  const outdated = v.kind === 'round' && !!v.head && v.head !== v.sha;
  const ro = outdated || !!v.decided;
  const decidedBy = new Map((v.decided?.items ?? []).map((x) => [x.item, x.decision]));
  // A claim or probe with evidence is its row in the claims; every other item is a row in its own section, in the file's order.
  const rowIds = new Set((v.evidence?.claims ?? []).map((c) => `${c.origin === 'probe' ? 'probe' : 'claim'}:${c.id}`));
  const row = (it: FeedbackItem) => itemRow(v, it, decidedBy.get(it.item), ro);
  const inline = (it: FeedbackItem) => decisionBlock(v, it, decidedBy.get(it.item), ro);
  const of = (...prefixes: string[]) => items.filter((it) => prefixes.some((p) => it.item.startsWith(p)) && !rowIds.has(it.item)).map(row);
  const title = v.kind === 'round' ? `Round ${v.n}` : `Build #${v.n} asks`;
  const eyebrow = outdated ? `${title} · outdated` : v.decided ? `${title} · decided` : `${title} · your decision`;
  const banner = v.error
    ? `<div class="banner bad">${esc(v.error)}</div>`
    : outdated
      ? `<div class="banner bad"><b>This round is outdated.</b> #${v.pr?.number}'s head is now <code>${esc(v.head!.slice(0, 7))}</code>. Nothing here is acted on; a full round runs on the new head.</div>`
      : v.decided
        ? `<div class="banner good"><b>Decided ${when(v.decided.at)}.</b> ${esc(
            describeNext(
              v.decided.next,
              (v.decided.items ?? []).flatMap((x) => (x.decision ? [{ item: x.item, ...x.decision }] : [])),
              { pr: v.pr?.number ?? null, nextBuild: v.nextBuild },
            ),
          )}</div>`
        : '';
  const respec = v.respec
    ? `<div class="banner warn"><b>Change the claim.</b> Revise the spec in a session, then update the issue and approve it again:<pre>${esc(v.respec.command)}</pre>The problems are in <code>${esc(v.respec.file)}</code>.</div>`
    : '';
  const merge =
    v.kind === 'round' && v.merge && !outdated ? `<div class="meta"><span>${v.merge.ready ? '✓' : '!'} #${v.pr?.number} ${esc(v.merge.why)}</span></div>` : '';
  const form = !ro && open.length;
  const dock = form
    ? `<div class="dock"><div class="dockbar gatebar"><div id="plan"><p class="sum">${esc(preview(v, new URLSearchParams()))}</p></div>
<div class="btns"><button class="linkbtn danger" name="abandon" value="1" onclick="return confirm(${esc(JSON.stringify(`Abandon ${v.key}? Foreman closes the PR and starts nothing more on it.`))})">Abandon…</button>
<button class="btn primary" id="submit">Save decisions</button></div></div></div>`
    : '';
  const body = `<form method="post" action="${esc(v.base)}" id="gate"><input type="hidden" name="sha" value="${esc(v.sha)}">
<a class="back" href="/">← foreman</a><div class="eyebrow">${esc(eyebrow)}</div>
<h1 id="top"><span class="key">${esc(v.key)}</span>${esc(v.summary)}</h1>
<div class="meta"><span>${v.kind === 'round' ? 'Head' : 'Asked on'} <code>${esc(v.sha.slice(0, 12))}</code></span>${v.pr ? `<span>PR ${link(v.pr.url, `#${v.pr.number}`)}</span>` : ''}${v.readAt ? `<span>Read ${when(v.readAt)}</span>` : ''}${v.run ? `<span>Verification run <code>${esc(v.run)}</code></span>` : ''}<span>${link(v.url, 'Issue')}</span></div>
${merge}${banner}${respec}
${v.kind === 'round' ? scoreboard(v, open.length) : ''}
${
  v.kind === 'round'
    ? `<div class="section-head" id="claims"><h2>Claims</h2><span class="num">${v.evidence?.claims.filter((c) => c.origin !== 'probe').length ?? 0}</span><span class="hint">anything to decide is fixed unless you change it</span></div>${claimRows(v, 'claims', inline)}${v.evidence ? '' : '<div class="quiet">This round has no verification evidence in the archive.</div>'}
${of('claim:').length ? `<div class="list">${of('claim:').join('')}</div>` : ''}${
        v.evidence?.claims.some((c) => c.origin === 'probe') || of('probe:').length
          ? `<div class="section-head" id="probes"><h2>Probes</h2><span class="hint">what the verifier found next to the claims</span></div>${claimRows(v, 'probes', inline)}${of('probe:').length ? `<div class="list">${of('probe:').join('')}</div>` : ''}`
          : ''
      }${section('reviews', 'Reviews', [...of('review:'), ...of('thread:')])}${section('checks', 'Checks', of('check:'))}${section('audit', 'Audit', of('audit'))}${section('base', 'Base', of('base'))}`
    : section('questions', 'Questions', of('question:'))
}
${dock}</form>
<dialog id="lightbox"><img alt=""><p></p></dialog>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(`${title}: ${v.key}`)}</title><style>${evidenceStyle()}${STYLE}</style></head><body>
<div class="shell"><main id="page">${body}</main></div>
<script>${TIMES}${SCRIPT}</script>
</body></html>
`;
};

const STYLE = `
.back { font-size: 13px; color: var(--muted); text-decoration: none; } .back:hover { color: var(--fg); }
.eyebrow { font-size: 12px; font-weight: 650; letter-spacing: .04em; text-transform: uppercase; color: var(--muted); margin-top: 14px; }
h1 .key { color: var(--muted); margin-right: 10px; font-weight: 600; }
.meta { display: flex; flex-wrap: wrap; gap: 4px 16px; font-size: 13px; color: var(--muted); margin-top: 6px; }
.banner { border-radius: 10px; padding: 12px 16px; margin-top: 18px; font-size: 14px; border: 1px solid; }
.banner pre { margin: 8px 0; white-space: pre-wrap; font: 13px var(--mono); }
.banner.bad { border-color: var(--bad); background: var(--bad-soft); color: var(--bad); } .banner.good { border-color: var(--ok); background: var(--ok-soft); color: var(--ok); } .banner.warn { border-color: var(--warn); background: var(--warn-soft); color: var(--warn); }
.section-head { display: flex; align-items: baseline; gap: 10px; margin: 44px 0 12px; padding-top: 16px; border-top: 2px solid var(--line); } .section-head h2 { margin: 0; font-size: 21px; } .section-head .hint { color: var(--faint); font-size: 12.5px; }
.group { margin-top: 14px; } .group-head { margin-bottom: 6px; } .group-head h3 { font-size: 12.5px; font-weight: 650; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
.stats.five { grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 16px; } .stats.five .stat b { font-size: clamp(24px, 3.2vw, 34px); } .stat.decide { border-color: var(--accent); } .stat.decide b { color: var(--accent); }
@media (max-width: 760px) { .stats.five { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
.md { font-size: 14px; } .md p { margin: 4px 0; } .md .md-h { font-weight: 700; margin: 12px 0 4px; } .md ul, .md ol { margin: 4px 0; padding-left: 22px; }
.md blockquote { margin: 4px 0; padding-left: 10px; border-left: 3px solid var(--line); color: var(--muted); } .md hr { border: 0; border-top: 1px solid var(--line); margin: 10px 0; }
.md details { margin: 6px 0; } .md summary { cursor: pointer; color: var(--accent); }
.cards { display: grid; gap: 12px; }
.card.gate { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 14px 16px; display: grid; gap: 8px; scroll-margin-top: 16px; }
.card.gate:target { border-color: var(--fg); box-shadow: 0 0 0 1px var(--fg); }
.card.gate .top { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; } .card.gate .id { font-weight: 650; font-family: var(--mono); font-size: 13px; overflow-wrap: anywhere; }
.card.gate .why { white-space: pre-wrap; font-size: 14px; max-height: 18em; overflow: auto; }
.card .src { font-size: 12.5px; color: var(--faint); display: flex; flex-wrap: wrap; gap: 4px 12px; } .card .src a { color: var(--accent); }
.decision { border-top: 1px solid var(--line); padding-top: 10px; display: grid; gap: 6px; scroll-margin-top: 16px; }
.decision .line { font-size: 13.5px; } .decision .chosen { font-weight: 650; } .decision .hintview { color: var(--muted); }
.decision button.edit { all: unset; cursor: pointer; font-size: 12.5px; color: var(--accent); margin-left: 6px; }
.decision .editor { display: grid; gap: 6px; } .row-body .decision { margin-top: 12px; }
.chip.decide { color: var(--accent); border-color: var(--accent); }
#lightbox { border: 0; padding: 0; background: transparent; max-width: 96vw; max-height: 96vh; } #lightbox::backdrop { background: rgb(0 0 0 / .78); }
#lightbox img { display: block; max-width: 96vw; max-height: 88vh; border-radius: 8px; cursor: zoom-out; } #lightbox p { color: #fff; font-size: 13px; margin: 8px 2px 0; max-width: 96vw; }
.prev, .means { font-size: 12.5px; color: var(--muted); }
.acts { display: flex; flex-wrap: wrap; gap: 2px; padding: 2px; background: var(--surface-2); border-radius: 10px; width: fit-content; }
.acts label { position: relative; cursor: pointer; } .acts input { position: absolute; opacity: 0; pointer-events: none; }
.acts span { display: block; padding: 4px 10px; border-radius: 8px; font-size: 13px; font-weight: 600; color: var(--muted); white-space: nowrap; }
.acts input:checked + span { background: var(--surface); color: var(--fg); box-shadow: 0 1px 2px rgb(10 14 22 / .12); }
.acts input:focus-visible + span { outline: 2px solid var(--accent); } .acts input:disabled + span { cursor: default; }
.notetext { font-size: 13px; background: var(--surface-2); border-radius: 8px; padding: 6px 10px; white-space: pre-wrap; }
#page textarea { font: inherit; font-size: 13.5px; width: 100%; border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; background: var(--surface); color: var(--fg); resize: vertical; }
.linked { font-size: 13px; color: var(--muted); } .linked a { color: var(--accent); }
.extras { color: var(--muted); font-size: 14px; padding-left: 18px; } .extras li { margin: 3px 0; }
details.good { margin-top: 14px; color: var(--muted); font-size: 14px; } details.good summary { cursor: pointer; }
.quiet { color: var(--muted); border: 1px dashed var(--line); border-radius: 12px; padding: 12px 16px; }
.dockbar.gatebar { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 8px 14px; padding: 10px 12px 10px 16px; }
.dock .sum { font-weight: 650; font-size: 14px; margin: 0; }
.dock .btns { display: flex; align-items: center; gap: 12px; }
.dock .btn { font: inherit; border-radius: 9px; padding: 7px 16px; font-size: 14px; border: 1px solid var(--line); background: var(--surface); color: var(--fg); cursor: pointer; }
.dock .btn.primary { background: var(--fg); color: var(--surface); border-color: var(--fg); }
.dock .linkbtn { font: inherit; font-size: 13px; background: none; border: 0; padding: 0; cursor: pointer; text-decoration: underline; } .dock .linkbtn.danger { color: var(--bad); }
a.shot { display: grid; gap: 6px; align-content: start; } a.shot img { width: 100%; aspect-ratio: 16 / 10; object-fit: cover; object-position: top left; border-radius: 8px; border: 1px solid var(--line); display: block; } a.shot span { font-size: 12px; color: var(--muted); }
@media (max-width: 520px) { .dockbar.gatebar { grid-template-columns: 1fr; } .shell { padding-bottom: 200px; } }`;

// Keeps the line saying what foreman will do in step with the form, and each item's hint and placeholder with its choice.
const SCRIPT = `
const form = document.getElementById('gate');
const plan = document.getElementById('plan');
const MEANS = ${JSON.stringify(MEANS)};
const PLACEHOLDER = ${JSON.stringify(PLACEHOLDER)};
const refresh = async () => {
  if (!plan) return;
  const r = await fetch(form.action + '/plan', { method: 'POST', body: new URLSearchParams(new FormData(form)) });
  if (r.ok) plan.querySelector('.sum').textContent = await r.text();
};
let timer;
form.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(refresh, 200); });
form.addEventListener('change', (e) => {
  const t = e.target;
  if (t.type !== 'radio') return;
  const d = t.closest('.decision');
  d.querySelector('.means').textContent = MEANS[t.value];
  d.querySelector('.chosen').textContent = t.closest('label').textContent;
  const a = d.querySelector('textarea');
  if (a) a.placeholder = PLACEHOLDER[t.value];
  refresh();
});
document.addEventListener('click', (e) => {
  const edit = e.target.closest('button.edit');
  if (edit) { const ed = edit.closest('.decision').querySelector('.editor'); ed.hidden = !ed.hidden; edit.textContent = ed.hidden ? 'change' : 'done'; return; }
  const a = e.target.closest('a.shot');
  if (a) { e.preventDefault(); const box = document.getElementById('lightbox'); box.querySelector('img').src = a.href; box.querySelector('p').textContent = a.dataset.caption || ''; box.showModal(); return; }
  if (e.target.closest('#lightbox')) document.getElementById('lightbox').close();
});
form.addEventListener('input', (e) => {
  const t = e.target;
  if (t.tagName !== 'TEXTAREA') return;
  t.closest('.decision').querySelector('.hintview').textContent = t.value.trim() ? ' — “' + t.value.trim() + '”' : '';
});
const open = (id) => { const t = id && document.getElementById(id); const d = t && (t.tagName === 'DETAILS' ? t : t.closest('details')); if (d) d.open = true; };
open(decodeURIComponent(location.hash.slice(1)));
window.addEventListener('hashchange', () => open(decodeURIComponent(location.hash.slice(1))));
`;
