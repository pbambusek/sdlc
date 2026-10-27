/**
 * A run's workspace: a fresh Linux VM (Lima) cloned per run from a template, where every command the verifier runs executes.
 * The verifier, its login and its transcript stay on the host. The VM holds the exported commit on its own disk and shares
 * back only the run's `.verify` folder; it also sees the plugin's folder and the caches the project declares, read-only.
 * Nothing else of the owner's is there to read: no home, no other session's transcript or memory, no source repo, no login.
 * The verifier's Bash tool runs through a shell (workspace-shell.mts) that sends each command to a server inside the VM
 * (workspace-server.mts), over a socket Lima forwards to the host, and logs it.
 *
 * The template is baked once per recipe: Lima's Docker template, the host's extra trusted roots, Node for the server, and
 * the project's own `## Workspace` provisioning from VERIFY.md. Its name is a hash of all of that, so a changed recipe bakes a
 * new one and an unchanged one is reused. A run's clone is deleted when the run ends, with everything it started.
 *
 * Not closed: the VM reaches every service on the host's loopback (Lima's host.lima.internal), not only the run's proxy.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir, platform } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Where run folders and the launcher's own files for each run live. Short, because Lima keeps each instance's sockets under
 * its own folder and macOS caps a socket path at 104 bytes.
 */
export const RUNS = join(homedir(), '.sdlc-verify');

