/**
 * Lets a run call real services without holding their keys. The repo's VERIFY.md declares each credential (the variable a run
 * reads, the Key Vault secret that holds it, the hosts it may be sent to, and the header it goes in). The launcher reads the real
 * values and starts nono's proxy (`nono proxy`) with them. The run gets the proxy's address and a random per-run token, which is
 * also the value of each credential's variable. nono puts the real value on every request through the proxy to a declared host,
 * and tunnels everything else untouched, so the token arrives anywhere else as itself.
 */
import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, relative } from 'node:path';

export interface Credential {
  name: string;
  secret: string;
  hosts: string[];
  // The header the value goes in (default `Authorization`) and its format (default `Bearer {}`), or HTTP basic auth with a `user:password` value.
  header?: string;
  format?: string;
  basic?: boolean;
  // A calibration credential whose value is not secret: a run may see it, so the value scan skips it.
  known?: boolean;
}
export interface Declaration {
  vault: string;
  credentials: Credential[];
}

/** A declared credential after the launcher tried to read it. */
export type Read = (Credential & { outcome: 'read'; value: string }) | (Credential & { outcome: 'unavailable'; reason: string });

/** One line of the run's credential log. Never a value. */
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
const HOST = /^[a-z0-9.-]+$/i;

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
  const seen = new Set<string>();
  for (const [i, c] of (Array.isArray(d.credentials) ? d.credentials : []).entries()) {
    if (!NAME.test(String(c?.name))) problems.push(`credentials.${i}.name: an environment variable name`);
    if (!SECRET.test(String(c?.secret))) problems.push(`credentials.${i}.secret: a Key Vault secret name`);
    if (!Array.isArray(c?.hosts) || c.hosts.length === 0 || !c.hosts.every((h) => typeof h === 'string' && HOST.test(h)))
      problems.push(`credentials.${i}.hosts: a non-empty list of exact host names`);
    // nono routes one credential per host, so two credentials can't share one.
    for (const h of Array.isArray(c?.hosts) ? c.hosts : []) {
      if (seen.has(h)) problems.push(`credentials.${i}.hosts: ${h} is already declared`);
      else seen.add(h);
    }
    if (c?.header !== undefined && !/^[A-Za-z0-9-]+$/.test(String(c.header))) problems.push(`credentials.${i}.header: a header name`);
    if (c?.format !== undefined && !String(c.format).includes('{}')) problems.push(`credentials.${i}.format: text with {} where the value goes`);
    for (const k of ['basic', 'known'] as const) if (c?.[k] !== undefined && typeof c[k] !== 'boolean') problems.push(`credentials.${i}.${k}: true or false`);
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
            const reason = !err
              ? 'the secret is empty'
              : (err as { code?: string }).code === 'ENOENT'
                ? 'the Azure CLI (az) is not installed'
                : why
                    .replace(/^ERROR:\s*/, '')
                    .trim()
                    .slice(0, 300);
            done({ ...c, outcome: 'unavailable', reason: `${d.vault}/${c.secret}: ${reason || 'az exited without a value'}` });
          });
        }),
    ),
  );

/** Marks every read credential unavailable when the proxy can't run, so their claims are blocked rather than run without a key. */
export const requireNono = (reads: Read[]): Read[] => {
  if (!reads.some((r) => r.outcome === 'read')) return reads;
  if (spawnSync('nono', ['--version'], { encoding: 'utf8' }).status === 0) return reads;
  return reads.map((r): Read =>
    r.outcome === 'read' ? { ...r, outcome: 'unavailable', reason: 'nono is not installed (brew install nono), so nothing can inject it' } : r,
  );
};

const freePort = () =>
  new Promise<number>((done, fail) => {
    const server = createServer();
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => done(port));
    });
  });

/**
 * Starts `nono proxy` with the credentials that were read, and returns the environment a run gets: the launcher's own, plus the
 * proxy and trust variables, with each read credential's variable set to the run's token and each unavailable one removed.
 * `collect` turns nono's log into the run's credential log; `stop` ends the proxy, after which the token reaches nothing.
 */
