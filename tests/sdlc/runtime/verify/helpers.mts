import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach } from 'vitest';

export const runtimeDir = fileURLToPath(new URL('../../../../plugins/sdlc/runtime/verify/', import.meta.url));
export const skillDir = fileURLToPath(new URL('../../../../plugins/sdlc/skills/verify/', import.meta.url));

/** Whether a command is on PATH. */
export const has = (tool: string) => spawnSync('bash', ['-c', `command -v ${tool}`], { stdio: 'ignore' }).status === 0;

/**
 * A test name that says why it was skipped: `needs(name, 'nono')` gives the name and whether to skip, so a machine without
 * the tool reports the test as skipped with the tool named, never as passed.
 */
export const needs = (name: string, tool: string, available = has(tool)) => ({
  skip: !available,
  name: available ? name : `${name} (skipped: ${tool} is not available)`,
});

const temps: string[] = [];
/** A new empty folder, removed after the test. */
export const temp = (prefix = 'sdlc-test-') => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});
