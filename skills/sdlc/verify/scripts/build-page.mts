/**
 * Builds `<dir>/evidence.html` from `<dir>/evidence.json` and the locked template, inlining every screenshot, and prints
 * the summary: the counts of shown, not-shown and blocked claims, and each claim that is not shown with its reason.
 * Usage: `node <skill dir>/scripts/build-page.mts [dir, default .verify]`, from the run folder.
 * Exits 1 and lists every problem when the evidence is malformed. The target and the source come from the launcher's
 * `target.json`, and its audit becomes the page's trust line. A screenshot cited by several claims is embedded once.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const STATUSES = ['shown', 'not-shown', 'blocked'];
const ITEM_TYPES = ['screenshot', 'http', 'command', 'trace', 'event'];
const ORIGINS = ['quoted', 'extracted', 'probe'];

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const isText = (v: unknown) => typeof v === 'string' && v.length > 0;

/** Returns every problem in the evidence, each prefixed with its JSON path. */
const validate = (e: unknown): string[] => {
  const problems: string[] = [];
  const need = (ok: boolean, where: string, what: string) => ok || problems.push(`${where}: ${what}`);
  if (!isObject(e)) return ['(root): must be an object'];
  need(e.title === undefined || isText(e.title), 'title', 'text when present');
  need(Array.isArray(e.environment) && e.environment.every(isText), 'environment', 'a list of text');
  if (!Array.isArray(e.claims) || e.claims.length === 0) return [...problems, 'claims: a non-empty list'];
  const ids = new Set(e.claims.map((c: unknown) => (isObject(c) ? c.id : undefined)));
  if (e.groups !== undefined) {
    if (!Array.isArray(e.groups)) problems.push('groups: a list when present');
    else {
      const grouped = new Set<unknown>();
      e.groups.forEach((g: unknown, gi) => {
        const at = `groups.${gi}`;
        if (!isObject(g)) return problems.push(`${at}: must be an object`);
        need(isText(g.title), `${at}.title`, 'required text');
        if (!Array.isArray(g.claims) || g.claims.length === 0) return problems.push(`${at}.claims: a non-empty list of claim ids`);
        for (const id of g.claims) {
          need(ids.has(id), `${at}.claims`, `${String(id)} is not a claim id`);
          need(!grouped.has(id), `${at}.claims`, `${String(id)} is already in another group`);
          grouped.add(id);
        }
      });
    }
  }
  e.claims.forEach((c: unknown, ci) => {
    const at = `claims.${ci}`;
    if (!isObject(c)) return problems.push(`${at}: must be an object`);
    for (const k of ['id', 'text']) need(isText(c[k]), `${at}.${k}`, 'required text');
    need(ORIGINS.includes(String(c.origin)), `${at}.origin`, ORIGINS.join(', '));
    if (!Array.isArray(c.items) || c.items.length === 0) return problems.push(`${at}.items: a non-empty list; a claim you couldn't check gets one blocked item`);
    c.items.forEach((i: unknown, ii) => {
      const iat = `${at}.items.${ii}`;
      if (!isObject(i)) return problems.push(`${iat}: must be an object`);
      need(ITEM_TYPES.includes(String(i.type)), `${iat}.type`, ITEM_TYPES.join(', '));
      for (const k of ['payload', 'shows', 'how']) need(isText(i[k]), `${iat}.${k}`, 'required text');
      need(STATUSES.includes(String(i.status)), `${iat}.status`, STATUSES.join(', '));
      need(i.reason === undefined || isText(i.reason), `${iat}.reason`, 'text when present');
      need(i.status === 'shown' || isText(i.reason), `${iat}.reason`, 'a not-shown or blocked item needs a reason');
      need(i.highlight === undefined || (i.type !== 'screenshot' && Array.isArray(i.highlight) && i.highlight.every(isText)), `${iat}.highlight`, 'a list of text, not on a screenshot');
    });
  });
  return problems;
};

type Item = { type: string; payload: string; status: string; reason?: string };
type Claim = { id: string; items: Item[] };

// A claim is not shown if any item is not shown, shown only when every item is, and blocked otherwise.
const claimStatus = (c: Claim) =>
  c.items.some((i) => i.status === 'not-shown') ? 'not-shown' : c.items.every((i) => i.status === 'shown') ? 'shown' : 'blocked';

const dir = path.resolve(process.argv[2] ?? '.verify');
const target = JSON.parse(readFileSync(path.join(dir, 'target.json'), 'utf8')) as { ref: string; commit: string; source: string; ranAt: string };
const evidence = JSON.parse(readFileSync(path.join(dir, 'evidence.json'), 'utf8')) as { title?: string; environment: string[]; claims: Claim[] };
const problems = validate(evidence);
if (problems.length > 0) {
  for (const p of problems) console.error(p);
  process.exit(1);
}

// The launcher audits the session once it ends and rebuilds the page with the verdict.
const auditFile = path.join(dir, 'audit.json');
const audit = existsSync(auditFile)
  ? (JSON.parse(readFileSync(auditFile, 'utf8')) as { verdict: string; clean: boolean; changed: string[]; credentials?: string[] })
  : null;
const trust = audit
  ? {
      state: audit.clean && audit.changed.length === 0 ? 'clean' : 'findings',
      lines: [audit.verdict, ...(audit.credentials ?? []), ...(audit.changed.length ? [`The session changed these exported files: ${audit.changed.join(', ')}. Check they don't change what was verified.`] : [])],
    }
  : { state: 'pending', lines: ['Audit: pending; the launcher audits the session when it ends.'] };
// The credential proxy's log: one line per request that carried a declared credential, never a value.
const logFile = path.join(dir, 'credential-requests.jsonl');
const credentialRequests = existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Json) : null;

// Screenshots are embedded once each, keyed by payload, however many claims cite them.
const missing: string[] = [];
const images: Record<string, string> = {};
for (const c of evidence.claims)
  for (const i of c.items) {
    if (i.type !== 'screenshot' || i.payload in images) continue;
    const file = path.join(dir, i.payload);
    if (!existsSync(file)) missing.push(`${c.id}: ${i.payload}`);
    else images[i.payload] = `data:image/png;base64,${readFileSync(file).toString('base64')}`;
  }
const claims = evidence.claims.map((c) => ({ ...c, status: claimStatus(c) }));
if (missing.length > 0) {
  for (const m of missing) console.error(`screenshot not found: ${m}`);
  process.exit(1);
}

const page = {
  ...evidence,
  title: evidence.title ?? target.source,
  target: { ref: target.ref, commit: target.commit },
  source: target.source,
  ranAt: target.ranAt,
  trust,
  claims,
  images,
  credentialRequests,
};
const template = readFileSync(new URL('../assets/evidence.html', import.meta.url), 'utf8');
const placeholder = '<script type="application/json" id="evidence">null</script>';
// `<` is escaped so no string in the evidence can close the script block early.
const json = JSON.stringify(page).replaceAll('<', '\\u003c');
writeFileSync(path.join(dir, 'evidence.html'), template.replace(placeholder, () => `<script type="application/json" id="evidence">${json}</script>`));

const counts = { shown: 0, 'not-shown': 0, blocked: 0 } as Record<string, number>;
for (const c of claims) counts[c.status]!++;
console.log(`wrote ${path.join(dir, 'evidence.html')}`);
console.log(`  ${counts.shown} shown, ${counts['not-shown']} not shown, ${counts.blocked} blocked`);
for (const c of claims.filter((c) => c.status !== 'shown')) console.log(`  ${c.id} ${c.status}: ${c.items.find((i) => i.status === c.status)?.reason ?? ''}`);
