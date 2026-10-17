/**
 * Builds `<dir>/evidence.html` from `<dir>/evidence.json` and the locked template, inlining every screenshot, and prints
 * the summary: the counts of shown, not-shown and blocked claims, and each claim that is not shown with its reason.
 * Usage: `node <runtime dir>/build-page.mts [dir, default .verify]`, from the run folder.
 * Exits 1 and lists every problem when the evidence is malformed. The target and the source come from the runner's
 * `target.json`, and its audit becomes the page's trust line. A screenshot cited by several claims is embedded once.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { type Claim, claimStatus, type Json, validate } from './evidence.mts';

const dir = path.resolve(process.argv[2] ?? '.verify');
const target = JSON.parse(readFileSync(path.join(dir, 'target.json'), 'utf8')) as { ref: string; commit: string; source: string; ranAt: string };
const evidence = JSON.parse(readFileSync(path.join(dir, 'evidence.json'), 'utf8')) as { title?: string; environment: string[]; claims: Claim[] };
const problems = validate(evidence);
if (problems.length > 0) {
  for (const p of problems) console.error(p);
  process.exit(1);
}

// The runner audits the session once it ends and rebuilds the page with the verdict.
const auditFile = path.join(dir, 'audit.json');
const audit = existsSync(auditFile)
  ? (JSON.parse(readFileSync(auditFile, 'utf8')) as { verdict: string; clean: boolean; changed: string[]; credentials?: string[]; workspace?: string[] })
  : null;
const trust = audit
  ? {
      state: audit.clean && audit.changed.length === 0 ? 'clean' : 'findings',
      lines: [
        audit.verdict,
        ...(audit.workspace ?? []),
        ...(audit.credentials ?? []),
        ...(audit.changed.length ? [`The session changed these exported files: ${audit.changed.join(', ')}. Check they don't change what was verified.`] : []),
      ],
    }
  : { state: 'pending', lines: ['Audit: pending; the runner audits the session when it ends.'] };
// The credential proxy's log: one line per request that carried a declared credential, never a value.
const logFile = path.join(dir, 'credential-requests.jsonl');
const credentialRequests = existsSync(logFile)
  ? readFileSync(logFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Json)
  : null;

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
const template = readFileSync(new URL('../../skills/verify/assets/evidence.html', import.meta.url), 'utf8');
const placeholder = '<script type="application/json" id="evidence">null</script>';
// `<` is escaped so no string in the evidence can close the script block early.
const json = JSON.stringify(page).replaceAll('<', '\\u003c');
writeFileSync(
  path.join(dir, 'evidence.html'),
  template.replace(placeholder, () => `<script type="application/json" id="evidence">${json}</script>`),
);

const counts = { shown: 0, 'not-shown': 0, blocked: 0 } as Record<string, number>;
for (const c of claims) counts[c.status]!++;
console.log(`wrote ${path.join(dir, 'evidence.html')}`);
console.log(`  ${counts.shown} shown, ${counts['not-shown']} not shown, ${counts.blocked} blocked`);
for (const c of claims.filter((c) => c.status !== 'shown')) console.log(`  ${c.id} ${c.status}: ${c.items.find((i) => i.status === c.status)?.reason ?? ''}`);
