/**
 * Audits a finished verification session's transcript for tool calls that reached outside its run folder.
 * It catches accidental reads (a path to the source repo, a config dir's transcripts, another run, or a `..` that climbs out).
 * It is not built to catch deliberate obfuscation; the verifier is not an adversary, and the page states which check ran.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

interface ToolUse {
  id: string;
  name: string;
  input: unknown;
}

export interface Audit {
  verdict: string;
  clean: boolean;
  findings: { tool: string; input: string; why: string }[];
}

export const auditTranscript = ({ transcript, denied, runsRoot, work }: { transcript: string; denied: string[]; runsRoot: string; work: string }): Audit => {
  const home = homedir();
  // Every way a path can be spelled in a command: absolute, with ~, or with $HOME.
  const spellings = (p: string) => {
    const rel = p.startsWith(home + '/') ? p.slice(home.length + 1) : null;
    return rel ? [p, `~/${rel}`, `$HOME/${rel}`, `\${HOME}/${rel}`] : [p];
  };
  const deniedSpellings = denied.flatMap(spellings).toSorted((a, b) => b.length - a.length); // most specific first
  const runsRootSpellings = spellings(runsRoot);

  const uses: ToolUse[] = [];
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
      if (event.type === 'assistant' && block.type === 'tool_use') uses.push(block as unknown as ToolUse);
      if (event.type === 'user' && block.type === 'tool_result' && block.is_error) errored.add(block.tool_use_id as string);
    }
  }

  const findings: Audit['findings'] = [];
  for (const use of uses) {
    const text = JSON.stringify(use.input);
    const hit = deniedSpellings.find((s) => text.includes(s));
    const otherRun = runsRootSpellings.some((s) => text.includes(s)) && !text.includes(work) ? 'another verification run' : null;
    const climbs = /(^|[\s"'=/])\.\.\//.test(text) ? 'a `..` path that can leave the run folder' : null;
    const why = hit ? `names ${hit}` : (otherRun ?? climbs);
    if (!why) continue;
    // A file tool that was refused (the preflight's deny-rule probe) read nothing.
    if (['Read', 'Grep', 'Glob'].includes(use.name) && errored.has(use.id)) continue;
    findings.push({ tool: use.name, input: text.slice(0, 300), why });
  }

  const verdict = findings.length
    ? `Isolation audit: VIOLATED, ${findings.length} of ${uses.length} tool calls reached outside the run folder (${findings[0]!.tool}: ${findings[0]!.why}). Treat this run as invalid.`
    : `Isolation audit: clean, none of ${uses.length} tool calls reached outside the run folder.`;
  return { verdict, clean: findings.length === 0, findings };
};
