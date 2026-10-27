import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach } from 'vitest';

export const skillDir = fileURLToPath(new URL('../../../../plugins/sdlc/skills/verify/', import.meta.url));
export const scriptsDir = join(skillDir, 'scripts');

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
