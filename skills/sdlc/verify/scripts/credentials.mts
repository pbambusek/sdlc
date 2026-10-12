/**
 * Lets a run call real services without holding their keys. The repo's VERIFY.md declares each credential (the variable a run
 * reads, the Key Vault secret that holds it, and the hosts it may be sent to). The launcher reads the real values, and srt's
 * proxy (@anthropic-ai/sandbox-runtime) holds them: the run's environment carries a per-run placeholder, which the proxy swaps
 * for the real value, in headers and bodies, only on a request to one of that credential's hosts.
 *
 * The run is not wrapped in srt's OS sandbox, only given its environment: Chromium cannot start inside macOS's, and sandboxing
 * the run is not this layer's job. A process that skips the proxy reaches the host with the placeholder, never the value.
 */
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';

export interface Credential {
  name: string;
  secret: string;
  hosts: string[];
  // A calibration credential whose value is not secret: a run may see it, so the value scan skips it.
  known?: boolean;
}
export interface Declaration {
  vault: string;
  credentials: Credential[];
}

/** A declared credential after the launcher tried to read it. */
export type Read = (Credential & { outcome: 'read'; value: string }) | (Credential & { outcome: 'unavailable'; reason: string });

/** One line of the run's credential log. Never a value: the path is taken before substitution and without its query. */
export interface LoggedRequest {
  credential: string;
  host: string;
  method: string;
  path: string;
  status: number | null;
  time: string;
}

const NAME = /^[A-Z_][A-Z0-9_]*$/;
const SECRET = /^[0-9a-zA-Z-]{1,127}$/;

