import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';

// Every file the dashboard reads and writes lives under SDLC_HOME, set before the modules read it.
const home = realpathSync(mkdtempSync(join(tmpdir(), 'foreman-serve-')));
process.env.SDLC_HOME = home;
process.env.FOREMAN_NO_OPEN = '1';
process.env.FOREMAN_NO_TICK = '1';
const { serve, dashboardAddress } = await import('../src/server.mts');
const { saveTick, lastTickPath } = await import('../src/status.mts');
afterAll(() => rmSync(home, { recursive: true, force: true }));

const row = (over: Record<string, unknown> = {}) => ({
  key: 'PROJ-1',
  summary: 'Any employee can propose an idea',
  url: 'https://example.com/browse/PROJ-1',
  state: 'gate open',
  detail: 'round on aaaaaaa',
  gate: `/round/PROJ-1/${'a'.repeat(40)}`,
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
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
// A round whose PR head is `head`: one failing check to decide, one passing.
let head = A;
const view = (kind: 'round' | 'questions', issue: { key: string; summary: string; url: string }, id: string) => ({
  kind,
  ...issue,
  pr: { number: 7, url: 'https://github.com/example/app/pull/7' },
  n: 1,
  sha: id,
  head,
  readAt: null,
  run: null,
  items: [
    { item: 'check:test.yml / unit', status: 'failure', observed: 'login fails' },
    { item: 'thread:https://github.com/example/app/pull/7#discussion_r12', status: 'open', by: 'rev', observed: 'rename this' },
    { item: 'check:lint.yml / rules', status: 'success' },
  ],
  decided: null,
  evidence: null,
  audit: null,
  previous: null,
  merge: null,
  nextBuild: 2,
  base: `/${kind}/${issue.key}/${id}`,
  respec: null,
  error: null,
});
const saved: { attached: string[]; comments: string[] } = { attached: [], comments: [] };
const jira = {
  attach: async (_key: string, files: { name: string; path: string }[]) => {
    saved.attached.push(...files.map((f) => readFileSync(f.path, 'utf8')));
    return files.map((_, i) => `90${i}`);
  },
  comment: async (_key: string, text: string) => {
    saved.comments.push(text);
  },
};
const dash = await serve(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  { config: config as any, lastTick: () => tick as any, jira: jira as any, gate: view as any },
  { open: false },
);
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

  test('takes a write only from its own pages', async () => {
    expect(await raw('POST', new URL(dash.url).host)).toBe(403);
  });

  test("a round's gate shows each item that needs a decision, in order, and saves the decisions to Jira, then the archive", async () => {
    const page = await (await get(`/round/PROJ-1/${A}`)).text();
    // Section by section in the file's order, each item with its decision: no separate list of what to decide.
    const order = ['id="reviews"', 'id="i-thread-', 'id="checks"', 'id="i-check-test-yml-unit"', 'id="i-check-lint-yml-rules"'].map((w) => page.indexOf(w));
    expect(order).toStrictEqual([...order].sort((a, b) => a - b));
    expect(page).not.toContain('nothing to decide');
    const post = (form: Record<string, string>) =>
      fetch(`${dash.url}round/PROJ-1/${A}`, {
        method: 'POST',
        headers: { origin: dash.url.replace(/\/$/, '') },
        body: new URLSearchParams(form),
        redirect: 'manual',
      });
    const res = await post({
      sha: A,
      'c:thread:https://github.com/example/app/pull/7#discussion_r12': 'leave',
      't:thread:https://github.com/example/app/pull/7#discussion_r12': 'The name matches the API.',
    });
    expect(res.status).toBe(303);
    const doc = JSON.parse(saved.attached[0]!);
    expect(doc.items.map((i: { decision?: { do: string } }) => i.decision?.do)).toStrictEqual(['fix', 'reply', undefined]);
    expect(saved.comments[0]).toMatch(new RegExp(`^\\[sdlc\\] decided gate=round sha=${A} next=build commit=yes`));
    expect(existsSync(join(home, 'archive/PROJ-1/rounds', A, 'feedback-decided.json'))).toBe(true);
  });

  test("a round on a head that is no longer the PR's is not saved", async () => {
    head = B;
    saved.comments.length = 0;
    const res = await fetch(`${dash.url}round/PROJ-1/${A}`, {
      method: 'POST',
      headers: { origin: dash.url.replace(/\/$/, '') },
      body: new URLSearchParams({ sha: A }),
    });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('outdated');
    expect(saved.comments).toStrictEqual([]);
    head = A;
  });

  test('shows totals, then what needs you as cards of facts, then what runs, each with how long', async () => {
    tick = tickWith(
      row({ gate: `/round/PROJ-1/${B}` }),
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
    for (const fact of ['PROJ-1', 'gate open', 'round on aaaaaaa', '$31.40', `href="/round/PROJ-1/${B}"`]) expect(card).toContain(fact);
    expect(card).not.toContain('PROJ-2');
    expect(page).toMatch(/build B2 .*data-for/s);
  });

  test('the history page lists ended issues with their rounds, time and cost, the activity and spend per day', async () => {
    tick = tickWith(row({ state: 'merged', steps: [{ at: '2026-10-27T09:00:00.000Z', kind: 'feedback', label: 'F', outcome: 'read' }] }));
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
