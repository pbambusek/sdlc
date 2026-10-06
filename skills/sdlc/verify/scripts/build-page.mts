/**
 * Builds `<dir>/evidence.html` from `<dir>/evidence.json` and the locked template, inlining every screenshot.
 * Usage: `node .claude/skills/verify/scripts/build-page.mts [dir, default .verify]`, from the run folder.
 * Exits 1 and lists every problem when the JSON is malformed, when the preflight has not passed, or when the evidence
 * names another commit than the one under verification. The preflight result, the launcher's transcript audit and the
 * skill version become the first environment lines, so every page states how isolated its run was and which method ran.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const STATUSES = ['shown', 'not-shown', 'blocked'];
const ITEM_TYPES = ['screenshot', 'http', 'command', 'trace', 'event'];

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const isText = (v: unknown) => typeof v === 'string' && v.length > 0;

/** Returns every problem in the evidence, each prefixed with its JSON path. */
const validate = (e: unknown): string[] => {
  const problems: string[] = [];
  const need = (ok: boolean, where: string, what: string) => ok || problems.push(`${where}: ${what}`);
  if (!isObject(e)) return ['(root): must be an object'];
  need(isText(e.title), 'title', 'required text');
  need(isText(e.ranAt), 'ranAt', 'required text');
  const target = e.target;
  need(isObject(target) && isText(target.ref), 'target.ref', 'required text');
  need(isObject(target) && /^[0-9a-f]{40}$/.test(String(target.commit)), 'target.commit', 'a full 40-character commit SHA');
  need(Array.isArray(e.environment) && e.environment.length > 0 && e.environment.every(isText), 'environment', 'a non-empty list of text');
  if (!Array.isArray(e.claims) || e.claims.length === 0) return [...problems, 'claims: a non-empty list'];
  e.claims.forEach((c: unknown, ci) => {
    const at = `claims.${ci}`;
    if (!isObject(c)) return problems.push(`${at}: must be an object`);
    for (const k of ['id', 'text', 'source']) need(isText(c[k]), `${at}.${k}`, 'required text');
    need(c.origin === 'quoted' || c.origin === 'extracted', `${at}.origin`, '"quoted" or "extracted"');
    need(c.blocked === undefined || isText(c.blocked), `${at}.blocked`, 'text when present');
    if (!Array.isArray(c.items)) return problems.push(`${at}.items: a list`);
    need((c.items.length === 0) === isText(c.blocked), at, 'a claim has either items or a `blocked` reason, never both and never neither');
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

const dir = path.resolve(process.argv[2] ?? '.verify');
const preflightFile = path.join(dir, 'preflight.json');
if (!existsSync(preflightFile)) {
  console.error('no passed preflight: run scripts/preflight.mts first; a run without one gets no page');
  process.exit(1);
}
const preflight = JSON.parse(readFileSync(preflightFile, 'utf8')) as {
  target: { commit: string; skill?: string };
  checks: { check: string; ok: boolean }[];
};

const evidence = JSON.parse(readFileSync(path.join(dir, 'evidence.json'), 'utf8')) as {
  target: { commit: string };
  environment: string[];
  claims: { id: string; items: { type: string; payload: string }[] }[];
};
const problems = validate(evidence);
if (problems.length > 0) {
  for (const p of problems) console.error(p);
  process.exit(1);
}
if (evidence.target.commit !== preflight.target.commit) {
  console.error(`target.commit must be ${preflight.target.commit}, the commit under verification`);
  process.exit(1);
}

const passed = preflight.checks.filter((c) => c.ok).length;
const isolation = `Isolation by construction: ${passed}/${preflight.checks.length} preflight checks passed (${preflight.checks.map((c) => c.check).join('; ')}).`;
// The launcher audits the session's transcript once it ends and rebuilds the page with the verdict.
const auditFile = path.join(dir, 'audit.json');
const audit = existsSync(auditFile)
  ? (JSON.parse(readFileSync(auditFile, 'utf8')) as { verdict: string }).verdict
  : 'Isolation audit: pending; the launcher checks the transcript when the session ends.';
const method = `Method: the verify skill at ${preflight.target.skill ?? 'an unrecorded version'}.`;

const missing: string[] = [];
const claims = evidence.claims.map((c) => ({
  ...c,
  items: c.items.map((i) => {
    if (i.type !== 'screenshot') return i;
    const file = path.join(dir, i.payload);
    if (!existsSync(file)) return (missing.push(`${c.id}: ${i.payload}`), i);
    return { ...i, src: `data:image/png;base64,${readFileSync(file).toString('base64')}` };
  }),
}));
if (missing.length > 0) {
  for (const m of missing) console.error(`screenshot not found: ${m}`);
  process.exit(1);
}

const template = readFileSync(new URL('../assets/evidence.html', import.meta.url), 'utf8');
const placeholder = '<script type="application/json" id="evidence">null</script>';
// `<` is escaped so no string in the evidence can close the script block early.
const json = JSON.stringify({ ...evidence, environment: [isolation, audit, method, ...evidence.environment], claims }).replaceAll('<', '\\u003c');
writeFileSync(path.join(dir, 'evidence.html'), template.replace(placeholder, () => `<script type="application/json" id="evidence">${json}</script>`));
console.log(`wrote ${path.join(dir, 'evidence.html')}`);
