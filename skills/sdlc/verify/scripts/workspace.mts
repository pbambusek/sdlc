/**
 * A run's workspace: where every command the verifier runs executes, confined so that it reads and writes its own folder and
 * temp, reads the skill's folder and the toolchains a build needs, and nothing else of the owner's. The verifier, its login
 * and its transcript stay outside. The verifier's Bash tool runs through a shell (workspace-shell.mts) that sends each command
 * to a server inside the workspace (workspace-server.mts) and logs it.
 *
 * This is the local workspace, on the owner's machine: nono's sandbox, Seatbelt on macOS and Landlock on Linux, one profile for
 * both. Another provider (a remote sandbox) would run the same server where it confines commands; nothing outside this file
 * names the provider.
 *
 * The run gets a home of its own inside its folder, because a home it shares would hold what it must not see (other
 * sessions' transcripts, keys, logins), and Landlock can't carve exceptions out of a granted folder. The run's home links the
 * shared toolchains read-only, so a build finds them where it looks; every cache it writes is its own, so nothing it leaves
 * behind runs later on the owner's machine outside the workspace.
 *
 * Not closed: the Docker socket. A container the run starts can bind-mount whatever Docker shares from the host.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { basename, dirname, join } from 'node:path';

// Toolchains under the owner's home that a run may read, linked into the run's home where a tool looks for them.
const TOOLCHAINS = [
  '.nvm',
  '.dotnet',
  '.rd/bin',
  '.local/bin',
  // Not `.aspire/versions` or `.aspire/npm`: the Aspire CLI writes those on every start, so each run has its own.
  '.aspire/bin',
  '.aspire/bundle',
  '.aspire/dev-certs',
];
// Caches whose entries a run reads but whose folder it writes to: the run's own folder links each entry in, except those
// listed, which the tool writes (Playwright keeps its daemon's and browsers' state next to the browsers).
const CACHE_ENTRIES = [
  { path: 'Library/Caches/ms-playwright', own: ['daemon', 'b', 'cli-update-check.json'] },
  { path: '.cache/ms-playwright', own: ['daemon', 'b', 'cli-update-check.json'] },
];
// Small settings files a tool needs and may change: copied into the run's home, never linked.
const SETTINGS = ['.aspire/aspire.config.json', '.aspire/globalsettings.json'];
// Toolchains installed outside the home that the system groups don't cover.
const SYSTEM_TOOLCHAINS = ['/usr/local/share/dotnet', '/usr/share/dotnet', '/usr/lib/dotnet'];
// Files in the owner's home that every macOS process reads at start: the text encoding CoreFoundation uses, nothing private.
const SYSTEM_FILES = ['.CFUserTextEncoding'];

// macOS-only rules; Linux needs none of them. Chromium runs inside Seatbelt only when it may open IOKit and register its own
// Mach services. .NET verifies TLS (NuGet restores, the credential proxy's root) only through the system's trust services;
// keychain items stay unreadable with them.
const SEATBELT = [
  '(allow iokit-open)',
  '(allow mach-register (global-name-prefix "org.chromium."))',
  '(allow mach-lookup (global-name-prefix "org.chromium."))',
  '(allow mach-lookup (global-name "com.apple.trustd") (global-name "com.apple.trustd.agent") (global-name "com.apple.SecurityServer") (global-name "com.apple.ocspd"))',
];
// Chrome's own sandbox can't nest inside the workspace's, and its crash reporter writes outside the run's home.
const PLAYWRIGHT = { browser: { browserName: 'chromium', launchOptions: { chromiumSandbox: false, args: ['--disable-crash-reporter', '--disable-breakpad'] } } };

/**
 * Where run folders and the launcher's own files for each run live: under the owner's home, which the workspace can't read
 * beyond its own run folder, and outside the system temp it can't reach either. Short, because tools in a run open Unix
 * sockets under its folder and macOS caps their paths at 104 bytes.
 */
export const RUNS = join(homedir(), '.sdlc-verify');

/** What this machine lacks to confine a run, or null when it has it. */
export const workspaceMissing = (): string | null => {
  if (platform() !== 'darwin' && platform() !== 'linux') return `a confined workspace runs on macOS and Linux, not ${platform()}`;
  const nono = spawnSync('nono', ['--version'], { encoding: 'utf8' });
  if (nono.status !== 0) return 'nono, which confines the workspace, is not installed (brew install nono)';
  return null;
};