// Bumped when the base recipe below changes, so every template is baked again.
const BASE_VERSION = 2;
const GUEST_RUN = '/run/sdlc-verify';
const GUEST_SOCKET = `${GUEST_RUN}/ws.sock`;
const SYSTEM_BUNDLE = '/etc/ssl/certs/ca-certificates.crt';
// Every variable a tool reads its trusted roots from, pointed at the VM's system bundle, which holds the host's roots and the proxy's.
const TRUST_VARS = ['NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'CURL_CA_BUNDLE', 'REQUESTS_CA_BUNDLE', 'GIT_SSL_CAINFO'];
// Playwright's own Chromium: the CLI otherwise looks for Google Chrome, which the VM doesn't have.
const PLAYWRIGHT = { browser: { browserName: 'chromium' } };

/** A host folder a run reads through a writable layer of its own: the tool's cache, never written on the host. */
export interface Cache {
  host: string;
  guest: string;
  env: Record<string, string>;
}
/** The project's `## Workspace` section: what its template installs, the caches a run reads, and the VM's size. */
export interface Recipe {
  provision: string;
  caches: Cache[];
  cpus: number;
  memory: number;
  disk: number;
}

const DEFAULTS = { provision: '', caches: [], cpus: 4, memory: 8, disk: 60 };

/**
 * The `## Workspace` section's JSON block, foreman's own settings beside the section's prose, or the defaults when there is
 * none: the verify skill makes the section prose, and the verifier installs what it names. Throws when the block is malformed.
 */
export const parseRecipe = (verifyMd: string | null): Recipe => {
  const section = verifyMd?.split(/^## /m).find((s) => /^Workspace\s*\n/.test(s));
  const block = section?.match(/```json\n([\s\S]*?)```/)?.[1];
  if (!block) return { ...DEFAULTS };
  const r = JSON.parse(block) as Partial<Recipe>;
  const problems: string[] = [];
  const provision = Array.isArray(r.provision) ? r.provision.join('\n') : (r.provision ?? '');
  if (typeof provision !== 'string') problems.push('provision: a shell script, as a string or a list of lines');
  for (const k of ['cpus', 'memory', 'disk'] as const)
    if (r[k] !== undefined && !(Number.isInteger(r[k]) && r[k]! > 0)) problems.push(`${k}: a positive whole number`);
  const caches = Array.isArray(r.caches) ? r.caches : r.caches === undefined ? [] : (problems.push('caches: a list'), []);
  for (const [i, c] of caches.entries()) {
    if (typeof c?.host !== 'string' || !/^(~\/|\/)/.test(c.host)) problems.push(`caches.${i}.host: a host folder, absolute or under ~/`);
    if (typeof c?.guest !== 'string' || !c.guest.startsWith('/')) problems.push(`caches.${i}.guest: an absolute folder in the VM`);
    if (c?.env !== undefined && (typeof c.env !== 'object' || !Object.values(c.env).every((v) => typeof v === 'string')))
      problems.push(`caches.${i}.env: names to values`);
  }
  if (problems.length) throw new Error(`VERIFY.md Workspace: ${problems.join('; ')}`);
  return { ...DEFAULTS, ...r, provision, caches: caches.map((c) => ({ host: c.host, guest: c.guest, env: c.env ?? {} })) } as Recipe;
};

const inside = (p: string, dir: string) => p === dir || p.startsWith(dir + '/');

/**
 * The host folder a cache shares, or why it can't: a cache is a tool's packages, so one that is or holds the owner's home, a
 * folder that holds how the code was written (the source repo, Claude Code's config) or sits inside one, is refused.
 */
export const cacheFolder = (host: string, forbidden: string[]): { outcome: 'shared'; path: string } | { outcome: 'refused' | 'missing'; reason: string } => {
  const path = resolve(host.replace(/^~(?=\/)/, homedir()));
  if (!existsSync(path)) return { outcome: 'missing', reason: `${host} does not exist on this machine` };
  const real = realpathSync(path);
  if (inside(homedir(), real)) return { outcome: 'refused', reason: `${host} is or holds the home folder` };
  const hit = forbidden.find((f) => inside(f, real) || inside(real, f));
  return hit ? { outcome: 'refused', reason: `${host} overlaps ${hit}` } : { outcome: 'shared', path: real };
};

/** What this machine lacks to run a workspace, or null when it has it. */
export const workspaceMissing = (): string | null => {
  if (platform() !== 'darwin' && platform() !== 'linux') return `a run's workspace is a Lima VM, on macOS or Linux, not ${platform()}`;
  if (spawnSync('limactl', ['--version'], { stdio: 'ignore' }).status !== 0) return 'Lima, which runs the workspace VM, is not installed (brew install lima)';
  return null;
};

/**
 * The certificates in `pem` that can anchor TLS: marked as a CA and not expired at `now`. A keychain also holds device
 * identities, leaves and expired roots, and one malformed certificate in the system bundle stops a strict TLS stack (workerd)
 * from loading any of it.
 */
export const caRoots = (pem: string, now = new Date()): string =>
  (pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [])
    .filter((block) => {
      try {
        const cert = new X509Certificate(block);
        return cert.ca && cert.validToDate > now;
      } catch {
        return false;
      }
    })
    .map((block) => block + '\n')
    .join('');

/**
 * The host's trusted roots beyond the public ones, as PEM: a network that inspects TLS (a corporate proxy) re-signs every
 * site with its own root, and a fresh VM trusts nothing it hasn't been given.
 */
export const hostRoots = (): string => {
  if (platform() === 'darwin') {
    const r = spawnSync('security', ['find-certificate', '-a', '-p', '/Library/Keychains/System.keychain'], { encoding: 'utf8' });
    return r.status === 0 ? caRoots(r.stdout) : '';
  }
  const dir = '/usr/local/share/ca-certificates';
  return existsSync(dir)
    ? caRoots(
        readdirSync(dir, { recursive: true, encoding: 'utf8' })
          .filter((f) => f.endsWith('.crt'))
          .map((f) => readFileSync(join(dir, f), 'utf8'))
          .join('\n'),
      )
    : '';
};

const lima = (args: string[], opts: { input?: string; timeout?: number } = {}) =>
  spawnSync('limactl', args, { encoding: 'utf8', input: opts.input, timeout: opts.timeout ?? 600_000, maxBuffer: 1 << 28 });
const limaOk = (args: string[], what: string, opts?: { input?: string; timeout?: number }) => {
  const r = lima(args, opts);
  if (r.status !== 0) throw new Error(`${what} failed: ${(r.stderr || r.stdout || r.error?.message || '').trim().split('\n').slice(-5).join(' | ')}`);
  return r.stdout;
};
const instanceDir = (name: string) => limaOk(['list', name, '--format', '{{.Dir}}'], `finding the VM ${name}`).trim();
const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/** The template's name for a recipe: the same recipe, base and host roots always name the same template. */
export const templateName = (recipe: Recipe, roots: string) =>
  `sdlc-${createHash('sha256')
    .update(
      JSON.stringify({
        BASE_VERSION,
        node: process.versions.node.split('.')[0],
        provision: recipe.provision,
        size: [recipe.cpus, recipe.memory, recipe.disk],
        roots,
      }),
    )
    .digest('hex')
    .slice(0, 12)}`;

/**
 * The template for `recipe`, baked first when this machine has none: Lima's Docker template with no mounts and no port
 * forwarding to the host, the host's roots trusted, Node for the workspace server, then the project's provisioning. A bake
 * that fails leaves no template behind, so the next launch bakes again.
 */
export const ensureTemplate = ({ recipe, log }: { recipe: Recipe; log: (line: string) => void }): string => {
  const roots = hostRoots();
  const name = templateName(recipe, roots);
  const dir = join(RUNS, 'templates');
  mkdirSync(dir, { recursive: true });
  const listed = lima(['list', '--format', '{{.Name}}']).stdout.split('\n');
  if (listed.includes(name) && existsSync(join(instanceDir(name), 'sdlc-baked'))) return name;
  if (listed.includes(name)) lima(['delete', '-f', name]);

  const rootsFile = join(dir, `${name}-roots.pem`);
  if (roots.trim()) writeFileSync(rootsFile, roots);
  const yaml = join(dir, `${name}.yaml`);
  writeFileSync(
    yaml,
    [
      'minimumLimaVersion: 2.0.0',
      'base:',
      '- template:docker-rootful',
      `cpus: ${recipe.cpus}`,
      `memory: "${recipe.memory}GiB"`,
      `disk: "${recipe.disk}GiB"`,
      'mounts: []',
      ...(roots.trim() ? ['caCerts:', '  files:', `  - ${JSON.stringify(rootsFile)}`] : []),
      // The workspace server's socket comes to the host; no port the run opens does. Not under the instance's `sock/`, which a
      // clone gets with no permissions at all (Lima 2.2).
      'portForwards:',
      `- guestSocket: ${JSON.stringify(GUEST_SOCKET)}`,
      '  hostSocket: "{{.Dir}}/ws.sock"',
      '- guestPortRange: [1, 65535]',
      '  ignore: true',
      '',
    ].join('\n'),
  );
  const bakeLog = join(dir, `${name}.log`);
  log(`▶ baking the workspace template ${name} (once per recipe; the log is ${bakeLog})`);
  try {
    limaOk(['create', '--tty=false', '--name', name, '--mount-none', yaml], 'creating the template VM');
    limaOk(['start', '--tty=false', name], 'starting the template VM', { timeout: 3_600_000 });
    const node = process.versions.node;
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    const base = [
      'set -euxo pipefail',
      'export DEBIAN_FRONTEND=noninteractive',
      'sudo apt-get update -q && sudo apt-get install -y -q git curl jq ca-certificates xz-utils lsof',
      `curl -fsSL https://nodejs.org/dist/v${node}/node-v${node}-linux-${arch}.tar.xz | sudo tar -xJ -C /usr/local --strip-components=1`,
      'sudo corepack enable',
      `echo NODE_EXTRA_CA_CERTS=${SYSTEM_BUNDLE} | sudo tee -a /etc/environment`,
    ].join('\n');
    for (const [what, script] of [
      ['the base', base],
      ['the project', recipe.provision],
    ] as const) {
      if (!script.trim()) continue;
      log(`  provisioning ${what}`);
      const r = lima(['shell', '--workdir', '/', name, '--', 'bash', '-lc', `export NODE_EXTRA_CA_CERTS=${SYSTEM_BUNDLE}; bash -s`], {
        input: script,
        timeout: 3_600_000,
      });
      writeFileSync(bakeLog, `## ${what}\n${r.stdout}\n${r.stderr}\n`, { flag: 'a' });
      if (r.status !== 0) throw new Error(`provisioning ${what} failed (exit ${r.status}); see ${bakeLog}`);
    }
    limaOk(['stop', name], 'stopping the template VM');
    writeFileSync(join(instanceDir(name), 'sdlc-baked'), new Date().toISOString() + '\n');
  } catch (e) {
    lima(['delete', '-f', name]);
    throw e;
  }
  log(`▶ template ${name} is baked`);
  return name;
};

export interface Workspace {
  /** One line for the evidence page: where the commands ran, and what of the host they could read. */
  summary: string;
  /** The same for the console, naming the VM. */
  banner: string;
  /** The shell the verifier's Bash tool runs through, for CLAUDE_CODE_SHELL_PREFIX. */
  shell: string;
  /** Where every command is logged, one JSON line each (workspace-shell.mts's LoggedCommand). */
  commandLog: string;
  /** The exported files the run changed, compared with the export. */
  changed: () => string[];
  /** Stops and deletes the VM, with everything the run started; returns what it stopped and anything it could not. */
  close: () => Promise<{ stopped: string[]; stillRunning: string[] }>;
}

/** The environment a command gets in the VM: the launcher's, without what names the host, with the proxy reached from the VM. */
const guestEnv = (env: Record<string, string>, caches: Cache[], verifyDir: string): Record<string, string> => {
  const out: Record<string, string> = { LANG: 'C.UTF-8' };
  for (const [k, v] of Object.entries(env)) {
    if (['PATH', 'HOME', 'SHELL', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR'].includes(k)) continue;
    out[k] = /^(https?|all)_proxy$/i.test(k) ? v.replace(/@127\.0\.0\.1:/, '@host.lima.internal:') : v;
  }
  for (const k of TRUST_VARS) out[k] = SYSTEM_BUNDLE;
  for (const c of caches) Object.assign(out, c.env);
  out.PLAYWRIGHT_MCP_CONFIG = join(verifyDir, 'playwright.json');
  return out;
};

const reachable = (socket: string) =>
  new Promise<boolean>((done) => {
    const c = connect(socket);
    c.once('connect', () => (c.destroy(), done(true)));
    c.once('error', () => done(false));
  });

/**
 * Clones `template` into a VM for the run, moves the export in `work` onto its disk (the host keeps only `.verify`), mounts
 * each cache with a layer of the run's own over it, and starts the workspace server. `env` is the whole environment commands
 * get; `trust`, when set, is a root the VM must trust (the credential proxy's). Throws when the workspace doesn't start.
 */
export const openWorkspace = async ({
  template,
  work,
  stateDir,
  pluginDir,
  runnerDir,
  caches,
  env,
  trust,
  serve = true,
}: {
  template: string;
  work: string;
  stateDir: string;
  pluginDir: string;
  /** The runner's own folder: the workspace server runs from it. */
  runnerDir: string;
  caches: (Cache & { path: string })[];
  env: Record<string, string>;
  trust?: string;
  serve?: boolean;
}): Promise<Workspace & { name: string }> => {
  const verifyDir = join(work, '.verify');
  mkdirSync(verifyDir, { recursive: true });
  writeFileSync(join(verifyDir, 'playwright.json'), JSON.stringify(PLAYWRIGHT, null, 2) + '\n');
  const name = `sdlc-run-${randomBytes(4).toString('hex')}`;
  const mounts = [`${verifyDir}:w`, pluginDir, runnerDir, ...caches.map((c) => c.path)].flatMap((m) => ['--mount-only', m]);
  limaOk(['clone', '--tty=false', template, name, ...mounts], 'cloning the template');
  const remove = () => lima(['delete', '-f', name], { timeout: 180_000 });
  try {
    limaOk(['start', '--tty=false', name], 'starting the VM', { timeout: 600_000 });
    const setup = [
      'set -e',
      `sudo mkdir -p ${GUEST_RUN} ${q(work)} && sudo chown "$USER" ${GUEST_RUN} ${q(work)}`,
      ...caches.flatMap((c, i) => [
        `sudo mkdir -p /var/lib/sdlc-cache/${i}/upper /var/lib/sdlc-cache/${i}/work ${q(c.guest)}`,
        `sudo mount -t overlay overlay -o lowerdir=${q(c.path)},upperdir=/var/lib/sdlc-cache/${i}/upper,workdir=/var/lib/sdlc-cache/${i}/work,metacopy=on,redirect_dir=on ${q(c.guest)}`,
        `sudo chown "$USER" ${q(c.guest)}`,
      ]),
      ...(trust ? [`sudo cp ${q(trust)} /usr/local/share/ca-certificates/sdlc-run.crt && sudo update-ca-certificates >/dev/null`] : []),
    ].join('\n');
    limaOk(['shell', '--workdir', '/', name, '--', 'bash', '-s'], 'preparing the VM', { input: setup });

    // The export goes onto the VM's own disk; the host keeps only the run's .verify folder, which the VM shares back.
    // macOS's tar would add its extended attributes as `._` files; neither side's tar needs them.
    const pushed = spawnSync(
      'bash',
      [
        '-c',
        'set -o pipefail; COPYFILE_DISABLE=1 tar -C "$1" --no-xattrs --exclude ./.verify -cf - . | limactl shell --workdir / "$2" -- tar --warning=no-unknown-keyword -xf - -C "$1"',
        '_',
        work,
        name,
      ],
      { encoding: 'utf8', maxBuffer: 1 << 26 },
    );
    if (pushed.status !== 0) throw new Error(`moving the export into the VM failed: ${pushed.stderr.trim().slice(-300)}`);
    for (const entry of readdirSync(work)) if (entry !== '.verify') rmSync(join(work, entry), { recursive: true, force: true });
    limaOk(
      [
        'shell',
        '--workdir',
        work,
        name,
        '--',
        'bash',
        '-c',
        `find . -path ./.verify -prune -o -type f -print0 | xargs -0 -r sha1sum > ${GUEST_RUN}/before.sha1`,
      ],
      'listing the export',
    );

    const commandLog = join(stateDir, 'commands.jsonl');
    writeFileSync(commandLog, '');
    const vars = guestEnv(env, caches, verifyDir);
    limaOk(['shell', '--workdir', '/', name, '--', 'bash', '-c', `cat > ${GUEST_RUN}/env`], 'writing the environment', {
      input: Object.entries(vars)
        .map(([k, v]) => `export ${k}=${q(v)}`)
        .join('\n'),
    });

    const caching = caches.length ? `, caches read-only (${caches.map((c) => c.host).join(', ')})` : '';
    const summary = `Workspace: a local Linux VM, fresh for this run; it shares with the host only the run's evidence folder and, read-only, the skill's and the runner's folders${caching}.`;
    const banner = `Workspace: Lima VM ${name}, cloned from ${template}; it holds the export on its own disk and shares only the run's .verify, the plugin's and the runner's folders read-only${caching}.`;
    const changed = () =>
      lima(['shell', '--workdir', work, name, '--', 'bash', '-c', `sha1sum -c --quiet ${GUEST_RUN}/before.sha1 2>/dev/null; true`])
        .stdout.split('\n')
        .map((l) => l.match(/^\.\/(.+): FAILED/)?.[1])
        .filter((p): p is string => Boolean(p));

    if (!serve) {
      const close = async () => (remove(), { stopped: [`VM ${name}`], stillRunning: [] });
      return { name, summary, banner, shell: '', commandLog, changed, close };
    }

    const server = spawn(
      'limactl',
      [
        'shell',
        '--workdir',
        work,
        name,
        '--',
        'bash',
        '-c',
        `set -a; . ${GUEST_RUN}/env; set +a; exec node ${q(join(runnerDir, 'workspace-server.mts'))} ${GUEST_SOCKET}`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stderr = '';
    server.stderr.on('data', (b: Buffer) => (stderr += b.toString()));
    const killServer = () => server.kill('SIGKILL');
    process.once('exit', killServer);
    await new Promise<void>((done, fail) => {
      const timer = setTimeout(() => fail(new Error(`the workspace did not start within 60s: ${stderr.trim().slice(-600)}`)), 60_000);
      server.stdout.on('data', (b: Buffer) => b.toString().includes('workspace ready') && (clearTimeout(timer), done()));
      server.once('exit', (code) => (clearTimeout(timer), fail(new Error(`the workspace exited (${code}) before it was ready: ${stderr.trim().slice(-600)}`))));
    });
    const socket = join(instanceDir(name), 'ws.sock');
    const deadline = Date.now() + 30_000;
    while (!(await reachable(socket))) {
      if (Date.now() > deadline) throw new Error(`the workspace's socket did not reach the host at ${socket}`);
      await new Promise((r) => setTimeout(r, 250));
    }

    const shell = join(stateDir, 'shell');
    const shellArgs = ['--socket', socket, '--log', commandLog, '--workspace', 'local-vm'].map(q).join(' ');
    writeFileSync(shell, `#!/bin/sh\nexec ${q(process.execPath)} ${q(join(runnerDir, 'workspace-shell.mts'))} ${shellArgs} "$@"\n`);
    chmodSync(shell, 0o755);

    const close = async () => {
      process.off('exit', killServer);
      server.kill('SIGTERM');
      const r = remove();
      return r.status === 0 ? { stopped: [`VM ${name}`], stillRunning: [] } : { stopped: [], stillRunning: [`VM ${name} (${r.stderr.trim().slice(-200)})`] };
    };
    return { name, summary, banner, shell, commandLog, changed, close };
  } catch (e) {
    remove();
    throw e;
  }
};
