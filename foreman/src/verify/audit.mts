/**
 * Audits a finished verification session for a tool call that reached for the story of the change rather than the system's
 * behaviour: git history, a PR or ticket, or a connector. Paths on the host are not its job: the workspace VM doesn't have them.
 * It catches accidental reach, not deliberate obfuscation. A flagged call is a warning: the page lists it for a person to
 * judge, and every claim keeps the status its evidence gives it.
 * It also carries the exported files the session changed. Installs and dev servers rewrite some (a lockfile, a generated
 * config), so they are shown for the reviewer to judge, not counted against the run.
 */
import { existsSync, readFileSync } from 'node:fs';

export interface Audit {
  verdict: string;
  clean: boolean;
  findings: { tool: string; input: string; why: string }[];
  changed: string[];
  // Set by the launcher when VERIFY.md declares credentials: what the run held, and whether a real value leaked.
  credentials?: string[];
  // Set by the launcher: the workspace the commands ran in.
  workspace?: string[];
}

// Commands and addresses that fetch the story of the change rather than the system's behaviour.
const STORY = [
  [/\bgit\s+(log|show|diff|blame|reflog)\b/, 'reads git history'],
  [/\bgh\s+(pr|issue|api|search|run)\b/, 'reads a PR, issue or run'],
  [/\bacli\b/, 'reads the tracker'],
  [/github\.com|atlassian\.net/, 'opens GitHub or Atlassian'],
] as const;

// Every string in a tool call's input. The patterns match these, not the input's JSON, where a newline is `\n` and glues the
// next command to the word before it.
const strings = (v: unknown): string[] =>
  typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : [];

export const audit = ({ transcript, changed }: { transcript: string | null; changed: string[] }): Audit => {
  if (!transcript || !existsSync(transcript)) {
    return {
      verdict: 'Audit: not run, the session transcript was not found. The claims keep the status their evidence gives them.',
      clean: false,
      findings: [],
      changed,
    };
  }

  const uses: { name: string; input: unknown }[] = [];
  for (const line of readFileSync(transcript, 'utf8').split('\n')) {
    let event: { type?: string; message?: { content?: unknown } };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const content = Array.isArray(event.message?.content) ? (event.message.content as Record<string, unknown>[]) : [];
    for (const block of content) if (event.type === 'assistant' && block.type === 'tool_use') uses.push(block as unknown as (typeof uses)[number]);
  }

  const findings: Audit['findings'] = [];
  for (const use of uses) {
    const text = strings(use.input).join('\n');
    const why = (use.name.startsWith('mcp__') ? 'uses a connector' : null) ?? STORY.find(([re]) => re.test(text))?.[1];
    if (why) findings.push({ tool: use.name, input: JSON.stringify(use.input).slice(0, 300), why });
  }

  const verdict = findings.length
    ? `Audit: ${findings.length} of ${uses.length} tool calls flagged as reaching for how the code was written (${findings[0]!.tool}: ${findings[0]!.why}). The claims keep the status their evidence gives them; check the flagged calls.`
    : `Audit: clean, none of ${uses.length} tool calls reached for how the code was written.`;
  return { verdict, clean: findings.length === 0, findings, changed };
};
