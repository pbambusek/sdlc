/**
 * Audits a finished verification session for anything that would make its verdicts dishonest:
 *   - a tool call that reached for how the code was written: a path under the home folder outside the run folder (any
 *     agent's transcripts and memory live there), the source repo, a `..` that climbs out, git history, a PR or ticket,
 *     or a connector;
 * It catches accidental reach, not deliberate obfuscation; the page states the verdict.
 * It also lists the exported files the session changed. Installs and dev servers rewrite some (a lockfile, a generated
 * config), so they are shown for the reviewer to judge, not counted against the run.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';

export interface Audit {
  verdict: string;
  clean: boolean;
  findings: { tool: string; input: string; why: string }[];
  changed: string[];
  // Set by the launcher when VERIFY.md declares credentials: what the run held, and whether a real value leaked.
  credentials?: string[];
}

// Package and tool caches under the home folder that a run may name without learning anything about the code.
const CACHES = ['.cache', 'Library/Caches', '.npm', '.yarn', '.pnpm-store', '.bun', '.nvm', '.local/bin', '.cargo', '.rustup', '.dotnet', '.nuget', '.m2', '.gradle'];

// Commands and addresses that fetch the story of the change rather than the system's behaviour.
const STORY = [
  [/\bgit\s+(log|show|diff|blame|reflog)\b/, 'reads git history'],
  [/\bgh\s+(pr|issue|api|search|run)\b/, 'reads a PR, issue or run'],
  [/\bacli\b/, 'reads the tracker'],
  [/github\.com|atlassian\.net/, 'opens GitHub or Atlassian'],
] as const;

const hash = (p: string) => {
  if (!existsSync(p)) return null;
  return createHash('sha1').update(lstatSync(p).isSymbolicLink() ? readlinkSync(p) : readFileSync(p)).digest('hex');
};

/** A hash of every exported file, taken before the session, to find what it changed. */
export const snapshot = (root: string): Map<string, string> => {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (lstatSync(p).isDirectory()) walk(p);
      else out.set(relative(root, p), hash(p)!);
    }
  };
  walk(root);
  return out;
};

export const audit = ({ transcript, work, repos, allowed, before }: { transcript: string | null; work: string; repos: string[]; allowed: string[]; before: Map<string, string> }): Audit => {
  const changed = [...before].filter(([p, h]) => hash(join(work, p)) !== h).map(([p]) => p);

  if (!transcript || !existsSync(transcript)) {
    return { verdict: 'Audit: not run, the session transcript was not found. Treat this run as invalid.', clean: false, findings: [], changed };
  }

  const home = homedir();
  const homeSpellings = [home, '~', '$HOME', '${HOME}'];
  const inside = (p: string, dir: string) => p === dir || p.startsWith(dir + '/');
  const okHome = [work, ...allowed, ...CACHES.map((c) => join(home, c))];
  // Every path under the home folder that the input names, as an absolute path.
  const homePaths = (text: string) =>
    homeSpellings.flatMap((s) => [...text.matchAll(new RegExp(`${s.replace(/[$.{}]/g, '\\$&')}(/[^\\s"'\`;|&<>)]*)`, 'g'))].map((m) => home + m[1]));

  const uses: { id: string; name: string; input: unknown }[] = [];
  const errored = new Set<string>();
  for (const line of readFileSync(transcript, 'utf8').split('\n')) {
    let event: { type?: string; message?: { content?: unknown } };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const content = Array.isArray(event.message?.content) ? (event.message.content as Record<string, unknown>[]) : [];
    for (const block of content) {
      if (event.type === 'assistant' && block.type === 'tool_use') uses.push(block as unknown as (typeof uses)[number]);
      if (event.type === 'user' && block.type === 'tool_result' && block.is_error) errored.add(block.tool_use_id as string);
    }
  }

  const findings: Audit['findings'] = [];
  for (const use of uses) {
    const text = JSON.stringify(use.input);
    const why =
      (use.name.startsWith('mcp__') ? 'uses a connector' : null) ??
      (repos.find((r) => text.includes(r) && !inside(work, r)) ? 'names the source repo' : null) ??
      homePaths(text).map((p) => (okHome.some((d) => inside(p, d)) ? null : `names ${p}`)).find(Boolean) ??
      STORY.find(([re]) => re.test(text))?.[1] ??
      (/(^|[\s"'=/])\.\.\//.test(text) ? 'a `..` path that can leave the run folder' : null);
    if (!why) continue;
    // A file tool that was refused read nothing.
    if (['Read', 'Grep', 'Glob'].includes(use.name) && errored.has(use.id)) continue;
    findings.push({ tool: use.name, input: text.slice(0, 300), why });
  }

  const verdict = findings.length
    ? `Audit: VIOLATED, ${findings.length} of ${uses.length} tool calls reached for how the code was written (${findings[0]!.tool}: ${findings[0]!.why}). Treat this run as invalid.`
    : `Audit: clean, none of ${uses.length} tool calls reached for how the code was written.`;
  return { verdict, clean: findings.length === 0, findings, changed };
};
