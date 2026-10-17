// What a stage run cost: tokens, turns, tools and time, read from its Claude Code transcript and its subagents'.
// Nothing here decides anything; the archive stores a summary per run, and stats and the status page add them up.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Tokens {
  input: number;
  output: number;
  cacheRead: number;
  /** Cache writes by lifetime: they cost differently. */
  cacheWrite5m: number;
  cacheWrite1h: number;
}

export interface Usage {
  tokens: Tokens;
  /** The same tokens by model, for pricing. */
  models: Record<string, Tokens>;
  /** API responses, the main session's and its subagents'. */
  turns: number;
  tools: Record<string, number>;
  subagents: number;
  start: string | null;
  end: string | null;
  /** Wall-clock time of the main session, first line to last. Subagents run inside it. */
  seconds: number;
}

/** Dollars per million tokens. */
export interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

const zero = (): Tokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });
export const emptyUsage = (): Usage => ({ tokens: zero(), models: {}, turns: 0, tools: {}, subagents: 0, start: null, end: null, seconds: 0 });

const addTokens = (a: Tokens, b: Tokens) => {
  for (const k of Object.keys(a) as (keyof Tokens)[]) a[k] += b[k];
};

/** Adds b into a. Start and end widen; seconds add up, so a sum of runs is the time spent, not the span. */
export const addUsage = (a: Usage, b: Usage) => {
  addTokens(a.tokens, b.tokens);
  for (const [m, t] of Object.entries(b.models)) addTokens((a.models[m] ??= zero()), t);
  for (const [n, c] of Object.entries(b.tools)) a.tools[n] = (a.tools[n] ?? 0) + c;
  a.turns += b.turns;
  a.subagents += b.subagents;
  a.seconds += b.seconds;
  if (b.start && (!a.start || b.start < a.start)) a.start = b.start;
  if (b.end && (!a.end || b.end > a.end)) a.end = b.end;
  return a;
};

const tokensOf = (u: any): Tokens => {
  const writes = u.cache_creation_input_tokens ?? 0;
  const oneHour = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  return {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite5m: writes - oneHour,
    cacheWrite1h: oneHour,
  };
};

/**
 * One transcript file. Claude Code writes a line per content block, each repeating its response's usage, so a response
 * counts once, by message id, with the usage of its last line.
 */
const readTranscript = (path: string) => {
  const responses = new Map<string, { model: string; tokens: Tokens }>();
  const tools: Record<string, number> = {};
  const seenTools = new Set<string>();
  let start: string | null = null;
  let end: string | null = null;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line) continue;
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      continue; // a session still writing can end in half a line
    }
    if (typeof d.timestamp === 'string') {
      start ??= d.timestamp;
      end = d.timestamp;
    }
    const m = d.type === 'assistant' ? d.message : null;
    if (!m) continue;
    // Claude Code's own placeholder replies carry no usage and no real model.
    if (m.id && m.usage && m.model && m.model !== '<synthetic>') responses.set(m.id, { model: m.model, tokens: tokensOf(m.usage) });
    for (const c of Array.isArray(m.content) ? m.content : []) {
      if (c?.type !== 'tool_use' || seenTools.has(c.id)) continue;
      seenTools.add(c.id);
      tools[c.name] = (tools[c.name] ?? 0) + 1;
    }
  }
  const u = emptyUsage();
  for (const r of responses.values()) {
    addTokens(u.tokens, r.tokens);
    addTokens((u.models[r.model] ??= zero()), r.tokens);
  }
  u.turns = responses.size;
  u.tools = tools;
  u.start = start;
  u.end = end;
  u.seconds = start && end ? Math.round((Date.parse(end) - Date.parse(start)) / 1000) : 0;
  return u;
};

/** A session: `<id>.jsonl`, plus `<id>/subagents/*.jsonl` beside it when it spawned any. */
export const sessionUsage = (transcript: string): Usage => {
  const u = readTranscript(transcript);
  const dir = join(transcript.replace(/\.jsonl$/, ''), 'subagents');
  if (!existsSync(dir)) return u;
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.jsonl'))) {
    const s = readTranscript(join(dir, f));
    s.seconds = 0;
    s.start = s.end = null;
    addUsage(u, s);
    u.subagents++;
  }
  return u;
};

// List prices, 2026-10. Cache writes are 1.25× input for 5 minutes and 2× for an hour; reads 0.1× unless listed.
export const DEFAULT_PRICES: Record<string, Price> = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25, cacheWrite5m: 12.5, cacheWrite1h: 20 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite5m: 0.125, cacheWrite1h: 0.2 },
};

/** A model's price: an exact id, else the longest listed id it starts with (a dated or `[1m]` variant). */
const priceOf = (model: string, prices: Record<string, Price>) =>
  prices[model] ??
  Object.entries(prices)
    .filter(([id]) => model.startsWith(id))
    .sort((a, b) => b[0].length - a[0].length)[0]?.[1];

/** Dollars at list price, and the models it could not price (their tokens are left out). */
export const cost = (u: Usage, prices: Record<string, Price>) => {
  let usd = 0;
  const unpriced: string[] = [];
  for (const [model, t] of Object.entries(u.models)) {
    const p = priceOf(model, prices);
    if (!p) {
      unpriced.push(model);
      continue;
    }
    usd += (t.input * p.input + t.output * p.output + t.cacheRead * p.cacheRead + t.cacheWrite5m * p.cacheWrite5m + t.cacheWrite1h * p.cacheWrite1h) / 1e6;
  }
  return { usd, unpriced };
};

/** Share of input served from the cache. */
export const cacheHit = (t: Tokens) => {
  const all = t.input + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h;
  return all ? t.cacheRead / all : 0;
};

// ---- formatting, shared by stats and the status page

export const fmtTokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
export const fmtUsd = (n: number) => (n >= 100 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`);
export const fmtDuration = (s: number) => (s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`);