/** The Docker socket the owner's CLI talks to, when it is a local Unix socket. */
const dockerSocket = (): string | null => {
  let host = process.env.DOCKER_HOST;
  if (!host) {
    try {
      host = execFileSync('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim();
    } catch {
      host = existsSync('/var/run/docker.sock') ? 'unix:///var/run/docker.sock' : '';
    }
  }
  const path = host?.startsWith('unix://') ? host.slice('unix://'.length) : null;
  return path && existsSync(path) ? path : null;
};

/**
 * A localhost certificate for the run's HTTPS endpoints. ASP.NET's development certificate lives in the macOS keychain, which
 * the workspace can't open, so Kestrel (an Aspire dashboard, any ASP.NET app) gets this one from files instead. Null without openssl.
 */
const makeDevCert = (dir: string): { cert: string; key: string } | null => {
  mkdirSync(dir, { recursive: true });
  const cert = join(dir, 'cert.pem');
  const key = join(dir, 'key.pem');
  const args = ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '7', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', key, '-out', cert];
  return spawnSync('openssl', args, { stdio: 'ignore' }).status === 0 ? { cert, key } : null;
};

/** IDs of the running Docker containers, or null without Docker. */
const runningContainers = (): string[] | null => {
  const r = spawnSync('docker', ['ps', '-q', '--no-trunc'], { encoding: 'utf8', timeout: 15_000 });
  return r.status === 0 ? r.stdout.split('\n').filter(Boolean) : null;
};

/** Live processes, other than this one, whose command line names the run folder or whose working folder is in it. */
export const processesIn = (work: string): { pid: number; command: string }[] => {
  const inside = (p: string) => p === work || p.startsWith(work + '/');
  const found = new Map<number, string>();
  const rows = execFileSync('ps', ['-A', '-ww', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 1 << 26 })
    .split('\n')
    .map((l) => l.trim().match(/^(\d+)\s+(.*)$/))
    .filter((m): m is RegExpMatchArray => m !== null);
  const commands = new Map(rows.map(([, pid, command]) => [Number(pid), command!]));
  for (const [pid, command] of commands) if (command.includes(work)) found.set(pid, command);
  if (platform() === 'linux') {
    for (const pid of commands.keys()) {
      try {
        if (inside(readlinkSync(`/proc/${pid}/cwd`))) found.set(pid, commands.get(pid)!);
      } catch {}
    }
  } else {
    const lsof = spawnSync('lsof', ['-a', '-d', 'cwd', '-Fpn', '-u', String(process.getuid?.() ?? '')], { encoding: 'utf8', maxBuffer: 1 << 26 });
    let pid = 0;
    for (const line of (lsof.stdout ?? '').split('\n')) {
      if (line.startsWith('p')) pid = Number(line.slice(1));
      else if (line.startsWith('n') && inside(line.slice(1)) && commands.has(pid)) found.set(pid, commands.get(pid)!);
    }
  }
  found.delete(process.pid);
  return [...found].map(([pid, command]) => ({ pid, command }));
};

export interface Refusal {
  path: string;
  access: string;
}

/** The accesses the sandbox refused its own process, from the diagnostics nono prints when that process ends. */
export const parseDenials = (stderr: string): Refusal[] | null => {
  const start = stderr.lastIndexOf('{\n  "session"');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < stderr.length; i++) {
    if (stderr[i] === '{') depth++;
    else if (stderr[i] === '}' && --depth === 0) {
      try {
        const session = JSON.parse(stderr.slice(start, i + 1)).session as { denials?: Refusal[] };
        return (session.denials ?? []).map(({ path, access }) => ({ path, access }));
      } catch {
        return null;
      }
    }
  }
  return null;
};

export interface Workspace {
  /** One line for the evidence page: the workspace is confined, and what it may reach beyond its folder. */
  summary: string;
  /** The same for the console, naming how it is confined. */
  banner: string;
  /** The shell the verifier's Bash tool runs through, for CLAUDE_CODE_SHELL_PREFIX. */
  shell: string;
  /** Where every command is logged, one JSON line each (workspace-shell.mts's LoggedCommand). */
  commandLog: string;
  /** The run's own home, inside the run folder. */
  home: string;
  /** The pid of the process that holds the workspace, to sample its environments. */
  pid: number;
  /** Stops everything the run started; returns what the sandbox refused its server (null when unknown) and what was left running. */
  close: () => Promise<{ refused: Refusal[] | null; stopped: string[]; stillRunning: string[] }>;
}

export interface Prepared {
  work: string;
  skillDir: string;
  stateDir: string;
  summary: string;
  banner: string;
  home: string;
  sockets: string;
  /** The command that runs `argv` in the workspace, with the run's environment and nothing else of the launcher's. */
  wrap: (argv: string[]) => string[];
}

