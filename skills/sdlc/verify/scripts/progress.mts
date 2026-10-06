/**
 * Turns a headless verification session's stream-json output into one line per step for the terminal.
 * The verifier's own messages are shown in full, so "ACTION NEEDED: …" requests reach the owner.
 */
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';

interface Block {
  type: string;
  text?: string;
  name?: string;
  input?: { description?: string; command?: string; file_path?: string; skill?: string };
}

const short = (s: string, n = 110) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export const showProgress = async (stream: Readable) => {
  for await (const line of createInterface({ input: stream })) {
    let event: { type: string; subtype?: string; session_id?: string; message?: { content?: Block[] }; result?: string };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === 'system' && event.subtype === 'init' && event.session_id) console.log(`  session ${event.session_id}`);
    if (event.type === 'assistant') {
      for (const block of event.message?.content ?? []) {
        if (block.type === 'text' && block.text?.trim()) {
          const text = block.text.trim();
          console.log(text.startsWith('ACTION NEEDED') ? `\n\x1b[1;33m${text}\x1b[0m\n` : `› ${text}`);
        }
        if (block.type === 'tool_use') {
          const i = block.input ?? {};
          console.log(`  · ${block.name}: ${short(i.description ?? i.command ?? i.file_path ?? i.skill ?? '')}`);
        }
      }
    }
    if (event.type === 'result' && event.result) console.log(`\n${event.result}`);
  }
};
