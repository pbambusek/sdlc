/**
 * Reads the frontmatter of a project's root VERIFY.md: what the launcher needs to prepare a run and clean up after it.
 * Starting and waiting for the system are the verifier's job, with the project's own commands from the VERIFY.md body.
 * The format is a small YAML subset: `key: value`, a list as `[a, b]` or `- a` lines, and one level of `key: value` map.
 * Full-line `#` comments are skipped; a `#` inside a value is part of it, so commands keep their shell syntax.
 */

export interface VerifyConfig {
  install: string;
  copy: string[];
  writable: string[];
  env: Record<string, string>;
  stop?: string;
}

const unquote = (s: string) => s.trim().replace(/^(['"])(.*)\1$/, '$2');

const parseFrontmatter = (text: string): Record<string, string | string[] | Record<string, string>> => {
  const match = /^---\n([\s\S]*?)\n---(\n|$)/.exec(text);
  if (!match) throw new Error('VERIFY.md has no frontmatter; the root VERIFY.md needs one (see the template)');
  const out: Record<string, string | string[] | Record<string, string>> = {};
  let open: string | null = null;
  for (const raw of match[1]!.split('\n')) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const indented = /^\s+/.test(raw);
    const line = raw.trim();
    if (indented && open) {
      const current = out[open];
      if (line.startsWith('- ')) {
        out[open] = [...(Array.isArray(current) ? current : []), unquote(line.slice(2))];
      } else {
        const sep = line.indexOf(':');
        if (sep < 0) throw new Error(`VERIFY.md frontmatter: cannot read "${line}" under ${open}`);
        const map = current && !Array.isArray(current) && typeof current === 'object' ? current : {};
        out[open] = { ...map, [line.slice(0, sep).trim()]: unquote(line.slice(sep + 1)) };
      }
      continue;
    }
    const sep = line.indexOf(':');
    if (sep < 0) throw new Error(`VERIFY.md frontmatter: cannot read "${line}"`);
    const key = line.slice(0, sep).trim();
    const value = line.slice(sep + 1).trim();
    open = null;
    if (value === '') {
      open = key;
      out[key] = {};
    } else if (value.startsWith('[') && value.endsWith(']')) {
      out[key] = value.slice(1, -1).split(',').map(unquote).filter(Boolean);
    } else {
      out[key] = unquote(value);
    }
  }
  return out;
};

const list = (v: unknown, key: string): string[] => {
  if (v === undefined) return [];
  // An empty `key:` with nothing under it reads as an empty map.
  if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) return [];
  if (!Array.isArray(v)) throw new Error(`VERIFY.md frontmatter: ${key} must be a list`);
  return v;
};

const text = (v: unknown, key: string, required: boolean): string | undefined => {
  if (v === undefined || v === '') {
    if (required) throw new Error(`VERIFY.md frontmatter: ${key} is required`);
    return undefined;
  }
  if (typeof v !== 'string') throw new Error(`VERIFY.md frontmatter: ${key} must be one line of text`);
  return v;
};

export const readConfig = (verifyMd: string): VerifyConfig => {
  const raw = parseFrontmatter(verifyMd);
  const env = raw.env ?? {};
  if (Array.isArray(env) || typeof env !== 'object') throw new Error('VERIFY.md frontmatter: env must be a map');
  return {
    install: text(raw.install, 'install', true)!,
    copy: list(raw.copy, 'copy'),
    writable: list(raw.writable, 'writable'),
    env,
    stop: text(raw.stop, 'stop', false),
  };
};
