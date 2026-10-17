// One append-only log for everything sdlc does on this machine: every tick (launchd, by hand, dry run, --only), every
// action and error, and every verify launcher's exit. Never rotated or rewritten; nothing reads it to decide anything.
import { appendFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { HOME } from './config.mts';

export const journalPath = () => join(HOME, 'sdlc.log');

/** Who started this process: launchd sets SDLC_SOURCE in the plist; anything else was a person. */
export const source = () => process.env.SDLC_SOURCE ?? 'manual';

/**
 * A writer for one run of a command. Every line is `<ISO time> [<command> <run id> <source>] <text>`, so a run's lines
 * grep together and a multi-line message keeps its prefix on each line.
 */
export const journal = (command: string) => {
  const run = randomBytes(3).toString('hex');
  const prefix = `[${command} ${run} ${source()}]`;
  const write = (text: string) => {
    const at = new Date().toISOString();
    const lines = text.split('\n').map((l) => `${at} ${prefix} ${l}`);
    try {
      mkdirSync(HOME, { recursive: true });
      appendFileSync(journalPath(), lines.join('\n') + '\n');
    } catch {}
    return lines;
  };
  return { run, write };
};
