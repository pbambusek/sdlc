import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';

// Every file the dashboard reads and writes lives under SDLC_HOME, set before the modules read it.
const home = realpathSync(mkdtempSync(join(tmpdir(), 'foreman-serve-')));
process.env.SDLC_HOME = home;
process.env.FOREMAN_NO_OPEN = '1';
const { serve, dashboardAddress } = await import('../src/server.mts');
const { saveTick, lastTickPath } = await import('../src/status.mts');
afterAll(() => rmSync(home, { recursive: true, force: true }));

const row = (over: Record<string, unknown> = {}) => ({
  key: 'PROJ-1',
  summary: 'Any employee can propose an idea',
  url: 'https://example.com/browse/PROJ-1',
  state: 'parked',
  detail: 'build #3 asked: which list is capped?',
  actions: [],
  pr: 'https://github.com/example/app/pull/7',
  done: [],
  spent: { usd: 31.4, tokens: 1, seconds: 60, builds: 3, verifies: 2, live: null },
  steps: [{ at: '2026-10-27T09:00:00.000Z', kind: 'build', label: 'B3', outcome: 'asked' }],
  ...over,
});
const tickWith = (...rows: ReturnType<typeof row>[]) => ({
  at: '2026-10-27T10:00:00.000Z',
  dryRun: false,
  decisions: rows,
  errors: [],
  totals: { since: '2026-10-08T00:00:00.000Z', usd: 211.7, seconds: 158400, tasks: { build: 31, verify: 24, feedback: 15 } },
});
let tick = tickWith(row());

const config = { jira: { baseUrl: 'https://example.com' }, approvers: [], repos: {}, prices: {}, serve: { port: 0 } };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dash = await serve({ config: config as any, lastTick: () => tick as any }, { open: false });
afterAll(() => dash.close());
const get = (path: string) => fetch(`${dash.url.replace(/\/$/, '')}${path}`);
/** fetch can't set Host, so a request under another name goes through node:http. */
const raw = (method: string, host: string) =>
  new Promise<number>((resolve, reject) => {
    const u = new URL(dash.url);
    request({ host: u.hostname, port: u.port, path: '/', method, headers: { host } }, (res) => {
      resolve(res.statusCode!);
      res.resume();
    })
      .on('error', reject)
      .end();
  });

describe('the dashboard', () => {
  test('listens on this machine only, says where, and answers only under its own name', async () => {
    expect(dash.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(dashboardAddress()).toBe(dash.url);
    expect((await get('/')).status).toBe(200);
    expect(await raw('GET', 'dashboard.example.com')).toBe(403);
  });

  test('only shows: anything but GET is refused', async () => {
    expect(await raw('POST', new URL(dash.url).host)).toBe(405);
  });

  test('shows totals, then what needs you as cards of facts, then what runs, each with how long', async () => {
    tick = tickWith(
      row(),
      row({
        key: 'PROJ-2',
        state: 'build running',
        detail: 'sdlc:build PROJ-2 #2',
        steps: [{ at: '2026-10-27T10:01:00.000Z', kind: 'build', label: 'B2', outcome: 'running' }],
      }),
    );
    const page = await (await get('/')).text();
    const order = ['Spend', 'Agent time', 'Tasks run', 'Needs you', 'Running'].map((w) => page.indexOf(w));
    expect(order).toStrictEqual([...order].sort((a, b) => a - b));
    expect(page).toContain('31 builds · 24 verify · 15 feedback');
    const card = page.slice(page.indexOf('class="ncard'), page.indexOf('</div></div>', page.indexOf('class="ncard')));
    for (const fact of ['PROJ-1', 'parked', 'build #3 asked: which list is capped?', '$31.40', 'sdlc-parked']) expect(card).toContain(fact);
    expect(card).not.toContain('PROJ-2');
    expect(page).toMatch(/build B2 .*data-for/s);
  });

  test('the history page lists ended issues with their rounds, time and cost, the activity and spend per day', async () => {
    tick = tickWith(row({ state: 'merged', steps: [{ at: '2026-10-27T09:00:00.000Z', kind: 'feedback', label: 'F', outcome: 'clean' }] }));
    const page = await (await get('/history')).text();
    expect(page).toMatch(/Done <span class="count">1<\/span>/);
    expect(page).toContain('merged');
    expect(page).toContain('1 round');
    expect(page).toContain('Activity');
    expect(page).toContain('Spend per day');
  });

  test('says when no tick has run yet', async () => {
    tick = null as never;
    expect(await (await get('/')).text()).toContain('No tick yet');
    tick = tickWith(row());
  });
});

test('a tick writes the last tick and the index of features, and no status page', () => {
  saveTick(tickWith(row()) as never);
  expect(existsSync(lastTickPath())).toBe(true);
  expect(existsSync(join(home, 'status.html'))).toBe(false);
});