/** The `## Credentials` section's JSON block, or null when VERIFY.md declares none. Throws when the block is malformed. */
export const parseDeclaration = (verifyMd: string): Declaration | null => {
  const section = verifyMd.split(/^## /m).find((s) => /^Credentials\s*\n/.test(s));
  if (!section) return null;
  const block = section.match(/```json\n([\s\S]*?)```/)?.[1];
  if (!block) throw new Error('VERIFY.md: the Credentials section has no ```json block');
  const d = JSON.parse(block) as Declaration;
  const problems: string[] = [];
  if (typeof d.vault !== 'string' || !/^[0-9a-zA-Z-]{3,24}$/.test(d.vault)) problems.push('vault: a Key Vault name');
  if (!Array.isArray(d.credentials) || d.credentials.length === 0) problems.push('credentials: a non-empty list');
  for (const [i, c] of (Array.isArray(d.credentials) ? d.credentials : []).entries()) {
    if (!NAME.test(String(c?.name))) problems.push(`credentials.${i}.name: an environment variable name`);
    if (!SECRET.test(String(c?.secret))) problems.push(`credentials.${i}.secret: a Key Vault secret name`);
    if (!Array.isArray(c?.hosts) || c.hosts.length === 0 || !c.hosts.every((h) => typeof h === 'string' && /^(\*\.)?[a-z0-9.-]+$/i.test(h)))
      problems.push(`credentials.${i}.hosts: a non-empty list of host names`);
    if (c?.known !== undefined && typeof c.known !== 'boolean') problems.push(`credentials.${i}.known: true or false`);
  }
  if (problems.length) throw new Error(`VERIFY.md Credentials: ${problems.join('; ')}`);
  return d;
};

/** Reads each credential's value with the Azure CLI's cached login, so no prompt can stop an unattended run. Never prints a value. */
export const readCredentials = async (d: Declaration): Promise<Read[]> =>
  Promise.all(
    d.credentials.map(
      (c) =>
        new Promise<Read>((done) => {
          const args = ['keyvault', 'secret', 'show', '--vault-name', d.vault, '--name', c.secret, '--query', 'value', '--output', 'tsv', '--only-show-errors'];
          execFile('az', args, { timeout: 60_000, encoding: 'utf8' }, (err, stdout, stderr) => {
            const value = stdout?.trim() ?? '';
            if (!err && value) return done({ ...c, outcome: 'read', value });
            const why = (stderr || err?.message || '').split('\n').find((l) => l.trim()) ?? '';
            const reason = !err ? 'the secret is empty' : (err as { code?: string }).code === 'ENOENT' ? 'the Azure CLI (az) is not installed' : why.replace(/^ERROR:\s*/, '').trim().slice(0, 300);
            done({ ...c, outcome: 'unavailable', reason: `${d.vault}/${c.secret}: ${reason || 'az exited without a value'}` });
          });
        }),
    ),
  );

const matchesHost = (host: string, patterns: string[]) =>
  patterns.some((p) => (p.startsWith('*.') ? host.endsWith(p.slice(1)) : host === p.toLowerCase()));

const loadSrt = async (skillDir: string) => {
  // The dependency is installed on first use, so a repo that declares no credentials never needs it.
  if (!existsSync(join(skillDir, 'node_modules/@anthropic-ai/sandbox-runtime'))) {
    execFileSync('npm', ['ci', '--silent', '--no-audit', '--no-fund'], { cwd: skillDir, stdio: 'inherit' });
  }
  return (await import('@anthropic-ai/sandbox-runtime')).SandboxManager;
};

/**
 * Starts srt's proxy with the values it may inject, and returns the environment a run gets: the launcher's own, with each read
 * credential replaced by its placeholder and every proxy and trust variable srt sets. `stop` closes the proxy, after which the
 * run's proxy token and placeholders reach nothing.
 */
export const startProxy = async ({ skillDir, reads, log, baseEnv }: { skillDir: string; reads: Read[]; log: string; baseEnv: NodeJS.ProcessEnv }) => {
  const available = reads.filter((r) => r.outcome === 'read');
  const SandboxManager = await loadSrt(skillDir);

  // The host may inspect TLS with its own root (a corporate gateway), so the proxy and the run trust the system's roots too.
  const system = getCACertificates('system');
  setDefaultCACertificates([...getCACertificates('default'), ...system]);
  const caDir = mkdtempSync(join(tmpdir(), 'verify-ca-'));
  const systemPem = join(caDir, 'system-roots.pem');
  writeFileSync(systemPem, system.join('\n'), { mode: 0o600 });

  writeFileSync(log, '');
  const placeholders = new Map<string, string>();
  type Pending = Omit<LoggedRequest, 'status'>;
  const pending: Pending[] = [];
  const write = (e: LoggedRequest) => appendFileSync(log, JSON.stringify(e) + '\n');
  const entry = (p: Pending, status: number | null): LoggedRequest => ({ credential: p.credential, host: p.host, method: p.method, path: p.path, status, time: p.time });

  // srt checks a request before it substitutes, so a placeholder in its headers or body says which credential it carries.
  const filterRequest = async (request: Request) => {
    const url = new URL(request.url);
    const host = url.hostname.toLowerCase();
    const candidates = available.filter((c) => matchesHost(host, c.hosts));
    if (candidates.length) {
      const headers = [...request.headers.values()].join('\n');
      const body = request.body && !['GET', 'HEAD'].includes(request.method) ? await request.clone().text() : '';
      for (const c of candidates) {
        const placeholder = placeholders.get(c.name);
        if (placeholder && (headers.includes(placeholder) || body.includes(placeholder) || url.search.includes(placeholder)))
          pending.push({ credential: c.name, host, method: request.method, path: url.pathname, time: new Date().toISOString() });
      }
    }
    return { action: 'allow' as const };
  };
  // The proxy's own upstream leg reports the status; it is matched to the oldest pending request with the same host, method and path.
  const onResponse = (message: unknown) => {
    const { request, response } = message as { request: ClientRequest; response: IncomingMessage };
    const host = String(request.getHeader('host') ?? '').replace(/:\d+$/, '').toLowerCase();
    const path = request.path.split('?')[0];
    for (let i = 0; i < pending.length; i++) {
      const p = pending[i]!;
      if (p.host === host && p.method === request.method && p.path === path) {
        pending.splice(i, 1);
        write(entry(p, response.statusCode ?? null));
        // One upstream request carries every credential it holds; log each.
        i--;
      }
    }
  };
  subscribe('http.client.response.finish', onResponse);

  // srt reads the real values from its own environment when it wraps a command, then keeps them only in the proxy.
  for (const c of available) process.env[c.name] = c.value;
  await SandboxManager.initialize(
    {
      filesystem: { disabled: true, denyRead: [], allowWrite: ['/'], denyWrite: [] },
      network: {
        // srt refuses an empty allowlist as "no network"; every other host is allowed through the ask callback below.
        allowedDomains: [...new Set(available.flatMap((c) => c.hosts))],
        deniedDomains: [],
        tlsTerminate: { extraCaCertPaths: [systemPem] },
        filterRequest,
      },
      credentials: { envVars: available.map((c) => ({ name: c.name, mode: 'mask' as const, injectHosts: c.hosts })) },
    } as Parameters<typeof SandboxManager.initialize>[0],
    async () => true,
  );
  // The run's environment is what srt gives a sandboxed command, read by running `env` inside its sandbox once.
  const { argv, env: wrapEnv } = await SandboxManager.wrapWithSandboxArgv('/usr/bin/env -0', '/bin/bash');
  const printed = spawnSync(argv[0]!, argv.slice(1), { env: { ...baseEnv, ...wrapEnv, ...Object.fromEntries(available.map((c) => [c.name, c.value])) }, encoding: 'utf8' });
  for (const c of available) delete process.env[c.name];
  if (printed.status !== 0) throw new Error(`srt could not start a command: ${printed.stderr.trim().slice(0, 300)}`);
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    printed.stdout
      .split('\0')
      .filter(Boolean)
      .map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]),
  );
  for (const c of available) {
    const placeholder = env[c.name];
    if (!placeholder || placeholder === c.value) throw new Error(`srt did not mask ${c.name}; refusing to start the run`);
    placeholders.set(c.name, placeholder);
  }
  // The run is not inside srt's sandbox, and the variable would tell tools it is.
  delete env.SANDBOX_RUNTIME;
  // Node's fetch ignores the proxy variables unless told to honour them.
  env.NODE_USE_ENV_PROXY = '1';
  // A credential that could not be read stays out of the run, so nothing runs as if it had the key.
  for (const r of reads) if (r.outcome === 'unavailable') delete env[r.name];

  const stop = async () => {
    await SandboxManager.reset();
    unsubscribe('http.client.response.finish', onResponse);
    for (const p of pending.splice(0)) write(entry(p, null));
  };
  return { env, stop, values: available.filter((c) => !c.known).map((c) => ({ name: c.name, value: c.value })) };
};

