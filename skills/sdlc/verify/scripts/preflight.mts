/**
 * Proves the session was isolated by construction before anything is verified. Run it from the run folder:
 *   node <skill dir>/scripts/preflight.mts
 * Exits 1 and prints every failed check when the isolation is broken; the run must then stop without a page.
 * On success it writes .verify/preflight.json, which the page builder turns into an environment line, and prints
 * one denied file for the verifier to probe with its own Read tool.
 * What can't be prevented by construction (a shell command reading outside this folder) is caught afterwards by the
 * launcher's transcript audit, which the page also shows.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const root = process.cwd();
const checks: { check: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail: string) => checks.push({ check: name, ok, detail });

const targetFile = join(root, '.verify/run/target.json');
const isolationFile = join(root, '.verify/run/isolation.json');
check('started by the launcher', existsSync(targetFile) && existsSync(isolationFile), '.verify/run/target.json and isolation.json');
const target = existsSync(targetFile) ? JSON.parse(readFileSync(targetFile, 'utf8')) : {};
const isolation = existsSync(isolationFile)
  ? JSON.parse(readFileSync(isolationFile, 'utf8'))
  : { runsRoot: null, readOnly: [], denied: [], probe: null };

let gitVisible = true;
try {
  execFileSync('git', ['rev-parse', '--git-dir'], { cwd: root, stdio: 'pipe' });
} catch {
  gitVisible = false;
}
check('no git history in reach', !gitVisible && !existsSync(join(root, '.git')), 'the target is an export, not a checkout');
check('git search stops at the run root', process.env.GIT_CEILING_DIRECTORIES === isolation.runsRoot, 'GIT_CEILING_DIRECTORIES');
check('auto-memory off', process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY === '1', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY=1');
check('outside the source repo, in the run folder', dirname(root) === isolation.runsRoot, root);

// A folder gets a new probe file; a file is opened for appending nothing. File permissions must refuse both.
const writeDenied = (p: string) => {
  try {
    if (statSync(p).isDirectory()) {
      writeFileSync(join(p, '.verify-probe'), 'probe');
      rmSync(join(p, '.verify-probe'));
    } else appendFileSync(p, '');
    return false;
  } catch (e) {
    return ['EPERM', 'EACCES'].includes((e as NodeJS.ErrnoException).code ?? '');
  }
};
const probes = [...(isolation.readOnly as string[]).map((e) => join(root, e)), join(root, '.verify/run')].filter((p) => existsSync(p));
const writable = probes.filter((p) => !writeDenied(p)).map((p) => p.slice(root.length + 1));
check(
  'exported tree is read-only',
  writable.length === 0,
  writable.length
    ? `writable: ${writable.slice(0, 5).join(', ')}${writable.length > 5 ? ` and ${writable.length - 5} more` : ''}`
    : `${probes.length} entries`,
);

for (const c of checks) console.log(`${c.ok ? '✔' : '✖'} ${c.check} (${c.detail})`);
if (!checks.every((c) => c.ok)) {
  console.error('ISOLATION BROKEN: stop the run, write no page, and report the failed checks.');
  process.exit(1);
}
writeFileSync(join(root, '.verify/preflight.json'), JSON.stringify({ target, checks }, null, 2) + '\n');
console.log('isolation ok');
console.log(`now read this denied file with your Read tool; it must be refused by permission: ${isolation.probe}`);
