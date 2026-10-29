// `foreman serve`: the dashboard, on this machine only. It only reads: each page renders from the last tick, the archive
// and the journal on every request, so launchd's ticks keep it current.
import { spawnSync } from 'node:child_process';
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { loadRuns } from './archive.mts';
import { HOME, type Config } from './config.mts';
import { daysOf, historyPage, messagePage, nowPage, type Extra } from './dashboard.mts';
import { readJournal } from './history.mts';
import { journalPath } from './journal.mts';
import { agentState } from './launchd.mts';
import { byFeature, totals } from './stats.mts';
import { loadLastTick, loadSeen } from './status.mts';
import type { TickResult } from './tick.mts';

export const servePath = () => join(HOME, 'serve.json');

/** The dashboard's address while `foreman serve` runs, else null. */
export const dashboardAddress = (): string | null => {
  try {
    const { url, pid } = JSON.parse(readFileSync(servePath(), 'utf8')) as { url: string; pid: number };
    process.kill(pid, 0);
    return url;
  } catch {
    return null;
  }
};

/** The end of the journal: it is never rotated, and the page needs only the last day or so. */
const journalTail = (bytes = 512 * 1024) => {
  const fd = openSync(journalPath(), 'r');
  try {
    const size = fstatSync(fd).size;
    const buf = Buffer.alloc(Math.min(bytes, size));
    readSync(fd, buf, 0, buf.length, size - buf.length);
    const text = buf.toString('utf8');
    return size > bytes ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    closeSync(fd);
  }
};

// Metrics are for people: a broken archive or journal leaves its section out, never the page.
const attempt = <T,>(fn: () => T): T | null => {
  try {
    return fn();
  } catch {
    return null;
  }
};

const extra = (config: Config): Extra => {
  const runs = attempt(() => loadRuns()) ?? [];
  return {
    agent: attempt(agentState),
    journal: attempt(() => readJournal(journalTail(), Date.now())),
    days: attempt(() => daysOf(runs, (rs) => totals(rs, config.prices).usd)),
    seen: loadSeen(),
    stats: byFeature(runs, config.prices),
    journalPath: journalPath(),
  };
};

export interface Deps {
  config: Config;
  /** The last tick, read on every request so the pages follow the ticks. */
  lastTick?: () => TickResult | null;
}

export const handler = (deps: Deps) => {
  const lastTick = deps.lastTick ?? loadLastTick;
  return (req: IncomingMessage, res: ServerResponse) => {
    const send = (status: number, body: string) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(body);
    };
    const port = (req.socket.localPort ?? deps.config.serve.port).toString();
    // Only this machine's browser: a page reached under another name (DNS rebinding) is refused.
    if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`)
      return send(403, messagePage('Not here', 'This dashboard answers only on 127.0.0.1.'));
    if (req.method !== 'GET') return send(405, messagePage('Not done', 'The dashboard only shows; nothing changes here.'));
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    try {
      if (path === '/') return send(200, nowPage(lastTick(), extra(deps.config)));
      if (path === '/history') return send(200, historyPage(lastTick(), extra(deps.config)));
      if (path === '/favicon.ico') {
        res.writeHead(204);
        return res.end();
      }
      return send(404, messagePage('Not found', `Nothing at ${path}.`));
    } catch (e) {
      return send(500, messagePage('Something failed', (e as Error).message));
    }
  };
};

/** Starts the dashboard on this machine's loopback only, opens it, and says where it is. */
export const serve = (deps: Deps, opts: { open?: boolean } = {}) =>
  new Promise<{ url: string; close: () => void }>((resolve, reject) => {
    const server = createServer(handler(deps));
    server.once('error', reject);
    server.listen(deps.config.serve.port, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : deps.config.serve.port;
      const url = `http://127.0.0.1:${port}/`;
      mkdirSync(HOME, { recursive: true });
      writeFileSync(servePath(), JSON.stringify({ url, pid: process.pid }) + '\n');
      const opener = process.platform === 'darwin' ? 'open' : process.platform === 'linux' ? 'xdg-open' : null;
      if (opts.open !== false && opener && !process.env.FOREMAN_NO_OPEN) spawnSync(opener, [url], { stdio: 'ignore' });
      resolve({ url, close: () => server.close() });
    });
  });