type Values = { name: string; value: string }[];
const SKIP = new Set(['node_modules', '.git', '.yarn', '.turbo']);

/** Each file under `root`, and each named text, that holds a real value, as `<credential> in <where>`. Never returns a value. */
export const findValues = ({ values, root, texts }: { values: Values; root: string; texts: Record<string, string> }) => {
  const hits: string[] = [];
  const check = (where: string, text: string) => {
    for (const v of values) if (text.includes(v.value)) hits.push(`${v.name} in ${where}`);
  };
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory() && !SKIP.has(e.name)) walk(p);
      else if (e.isFile() && statSync(p).size < 20 << 20) check(relative(root, p), readFileSync(p, 'latin1'));
    }
  };
  walk(root);
  for (const [where, text] of Object.entries(texts)) check(where, text);
  return hits;
};

/** Each live process under `rootPid` whose environment holds a real value, as `<credential> in the environment of <command>`. */
export const findValuesInProcesses = ({ values, rootPid }: { values: Values; rootPid: number }) => {
  // `ps -E` appends each process's environment to its command, for processes this user owns.
  const out = spawnSync('ps', ['-E', '-ww', '-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 1 << 28 }).stdout ?? '';
  const rows = out.split('\n').map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter((m) => m !== null);
  const children = new Map<number, number[]>();
  for (const [, pid, ppid] of rows) children.set(Number(ppid), [...(children.get(Number(ppid)) ?? []), Number(pid)]);
  const tree = new Set<number>();
  const visit = (pid: number) => (tree.add(pid), (children.get(pid) ?? []).forEach(visit));
  visit(rootPid);
  const hits: string[] = [];
  for (const [, pid, , text] of rows) {
    if (!tree.has(Number(pid))) continue;
    for (const v of values) if (text!.includes(v.value)) hits.push(`${v.name} in the environment of ${text!.split(' ')[0]}`);
  }
  return { hits, processes: tree.size };
};