/**
 * Builds the run's home in `<work>/.verify` and the sandbox profile in `stateDir`, a folder the workspace can't reach. `env`
 * is the whole environment commands get, on top of the run's home and temp: nothing else of the launcher's passes in. `deny`
 * names folders the workspace must not reach wherever they are.
 */
export const prepareWorkspace = ({ work, skillDir, stateDir, env, deny = [] }: { work: string; skillDir: string; stateDir: string; env: Record<string, string>; deny?: string[] }): Prepared => {
  const owner = homedir();
  const verifyDir = join(work, '.verify');
  const home = join(verifyDir, 'home');
  const tmp = join(verifyDir, 'tmp');
  const sockets = join(verifyDir, 'ws');
  for (const d of [home, tmp, sockets]) mkdirSync(d, { recursive: true });

  const toolchains = TOOLCHAINS.filter((t) => existsSync(join(owner, t)));
  for (const t of toolchains) {
    mkdirSync(dirname(join(home, t)), { recursive: true });
    symlinkSync(join(owner, t), join(home, t));
  }
  const caches = CACHE_ENTRIES.filter((c) => existsSync(join(owner, c.path)));
  for (const c of caches) {
    mkdirSync(join(home, c.path), { recursive: true });
    for (const entry of readdirSync(join(owner, c.path)).filter((e) => !c.own.includes(e))) symlinkSync(join(owner, c.path, entry), join(home, c.path, entry));
  }
  const readable = [...toolchains, ...caches.map((c) => c.path)];
  for (const s of SETTINGS.filter((s) => existsSync(join(owner, s)))) {
    mkdirSync(dirname(join(home, s)), { recursive: true });
    cpSync(join(owner, s), join(home, s));
  }
  writeFileSync(join(verifyDir, 'playwright.json'), JSON.stringify(PLAYWRIGHT, null, 2) + '\n');

  const docker = dockerSocket();
  const devCert = makeDevCert(join(verifyDir, 'dev-cert'));
  const systemToolchains = SYSTEM_TOOLCHAINS.filter((p) => existsSync(p));
  // The server runs on the launcher's own Node, which may live outside every toolchain above.
  const node = dirname(dirname(process.execPath));
  const profile = {
    meta: { name: 'verify-workspace' },
    extends: 'default',
    groups: { include: ['node_runtime'] },
    workdir: { access: 'readwrite' },
    // Commands may manage and inspect the processes the workspace started, never the launcher's, the proxy's or the verifier's.
    security: { signal_mode: 'allow_same_sandbox', process_info_mode: 'allow_same_sandbox' },
    filesystem: {
      read: [...new Set([skillDir, node, ...readable.map((t) => join(owner, t)), ...systemToolchains])],
      read_file: SYSTEM_FILES.map((f) => join(owner, f)).filter((f) => existsSync(f)),
      ...(docker ? { unix_socket: [docker] } : {}),
      // macOS lets every sandboxed process read /private/tmp, where Claude Code keeps its sessions' files, and the per-user
      // temp under /var/folders, which stays because macOS tools write there whatever TMPDIR says: so the folders in `deny`
      // (the source repo, Claude Code's config) are refused even when they live in a temp. Linux grants /tmp write-only.
      ...(platform() === 'darwin' ? { deny: ['/private/tmp', ...deny] } : {}),
    },
    platform_overrides: { macos: { unsafe_macos_seatbelt_rules: SEATBELT } },
  };
  const profileFile = join(stateDir, 'workspace-profile.json');
  writeFileSync(profileFile, JSON.stringify(profile, null, 2) + '\n');

  const commandEnv: Record<string, string> = {
    ...env,
    HOME: home,
    TMPDIR: tmp,
    // The shell checks the folder it inherits as its working directory, and the launcher's lies outside the workspace.
    PWD: work,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local/share'),
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_STATE_HOME: join(home, '.local/state'),
    PLAYWRIGHT_MCP_CONFIG: join(verifyDir, 'playwright.json'),
    DOTNET_CLI_TELEMETRY_OPTOUT: '1',
    DOTNET_NOLOGO: '1',
    ...(devCert ? { ASPNETCORE_Kestrel__Certificates__Default__Path: devCert.cert, ASPNETCORE_Kestrel__Certificates__Default__KeyPath: devCert.key } : {}),
    ...(docker ? { DOCKER_HOST: `unix://${docker}` } : {}),
  };
  // nono keeps its own state under the owner's home, so the run's environment is set inside the sandbox, not around it.
  const wrap = (argv: string[]) => [
    'nono', 'run', '-s', '--no-rollback', '--diagnostics-json', '--profile', profileFile, '--workdir', work, '--allow-cwd', '--allow-unix-socket-dir-bind', sockets, '--',
    'env', '-i', ...Object.entries(commandEnv).map(([k, v]) => `${k}=${v}`), ...argv,
  ];

  const reach = [
    'the skill folder',
    readable.length || systemToolchains.length ? `toolchains read-only (${[...readable.map((t) => `~/${t}`), ...systemToolchains].join(', ')})` : null,
    docker ? `the Docker socket` : null,
  ].filter(Boolean);
  const summary = `Workspace: local, confined; reads beyond the run folder: ${reach.join(', ')}.`;
  const banner = `Workspace: local, confined by nono (${platform() === 'darwin' ? 'Seatbelt' : 'Landlock'}); beyond its own folder it reads only ${reach.join(', ')}${docker ? ` (${docker})` : ''}.`;
  return { work, skillDir, stateDir, summary, banner, home, sockets, wrap };
};