export const startProxy = async ({
  reads,
  profileFile,
  nonoLog,
  log,
  baseEnv,
}: {
  reads: Read[];
  profileFile: string;
  nonoLog: string;
  log: string;
  baseEnv: NodeJS.ProcessEnv;
}) => {
  const available = reads.filter((r) => r.outcome === 'read');
  const token = randomBytes(32).toString('hex');
  const port = await freePort();
  const routes = available.flatMap((c, i) => c.hosts.map((host, j) => ({ id: `verify${i}h${j}`, host, credential: c, envKey: `VERIFY_NONO_VALUE_${i}` })));
  const profile = {
    meta: { name: 'verify-run' },
    network: {
      custom_credentials: Object.fromEntries(
        routes.map((r) => [
          r.id,
          r.credential.basic
            ? { upstream: `https://${r.host}`, credential_key: `env://${r.envKey}`, inject_mode: 'basic_auth' }
            : {
                upstream: `https://${r.host}`,
                credential_key: `env://${r.envKey}`,
                inject_mode: 'header',
                inject_header: r.credential.header ?? 'Authorization',
                credential_format: r.credential.format ?? 'Bearer {}',
              },
        ]),
      ),
    },
  };
  writeFileSync(profileFile, JSON.stringify(profile, null, 2) + '\n', { mode: 0o600 });
  writeFileSync(log, '');

  // The real values live only in nono's own environment, never in the run's.
  const nonoEnv: NodeJS.ProcessEnv = {
    ...baseEnv,
    NONO_PROXY_PASS: token,
    ...Object.fromEntries(available.map((c, i) => [`VERIFY_NONO_VALUE_${i}`, c.value])),
  };
  const args = ['proxy', '-v', '--port', String(port), '--profile', profileFile, '--log-file', nonoLog, ...routes.flatMap((r) => ['--credential', r.id])];
  const nono = spawn('nono', args, { env: nonoEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  const killNono = () => nono.kill('SIGTERM');
  process.once('exit', killNono);

  // nono prints its trust bundle (its CA plus the system roots) once it listens.
  let banner = '';
  const masked = () => banner.replaceAll(token, '<token>').trim().slice(-300);
  const bundle = await new Promise<string>((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`nono proxy did not start: ${masked()}`)), 20_000);
    const read = (chunk: Buffer) => {
      banner += chunk.toString();
      const path = banner.match(/trust bundle:\s*(\S+\.pem)/)?.[1];
      if (path) {
        clearTimeout(timer);
        done(path);
      }
    };
    nono.stdout.on('data', read);
    nono.stderr.on('data', read);
    nono.once('exit', (code) => (clearTimeout(timer), fail(new Error(`nono proxy exited (${code}): ${masked()}`))));
  });

  const proxyUrl = `http://nono:${token}@127.0.0.1:${port}`;
  const noProxy = ['localhost', '127.0.0.1', '::1', baseEnv.NO_PROXY].filter(Boolean).join(',');
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    HTTPS_PROXY: proxyUrl,
    https_proxy: proxyUrl,
    HTTP_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
    // Node's fetch ignores the proxy variables unless told to honour them.
    NODE_USE_ENV_PROXY: '1',
    ...Object.fromEntries(['NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'CURL_CA_BUNDLE', 'REQUESTS_CA_BUNDLE', 'GIT_SSL_CAINFO'].map((k) => [k, bundle])),
    ...Object.fromEntries(available.map((c) => [c.name, token])),
  };
  // A credential that could not be read stays out of the run, so nothing runs as if it had the key.
  for (const r of reads) if (r.outcome === 'unavailable') delete env[r.name];

  // nono logs each request it intercepted on a credential's host, which is each request it put the real value on.
  let logged = 0;
  const collect = () => {
    if (!existsSync(nonoLog)) return;
    const lines = readFileSync(nonoLog, 'utf8')
      .split('\n')
      .filter((l) => l.includes('l7 proxy response') && l.includes('mode=connect_intercept'));
    for (const line of lines.slice(logged)) {
      const field = (k: string) => line.match(new RegExp(`${k}="?([^"\\s]*)"?`))?.[1] ?? '';
      const host = field('target');
      const credential = routes.find((r) => r.host === host)?.credential.name;
      if (!credential) continue;
      const status = Number(field('status'));
      const entry: LoggedRequest = {
        credential,
        host,
        method: field('method'),
        path: field('path').split('?')[0]!,
        status: status > 0 ? status : null,
        time: line.split(/\s/)[0]!,
      };
      appendFileSync(log, JSON.stringify(entry) + '\n');
    }
    logged = lines.length;
  };

  const stop = async () => {
    process.off('exit', killNono);
    if (nono.exitCode === null) {
      const exited = new Promise((done) => nono.once('exit', done));
      killNono();
      await exited;
    }
    collect();
  };
  return { env, stop, collect, values: secretValues(reads) };
};

type Values = { name: string; value: string }[];

/** The values the scans look for: every read credential except a known calibration one. */
export const secretValues = (reads: Read[]): Values => reads.flatMap((r) => (r.outcome === 'read' && !r.known ? [{ name: r.name, value: r.value }] : []));

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
  const out = execFileSync('ps', ['-E', '-ww', '-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 1 << 28 });
  const rows = out
    .split('\n')
    .map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter((m) => m !== null);
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
