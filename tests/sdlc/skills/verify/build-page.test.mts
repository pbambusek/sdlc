import { spawnSync } from 'node:child_process';
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scriptsDir, skillDir, temp } from './helpers.mts';

/** A run folder's `.verify` holding the skill's example evidence and the launcher's target file. */
const runFolder = () => {
  const dir = temp();
  cpSync(join(skillDir, 'assets/example'), dir, { recursive: true });
  writeFileSync(join(dir, 'target.json'), JSON.stringify({ ref: 'main', commit: 'abc1234def', source: 'specs/feature.md', ranAt: '2026-01-01T00:00:00Z' }));
  return dir;
};
const build = (dir: string) => spawnSync(process.execPath, [join(scriptsDir, 'build-page.mts'), dir], { encoding: 'utf8' });
// The page carries its data as JSON in one script block.
const pageData = (dir: string) =>
  JSON.parse(
    readFileSync(join(dir, 'evidence.html'), 'utf8')
      .match(/<script type="application\/json" id="evidence">(.*?)<\/script>/s)![1]!
      .replaceAll('\\u003c', '<'),
  );

describe('build-page', () => {
  it('writes the page from the evidence and prints the summary', () => {
    const dir = runFolder();
    const out = build(dir);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain(`wrote ${join(dir, 'evidence.html')}`);
    expect(out.stdout).toContain('3 shown, 0 not shown, 1 blocked');
    expect(out.stdout).toMatch(/C15 blocked: \S/);
    const page = pageData(dir);
    expect(page).toMatchObject({ target: { ref: 'main', commit: 'abc1234def' }, source: 'specs/feature.md', trust: { state: 'pending' } });
    expect(Object.keys(page.images)).toEqual(['shots/c5-matches-mixed-stages.png']);
    expect(page.images['shots/c5-matches-mixed-stages.png']).toMatch(/^data:image\/png;base64,/);
  });

  it("carries the launcher's audit as the page's trust line", () => {
    const dir = runFolder();
    writeFileSync(
      join(dir, 'audit.json'),
      JSON.stringify({ verdict: 'Audit: clean, none of 3 tool calls reached for how the code was written.', clean: true, changed: [] }),
    );
    expect(build(dir).status).toBe(0);
    expect(pageData(dir).trust).toEqual({ state: 'clean', lines: ['Audit: clean, none of 3 tool calls reached for how the code was written.'] });
  });

  it('escapes `<` so no evidence text can close the script block', () => {
    const dir = runFolder();
    const evidence = JSON.parse(readFileSync(join(dir, 'evidence.json'), 'utf8'));
    evidence.title = '</script><b>x</b>';
    writeFileSync(join(dir, 'evidence.json'), JSON.stringify(evidence));
    expect(build(dir).status).toBe(0);
    expect(readFileSync(join(dir, 'evidence.html'), 'utf8')).not.toContain('</script><b>');
    expect(pageData(dir).title).toBe('</script><b>x</b>');
  });

  it('lists every schema problem and exits 1 on malformed evidence', () => {
    const dir = runFolder();
    writeFileSync(join(dir, 'evidence.json'), JSON.stringify({ environment: [], claims: [{ id: 'C1' }] }));
    const out = build(dir);
    expect(out.status).toBe(1);
    expect(out.stderr).toContain('claims.0.text: required text');
    expect(out.stderr).toContain('claims.0.items: a non-empty list');
  });

  it('names a missing screenshot and exits 1', () => {
    const dir = runFolder();
    rmSync(join(dir, 'shots'), { recursive: true });
    const out = build(dir);
    expect(out.status).toBe(1);
    expect(out.stderr).toMatch(/screenshot not found: \S+: shots\/c5-matches-mixed-stages\.png/);
  });
});
