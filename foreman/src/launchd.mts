// A LaunchAgent that runs `foreman tick` every few minutes while you are logged in.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { HOME } from './config.mts';

// Named when foreman was sdlc-tick; kept so `foreman install` replaces an agent installed under the old name.
export const LABEL = 'com.sdlc-tick';
const plistPath = () => join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const domain = () => `gui/${userInfo().uid}`;
const bin = () => resolve(import.meta.dirname, '..', 'bin', 'foreman');
/** Only what bypasses the journal: launchd failing to start node, or node dying before it can write. */
export const stderrPath = () => join(HOME, 'launchd-stderr.log');

// launchd starts jobs with a minimal PATH, so the plist carries the directories of the tools a tick runs.
const toolPath = () => {
  const dirs = new Set<string>([dirname(process.execPath)]);
  for (const tool of ['claude', 'gh', 'git']) {
    try {
      dirs.add(dirname(execFileSync('bash', ['-lc', `command -v ${tool}`], { encoding: 'utf8' }).trim()));
    } catch {
      throw new Error(`${tool} is not on PATH`);
    }
  }
  for (const d of ['/usr/bin', '/bin', '/usr/sbin', '/sbin']) dirs.add(d);
  return [...dirs].join(':');
};

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

export const plist = (intervalSeconds: number) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${esc(bin())}</string><string>tick</string></array>
  <key>StartInterval</key><integer>${intervalSeconds}</integer>
  <key>RunAtLoad</key><true/>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>${esc(toolPath())}</string>
    <key>HOME</key><string>${esc(homedir())}</string>
    <key>SDLC_SOURCE</key><string>launchd</string>
  </dict>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>${esc(stderrPath())}</string>
</dict>
</plist>
`;

const launchctl = (...args: string[]) => execFileSync('launchctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

export const install = (intervalSeconds: number) => {
  mkdirSync(HOME, { recursive: true });
  mkdirSync(dirname(plistPath()), { recursive: true });
  if (loaded()) launchctl('bootout', `${domain()}/${LABEL}`);
  writeFileSync(plistPath(), plist(intervalSeconds));
  launchctl('bootstrap', domain(), plistPath());
  return plistPath();
};

export const uninstall = () => {
  if (loaded()) launchctl('bootout', `${domain()}/${LABEL}`);
  if (existsSync(plistPath())) rmSync(plistPath());
};

export const kick = () => launchctl('kickstart', `${domain()}/${LABEL}`);

export const loaded = () => {
  try {
    launchctl('print', `${domain()}/${LABEL}`);
    return true;
  } catch {
    return false;
  }
};

/** The agent as the status page shows it: whether it is loaded, its last exit code and its interval in seconds. */
export const agentState = (): { loaded: boolean; lastExit: number | null; every: number | null } => {
  if (!loaded()) return { loaded: false, lastExit: null, every: null };
  const out = launchctl('print', `${domain()}/${LABEL}`);
  const num = (re: RegExp) => {
    const m = out.match(re);
    return m ? Number(m[1]) : null;
  };
  return { loaded: true, lastExit: num(/last exit code = (-?\d+)/), every: num(/run interval = (\d+) seconds/) };
};

/** The lines of `launchctl print` worth showing: state, runs, last exit code, interval. */
export const agentInfo = (): string => {
  if (!loaded()) return `launchd: ${LABEL} is not loaded (foreman install loads it)`;
  const out = launchctl('print', `${domain()}/${LABEL}`);
  const pick = out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^(state|runs|last exit code|run interval) =/.test(l));
  return `launchd: ${LABEL} loaded; ${pick.join('; ')}`;
};
