import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A copy of the repo's marketplace and plugins, to break on purpose. */
const copy = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-check-')));
  temps.push(dir);
  for (const p of ['.claude-plugin', 'plugins', '.github']) cpSync(join(repoRoot, p), join(dir, p), { recursive: true });
  return dir;
};
const check = (cwd: string) => spawnSync(process.execPath, ['.github/check.mjs'], { cwd, encoding: 'utf8' });
const verify = 'plugins/sdlc/skills/verify';

describe('the repo check', () => {
  it('passes on the repo as it is', () => {
    const out = check(repoRoot);
    expect(out.stderr).toBe('');
    expect(out.status).toBe(0);
  });

  it('names the skill file and the path when a skill names a runtime file that does not exist', () => {
    const dir = copy();
    appendFileSync(join(dir, verify, 'run.md'), '\nRun `node <runtime dir>/missing.mts`.\n');
    const out = check(dir);
    expect(out.status).toBe(1);
    expect(out.stderr).toContain(`${verify}/run.md: names <runtime dir>/missing.mts, which does not exist (plugins/sdlc/runtime/verify/missing.mts)`);
  });

  it('names a broken `<skill dir>` path and a broken relative link', () => {
    const dir = copy();
    appendFileSync(join(dir, verify, 'SKILL.md'), '\nSee `<skill dir>/assets/gone.json` and [the notes](notes.md).\n');
    const out = check(dir);
    expect(out.stderr).toContain(`${verify}/SKILL.md: names <skill dir>/assets/gone.json, which does not exist`);
    expect(out.stderr).toContain(`${verify}/SKILL.md: names notes.md, which does not exist`);
  });

  it('names a test file and a fixtures folder inside the plugin', () => {
    const dir = copy();
    writeFileSync(join(dir, 'plugins/sdlc/runtime/verify/audit.test.mts'), '');
    mkdirSync(join(dir, verify, 'fixtures'));
    const out = check(dir);
    expect(out.status).toBe(1);
    expect(out.stderr).toContain('plugins/sdlc/runtime/verify/audit.test.mts: tests, fixtures and evals live under tests/');
    expect(out.stderr).toContain(`${verify}/fixtures: tests, fixtures and evals live under tests/`);
  });

  it('names a runtime file that imports a package or reaches outside the runtime', () => {
    const dir = copy();
    writeFileSync(
      join(dir, 'plugins/sdlc/runtime/verify/extra.mts'),
      "import { z } from 'zod';\nimport x from '../../skills/verify/x.mts';\nimport { join } from 'node:path';\n",
    );
    const out = check(dir);
    expect(out.status).toBe(1);
    expect(out.stderr).toContain('plugins/sdlc/runtime/verify/extra.mts: imports "zod"');
    expect(out.stderr).toContain('plugins/sdlc/runtime/verify/extra.mts: imports "../../skills/verify/x.mts"');
    expect(out.stderr).not.toContain('node:path');
  });

  it('names a skill whose name does not match its folder', () => {
    const dir = copy();
    mkdirSync(join(dir, 'plugins/sdlc/skills/extra'));
    writeFileSync(join(dir, 'plugins/sdlc/skills/extra/SKILL.md'), '---\nname: other\ndescription: x\n---\n');
    expect(check(dir).stderr).toContain('plugins/sdlc/skills/extra/SKILL.md: name must be "extra"');
  });
});
