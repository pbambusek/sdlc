// The Jira REST calls a tick needs. The API token comes from JIRA_API_TOKEN or the macOS keychain and is never printed.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { adfToMarkdown, textToAdf, type AdfNode } from './adf.mts';
import type { Config } from './config.mts';
import type { ChangelogEntry, Comment } from './ledger.mts';

// Named when foreman was sdlc-tick; kept so a token stored under the old name still reads.
export const KEYCHAIN_SERVICE = 'sdlc-tick-jira';

const token = (email: string): string => {
  if (process.env.JIRA_API_TOKEN) return process.env.JIRA_API_TOKEN;
  try {
    return execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', email, '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    throw new Error(`no Jira API token: set JIRA_API_TOKEN, or store it with: security add-generic-password -s ${KEYCHAIN_SERVICE} -a ${email} -w`);
  }
};

/** Jira timestamps carry an offset; the ledger compares UTC ISO strings. */
const utc = (s: string) => new Date(s).toISOString();

export interface Issue {
  key: string;
  summary: string;
  url: string;
  created: string;
  labels: string[];
  description: string;
}

export const jiraClient = (config: Config) => {
  const base = config.jira.baseUrl.replace(/\/$/, '');
  const gateway = async () => {
    const { cloudId } = (await (await fetch(`${base}/_edge/tenant_info`)).json()) as { cloudId: string };
    return `https://api.atlassian.com/ex/jira/${cloudId}`;
  };
  // An unscoped token works on the site; a token created with scopes only through the gateway. The first call finds out which.
  let api: string | undefined = config.jira.apiUrl?.replace(/\/$/, '');
  let auth: string | undefined;

  // A FormData body is an upload: fetch sets its own content type, and Jira wants the no-check header.
  const send = (url: string, method: string, path: string, body?: unknown) =>
    fetch(`${url}${path}`, {
      method,
      headers: {
        Authorization: auth!,
        Accept: 'application/json',
        ...(body instanceof FormData ? { 'X-Atlassian-Token': 'no-check' } : body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
    });
  // Jira Cloud answers a rejected token as an anonymous user for some calls: a search then succeeds and finds nothing.
  const rejected = (res: Response) =>
    res.status === 401 || /AUTHENTICAT(ED|ION)_FAILED|AUTHENTICATION_DENIED/.test(res.headers.get('x-seraph-loginreason') ?? '');

  const call = async <T,>(method: string, path: string, body?: unknown): Promise<T> => {
    auth ??= `Basic ${Buffer.from(`${config.jira.email}:${token(config.jira.email)}`).toString('base64')}`;
    let res: Response;
    if (api) res = await send(api, method, path, body);
    else {
      res = await send(base, method, path, body);
      if (rejected(res)) {
        const viaGateway = await send(await gateway(), method, path, body);
        if (!rejected(viaGateway)) [res, api] = [viaGateway, await gateway()];
      } else api = base;
    }
    if (rejected(res)) {
      const t = token(config.jira.email);
      const why =
        t.length === 128
          ? ' The stored token is exactly 128 characters: the keychain prompt cut it off. Copy the token and run foreman set-token.'
          : ' Copy a new API token and run foreman set-token.';
      throw new Error(`Jira rejected the token for ${config.jira.email} (${method} ${path}, ${res.status}).${why}`);
    }
    if (!res.ok) throw new Error(`Jira ${method} ${path}: ${res.status} ${(await res.text()).slice(0, 300)}`);
    return (res.status === 204 ? undefined : await res.json()) as T;
  };

  return {
    myself: () => call<{ accountId: string; displayName: string }>('GET', '/rest/api/3/myself'),

    search: async (): Promise<Issue[]> => {
      const issues: Issue[] = [];
      let nextPageToken: string | undefined;
      do {
        const page = await call<{
          issues: { key: string; fields: { summary: string; created: string; labels: string[]; description: AdfNode | null } }[];
          nextPageToken?: string;
        }>('POST', '/rest/api/3/search/jql', { jql: config.jira.jql, fields: ['summary', 'created', 'labels', 'description'], maxResults: 50, nextPageToken });
        for (const i of page.issues) {
          issues.push({
            key: i.key,
            summary: i.fields.summary,
            url: `${base}/browse/${i.key}`,
            created: utc(i.fields.created),
            labels: i.fields.labels ?? [],
            description: adfToMarkdown(i.fields.description),
          });
        }
        nextPageToken = page.nextPageToken;
      } while (nextPageToken);
      return issues;
    },

    changelog: async (key: string): Promise<ChangelogEntry[]> => {
      const out: ChangelogEntry[] = [];
      for (let startAt = 0; ;) {
        const page = await call<{
          values: { created: string; author?: { accountId: string; displayName: string }; items: ChangelogEntry['items'] }[];
          isLast: boolean;
          maxResults: number;
        }>('GET', `/rest/api/3/issue/${key}/changelog?startAt=${startAt}&maxResults=100`);
        for (const v of page.values)
          out.push({ at: utc(v.created), accountId: v.author?.accountId ?? '', who: v.author?.displayName ?? 'someone', items: v.items });
        if (page.isLast || !page.values.length) return out;
        startAt += page.values.length;
      }
    },

    comments: async (key: string): Promise<Comment[]> => {
      const out: Comment[] = [];
      for (let startAt = 0; ;) {
        const page = await call<{ comments: { created: string; body: AdfNode }[]; total: number }>(
          'GET',
          `/rest/api/3/issue/${key}/comment?startAt=${startAt}&maxResults=100&orderBy=created`,
        );
        for (const c of page.comments) out.push({ at: utc(c.created), text: adfToMarkdown(c.body) });
        startAt += page.comments.length;
        if (startAt >= page.total || !page.comments.length) return out;
      }
    },

    comment: (key: string, text: string) => call('POST', `/rest/api/3/issue/${key}/comment`, { body: textToAdf(text) }),

    /** Attaches local files to the issue, unchanged, under the given names. Returns the attachment ids in the same order. */
    attach: async (key: string, files: { name: string; path: string }[]): Promise<string[]> => {
      const form = new FormData();
      for (const f of files) form.append('file', new Blob([readFileSync(f.path)]), f.name);
      const created = await call<{ id: string; filename: string }[]>('POST', `/rest/api/3/issue/${key}/attachments`, form);
      return files.map((f) => created.find((c) => c.filename === f.name)?.id ?? '');
    },

    addLabel: (key: string, label: string) => call('PUT', `/rest/api/3/issue/${key}`, { update: { labels: [{ add: label }] } }),
  };
};

export type Jira = ReturnType<typeof jiraClient>;
