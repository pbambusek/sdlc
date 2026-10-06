// Checks the marketplace and every plugin it lists: manifests parse, sources exist,
// and each skill folder has a SKILL.md whose `name` matches the folder and which has a description.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const problems = [];
const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    problems.push(`${file}: ${e.message}`);
    return null;
  }
};

const marketplace = readJson('.claude-plugin/marketplace.json');
for (const plugin of marketplace?.plugins ?? []) {
  const root = plugin.source;
  const manifest = readJson(join(root, '.claude-plugin/plugin.json'));
  if (!manifest) continue;
  if (manifest.name !== plugin.name) problems.push(`${root}: plugin.json name "${manifest.name}" is not "${plugin.name}"`);
  const skills = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.'));
  if (skills.length === 0) problems.push(`${root}: no skills`);
  for (const { name } of skills) {
    const file = join(root, name, 'SKILL.md');
    if (!existsSync(file)) {
      problems.push(`${file}: missing`);
      continue;
    }
    const front = readFileSync(file, 'utf8').match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
    if (front.match(/^name:\s*(.+)$/m)?.[1].trim() !== name) problems.push(`${file}: name must be "${name}"`);
    if (!/^description:\s*\S/m.test(front)) problems.push(`${file}: description missing`);
  }
}
for (const p of problems) console.error(p);
process.exit(problems.length > 0 ? 1 : 0);
