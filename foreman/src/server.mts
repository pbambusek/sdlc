// `foreman serve`: the dashboard, on this machine only. Each page renders from the last tick, the archive and the journal on
// every request, so the ticks keep it current. The only thing it writes is what a person decides at a gate, a retry of a
// stalled stage, or an abandon: each goes to the issue in Jira, which the next tick acts on.
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { loadRuns } from './archive.mts';
import { HOME, type Config } from './config.mts';
import { daysOf, historyPage, messagePage, nowPage, type Extra } from './dashboard.mts';
import { abandon, loadQuestions, loadRound, retry, saveGate, type Row } from './gates.mts';
import { jiraClient, type Jira } from './jira.mts';
import { gatePage, preview, type GateView } from './round-page.mts';
import { readJournal } from './history.mts';
import { journalPath } from './journal.mts';
import { agentState, kick, loaded } from './launchd.mts';
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

/** The gates whose decided document is in the archive: a tick may not have read them yet. */
const decidedGates = () => {
  const out = new Set<string>();
  const root = join(HOME, 'archive');
  if (!existsSync(root)) return out;
  for (const key of readdirSync(root)) {
    const rounds = join(root, key, 'rounds');
    if (existsSync(rounds)) for (const sha of readdirSync(rounds)) if (existsSync(join(rounds, sha, 'feedback-decided.json'))) out.add(`/round/${key}/${sha}`);
    const qs = join(root, key, 'questions');
    if (existsSync(qs))
      for (const b of readdirSync(qs)) if (existsSync(join(qs, b, 'questions-decided.json'))) out.add(`/questions/${key}/${b.replace('build-', '')}`);
  }
  return out;
};

/** A tick right after a decision, so foreman acts on it now: launchd's when it is loaded, else one of its own. Its lock keeps it from running beside another. */
const tickNow = () => {
  if (process.env.FOREMAN_NO_TICK) return;
  try {
    if (loaded()) return kick();
  } catch {
    // Not loaded: run one directly.
  }
  spawn(process.execPath, ['--use-system-ca', join(import.meta.dirname, 'cli.mts'), 'tick'], { detached: true, stdio: 'ignore' }).unref();
};

const extra = (config: Config): Extra => {
  const runs = attempt(() => loadRuns()) ?? [];
  return {
    agent: attempt(agentState),
    journal: attempt(() => readJournal(journalTail(), Date.now())),
    days: attempt(() => daysOf(runs, (rs) => totals(rs, config.prices).usd)),
    seen: loadSeen(),
    decided: decidedGates(),
    stats: byFeature(runs, config.prices),
    journalPath: journalPath(),
  };
};

export interface Deps {
  config: Config;
  /** The last tick, read on every request so the pages follow the ticks. */
  lastTick?: () => TickResult | null;
  /** Where gates are loaded from and saved to; the configured Jira when left out. */
  jira?: Jira;
  /** How a gate is loaded, for tests; from the last tick and the archive when left out. */
  gate?: (kind: 'round' | 'questions', row: Row, id: string) => GateView;
}

const body = (req: IncomingMessage) =>
  new Promise<URLSearchParams>((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => {
      data += c;
      if (data.length > 1 << 20) reject(new Error('too large'));
    });
    req.on('end', () => resolve(new URLSearchParams(data)));
    req.on('error', reject);
  });

const TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

export const handler = (deps: Deps) => {
  const lastTick = deps.lastTick ?? loadLastTick;
  let jira = deps.jira;
  const j = () => (jira ??= jiraClient(deps.config));
  const gate = deps.gate ?? ((kind, row, id) => (kind === 'round' ? loadRound(row, id) : loadQuestions(row, Number(id))));
  return async (req: IncomingMessage, res: ServerResponse) => {
    const send = (status: number, body: string) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(body);
    };
    const port = (req.socket.localPort ?? deps.config.serve.port).toString();
    // Only this machine's browser: a page reached under another name (DNS rebinding) is refused.
    if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`)
      return send(403, messagePage('Not here', 'This dashboard answers only on 127.0.0.1.'));
    // A write comes only from the dashboard's own pages: a page from anywhere else can't post here.
    if (req.method === 'POST' && req.headers.origin !== `http://${req.headers.host}`)
      return send(403, messagePage('Not here', 'Decisions are taken only from the dashboard’s own pages.'));
    if (req.method !== 'GET' && req.method !== 'POST') return send(405, messagePage('Not done', 'Nothing here takes that.'));
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    const redirect = (to: string) => {
      res.writeHead(303, { location: to });
      res.end();
    };
    try {
      const g = path.match(/^\/(round|questions)\/([A-Z][A-Z0-9]*-\d+)\/([0-9a-f]{40}|\d+)(\/plan|\/run\/.+)?$/);
      if (g) {
        const [, kind, key, id, rest] = g as unknown as [string, 'round' | 'questions', string, string, string | undefined];
        const row = lastTick()?.decisions.find((d) => d.key === key);
        if (!row) return send(404, messagePage('Not found', `${key} is not in the last tick.`));
        if (rest?.startsWith('/run/') && req.method === 'GET') {
          // A screenshot of the round's verification run, and nothing outside its folder.
          const v = gate(kind, row, id);
          const run = v.run ? join(HOME, 'archive', key, 'verify', v.run) : null;
          const file = run && normalize(join(run, decodeURIComponent(rest.slice('/run/'.length))));
          if (!file || !file.startsWith(run + '/') || !existsSync(file) || !TYPES[extname(file)]) return send(404, messagePage('Not found', 'No such file.'));
          res.writeHead(200, { 'content-type': TYPES[extname(file)]!, 'cache-control': 'no-store' });
          return res.end(readFileSync(file));
        }
        const v = gate(kind, row, id);
        if (rest === '/plan' && req.method === 'POST') {
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
          return res.end(preview(v, await body(req)));
        }
        if (req.method === 'POST') {
          try {
            await saveGate(j(), v, await body(req));
          } catch (e) {
            return send(409, gatePage({ ...v, error: (e as Error).message }));
          }
          tickNow();
          return redirect('/');
        }
        return send(200, gatePage(v));
      }
      if (path === '/tick' && req.method === 'POST') {
        tickNow();
        return redirect('/');
      }
      const w = path.match(/^\/(retry|abandon)\/([A-Z][A-Z0-9]*-\d+)$/);
      if (w && req.method === 'POST') {
        const form = await body(req);
        const stage = form.get('stage');
        if (w[1] === 'retry' && (stage === 'build' || stage === 'verify' || stage === 'feedback')) await retry(j(), w[2]!, stage);
        else if (w[1] === 'abandon') await abandon(j(), w[2]!, form.get('sha') || 'none');
        else return send(400, messagePage('Not done', 'Retry needs a stage.'));
        tickNow();
        return redirect('/');
      }
      if (req.method !== 'GET') return send(405, messagePage('Not done', 'Nothing here takes that.'));
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
