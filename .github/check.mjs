// Checks the marketplace and every plugin it lists:
//   - manifests parse, sources exist, and each skill folder has a SKILL.md whose `name` matches the folder and which has a description;
//   - every file a skill's Markdown names (`<skill dir>/…`, `<runtime dir>/…`, or a relative link) exists;
//   - the plugin holds no tests, fixtures or evals, so installs never carry them;
//   - runtime code imports only Node's standard library and other runtime files, so it runs without an install.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const problems = [];
const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    problems.push(`${file}: ${e.message}`);
    return null;
  }
};
const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? [p, ...walk(p)] : [p];
  });
const inside = (p, dir) => p === dir || p.startsWith(dir + '/');

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const TEST_DIR = new Set(['test', 'tests', '__tests__', 'fixtures', 'evals']);

const marketplace = readJson('.claude-plugin/marketplace.json');
for (const plugin of marketplace?.plugins ?? []) {
  const root = plugin.source;
  const manifest = readJson(join(root, '.claude-plugin/plugin.json'));
  if (!manifest) continue;
  if (manifest.name !== plugin.name) problems.push(`${root}: plugin.json name "${manifest.name}" is not "${plugin.name}"`);
  const skillsRoots = (manifest.skills ?? ['./skills/']).map((s) => join(root, s));
  const runtime = join(root, 'runtime');

  for (const skillsRoot of skillsRoots) {
    const skills = existsSync(skillsRoot) ? readdirSync(skillsRoot, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')) : [];
    if (skills.length === 0) problems.push(`${skillsRoot}: no skills`);
    for (const { name } of skills) {
      const skillDir = join(skillsRoot, name);
      const file = join(skillDir, 'SKILL.md');
      if (!existsSync(file)) {
        problems.push(`${file}: missing`);
        continue;
      }
      const front = readFileSync(file, 'utf8').match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
      if (front.match(/^name:\s*(.+)$/m)?.[1].trim() !== name) problems.push(`${file}: name must be "${name}"`);
      if (!/^description:\s*\S/m.test(front)) problems.push(`${file}: description missing`);

      for (const md of walk(skillDir).filter((p) => p.endsWith('.md'))) {
        const text = readFileSync(md, 'utf8');
        const named = [
          ...[...text.matchAll(/<skill dir>\/([\w./-]*[\w/])/g)].map((m) => [m[0], join(skillDir, m[1])]),
          ...[...text.matchAll(/<runtime dir>\/([\w./-]*[\w/])/g)].map((m) => [m[0], join(runtime, name, m[1])]),
          // Relative links outside fenced code, where examples may show links that are not this repo's.
          ...[...text.replace(/^```[\s\S]*?^```/gm, '').matchAll(/\]\(([^)\s#]+)(#[^)]*)?\)/g)]
            .filter((m) => !/^[a-z]+:/i.test(m[1]) && !m[1].includes('<'))
            .map((m) => [m[1], join(dirname(md), m[1])]),
        ];
        for (const [as, path] of named) if (!existsSync(path)) problems.push(`${md}: names ${as}, which does not exist (${path})`);
      }
    }
  }

  for (const p of walk(root)) {
    const name = p.split('/').pop();
    if (statSync(p).isDirectory() ? TEST_DIR.has(name) : TEST_FILE.test(name))
      problems.push(`${p}: tests, fixtures and evals live under tests/, outside the plugin, so installs never carry them`);
  }

  if (existsSync(runtime))
    for (const file of walk(runtime).filter((p) => /\.[cm]?[jt]s$/.test(p))) {
      const text = readFileSync(file, 'utf8');
      const specifiers = [
        ...text.matchAll(/(?:^|\s)(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]|^import\s+['"]([^'"]+)['"]/gm),
      ].map((m) => m[1] ?? m[2] ?? m[3]);
      for (const s of specifiers) {
        const ok = s.startsWith('node:') || (s.startsWith('.') && inside(resolve(dirname(file), s), resolve(runtime)));
        if (!ok) problems.push(`${file}: imports "${s}"; the runtime may import only node: modules and other runtime files`);
      }
    }
}
for (const p of problems) console.error(p);
process.exit(problems.length > 0 ? 1 : 0);