/**
 * Starts the workspace's server in the sandbox, and writes the verifier's shell into the state folder. Throws when the
 * workspace doesn't start.
 */
export const openWorkspace = async (prepared: Prepared): Promise<Workspace> => {
  const { work, skillDir, stateDir, summary, banner, home, sockets, wrap } = prepared;
  const socket = join(sockets, 's');
  const containersBefore = runningContainers();
  const [cmd, ...args] = wrap([process.execPath, join(skillDir, 'scripts/workspace-server.mts'), socket]);
  const server = spawn(cmd!, args, { cwd: work, env: { PATH: process.env.PATH ?? '', HOME: homedir() }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  server.stderr.on('data', (b: Buffer) => (stderr += b.toString()));
  const killServer = () => server.kill('SIGKILL');
  process.once('exit', killServer);
  await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`the workspace did not start within 30s: ${stderr.trim().slice(-600)}`)), 30_000);
    server.stdout.on('data', (b: Buffer) => b.toString().includes('workspace ready') && (clearTimeout(timer), done()));
    server.once('exit', (code) => (clearTimeout(timer), fail(new Error(`the workspace exited (${code}) before it was ready: ${stderr.trim().slice(-600)}`))));
  });

  const commandLog = join(stateDir, 'commands.jsonl');
  writeFileSync(commandLog, '');
  const shell = join(stateDir, 'shell');
  const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
  const shellArgs = ['--socket', socket, '--log', commandLog, '--workspace', 'local', '--work', work].map(q).join(' ');
  writeFileSync(shell, `#!/bin/sh\nexec ${q(process.execPath)} ${q(join(skillDir, 'scripts/workspace-shell.mts'))} ${shellArgs} "$@"\n`);
  chmodSync(shell, 0o755);

  const close = async () => {
    process.off('exit', killServer);
    if (server.exitCode === null) {
      const exited = new Promise((done) => server.once('exit', done));
      server.kill('SIGTERM');
      const timer = setTimeout(killServer, 15_000);
      await exited;
      clearTimeout(timer);
    }
    const stopped: string[] = [];
    const containersAfter = runningContainers();
    const started = containersBefore && containersAfter ? containersAfter.filter((id) => !containersBefore.includes(id)) : [];
    if (started.length) {
      spawnSync('docker', ['stop', ...started], { stdio: 'ignore', timeout: 120_000 });
      stopped.push(`${started.length} container${started.length === 1 ? '' : 's'}`);
    }
    const strays = processesIn(work);
    for (const { pid } of strays) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {}
    }
    if (strays.length) {
      await new Promise((done) => setTimeout(done, 3_000));
      for (const { pid } of processesIn(work)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
      }
      stopped.push(`${strays.length} process${strays.length === 1 ? '' : 'es'} (${[...new Set(strays.map((s) => basename(s.command.split(' ')[0]!)))].join(', ')})`);
    }
    const stillRunning = [
      ...processesIn(work).map((s) => `process ${s.pid} (${s.command.slice(0, 120)})`),
      ...((started.length ? runningContainers() : [])?.filter((id) => started.includes(id)).map((id) => `container ${id.slice(0, 12)}`) ?? []),
    ];
    return { refused: parseDenials(stderr), stopped, stillRunning };
  };
  return { summary, banner, shell, commandLog, home, pid: server.pid!, close };
};
