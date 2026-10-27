// foreman <command>: tick, verify, status, stats, install, uninstall, kick, whoami, doctor.
import { execFileSync, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadRuns } from './archive.mts';
import { configPath, HOME, loadConfig } from './config.mts';
import { jiraClient, KEYCHAIN_SERVICE } from './jira.mts';
import { journal, journalPath } from './journal.mts';
import { agentInfo, install, kick, uninstall } from './launchd.mts';
import { LAUNCHER, PLUGIN_DIR } from './sessions.mts';
import { byFeature, featureTable, parseSince, runTable, totals } from './stats.mts';
import { header, loadLastTick, saveTick, statusPagePath, table } from './status.mts';
import { tick } from './tick.mts';

const USAGE = `usage: foreman <command>
  tick [--dry-run] [--only KEY]   observe every issue in the ledger, decide, act
  verify <args>                   one verify run by hand, outside the loop (no args prints its usage)
  status [--live]                 the last tick's table (--live: observe now, act on nothing)
  stats [KEY] [--since 7d] [--json]  tokens, cost, time and rounds from the archive (KEY: each of its runs)
  install [--every <seconds>]     run tick from launchd (default every 300 s)
  uninstall                       stop and remove the launchd agent
  kick                            run a tick through launchd now
  log [KEY] [-f] [-n <lines>]     the journal of every run (KEY: that issue's latest verify launcher log); -f follows
  set-token                       store the Jira API token from the clipboard: copy it, then run this
  whoami                          your Jira account id, for the approvers list
  doctor                          check config, Jira, gh, claude and the sdlc plugin`;

const args = process.argv.slice(2);
const cmd = args.shift();
const flag = (name: string) => args.includes(name);
const value = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const stamp = () => new Date().toISOString();
const j = journal(cmd ?? 'help');
/** Prints a line and appends it to the journal: what any command does or fails at outlives the terminal. */
const say = (s: string) => {
  j.write(s);
  console.log(s);
};

// One tick at a time: a lock file holding the pid, taken over when that pid is gone.
const withLock = async (fn: () => Promise<void>) => {
  mkdirSync(HOME, { recursive: true });
  const lock = join(HOME, 'tick.lock');
  try {
    closeSync(openSync(lock, 'wx'));
  } catch {
    const pid = Number(readFileSync(lock, 'utf8'));
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = pid > 0;
    } catch {}
    if (alive) {
      j.write(`another tick (pid ${pid}) is running; skipped`);
      console.log(`${stamp()} another tick (pid ${pid}) is running; skipped`);
      return;
    }
  }
  writeFileSync(lock, String(process.pid));
  try {
    await fn();
  } finally {
    rmSync(lock, { force: true });
  }
};

const main = async () => {
  switch (cmd) {
    case 'verify': {
      // The launcher prints its own steps and exits with the run's code; foreman only passes it through, with the configured model unless --model names one.
      const model = !args.includes('--model') && existsSync(configPath()) ? loadConfig().verify.model : undefined;
      const r = spawnSync(process.execPath, ['--use-system-ca', LAUNCHER, ...args, ...(model ? ['--model', model] : [])], { stdio: 'inherit' });
      process.exitCode = r.status ?? 1;
      break;
    }
    case 'tick': {
      const config = loadConfig();
      await withLock(async () => {
        const dryRun = flag('--dry-run');
        const only = value('--only');
        const log = (s: string) => {
          j.write(s);
          console.log(`${stamp()} ${s}`);
        };
        log(`start${dryRun ? ', dry run' : ''}${only ? `, only ${only}` : ''} (pid ${process.pid})`);
        const r = await tick(config, jiraClient(config), { dryRun, only, log });
        if (!dryRun && !only) saveTick(r, config);
        j.write(`done in ${((Date.now() - Date.parse(r.at)) / 1000).toFixed(1)} s${r.errors.length ? `, ${r.errors.length} error(s)` : ''}\n${table(r)}`);
        console.log(`${stamp()} ${header(r, 'tick')}\n${table(r)}`);
        if (r.errors.length) process.exitCode = 1;
      });
      return;
    }
    case 'status': {
      if (flag('--live')) {
        const config = loadConfig();
        const r = await tick(config, jiraClient(config), { dryRun: true, log: () => {} });
        console.log(`${header(r, 'observed')}\n${table(r)}`);
      } else {
        const r = loadLastTick();
        console.log(header(r, 'last tick'));
        if (r) console.log(table(r));
      }
      console.log(`\n${agentInfo()}\npage: ${statusPagePath()}\nlog:  ${journalPath()} (foreman log -f)`);
      return;
    }
    case 'stats': {
      const config = loadConfig();
      const key = args.find((a) => /^[A-Z][A-Z0-9]*-\d+$/.test(a));
      const since = value('--since');
      const from = since ? parseSince(since) : null;
      const runs = loadRuns(key).filter((r) => !from || r.at >= from);
      if (flag('--json')) {
        console.log(JSON.stringify({ since: from, totals: totals(runs, config.prices), features: byFeature(runs, config.prices), runs }, null, 2));
        return;
      }
      if (from) console.log(`since ${from}\n`);
      console.log(key ? runTable(runs, config.prices) : featureTable(byFeature(runs, config.prices), totals(runs, config.prices)));
      console.log(`\nCost is at list price; tokens in = input + cache reads + cache writes.`);
      return;
    }
    case 'install': {
      const every = Number(value('--every') ?? 300);
      say(`installed ${install(every)}; ticks every ${every} s while you are logged in`);
      console.log(agentInfo());
      return;
    }
    case 'uninstall':
      uninstall();
      say('launchd agent removed');
      return;
    case 'kick':
      kick();
      say(`tick started through launchd; follow it with: foreman log -f`);
      return;
    case 'log': {
      const key = args.find((a) => /^[A-Z][A-Z0-9]*-\d+$/.test(a));
      let file = journalPath();
      if (key) {
        // Launcher logs are named <ISO time>-<sha7>-verify.log, so the last in name order is the latest.
        const dir = join(HOME, 'runs', key);
        const logs = existsSync(dir)
          ? readdirSync(dir)
              .filter((n) => n.endsWith('-verify.log'))
              .sort()
          : [];
        if (!logs.length) throw new Error(`${key} has no verify launcher log in ${dir}; a build runs as a Claude Code session: claude agents`);
        file = join(dir, logs.at(-1)!);
      }
      if (!existsSync(file)) throw new Error(`${file} does not exist yet`);
      console.log(`==> ${file}`);
      spawnSync('tail', ['-n', value('-n') ?? '40', ...(flag('-f') ? ['-f'] : []), file], { stdio: 'inherit' });
      return;
    }
    case 'set-token': {
      // Not the keychain's hidden prompt: it cuts input at 128 characters, and Atlassian tokens are longer.
      const config = loadConfig();
      const token = execFileSync('pbpaste', { encoding: 'utf8' }).trim();
      if (!/^ATATT\S{100,}$/.test(token))
        throw new Error(`the clipboard does not hold a Jira API token (it should start with ATATT); copy the token and run this again`);
      execFileSync('security', ['add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', config.jira.email, '-w', token], { stdio: 'ignore' });
      execFileSync('pbcopy', { input: '' });
      say(`stored a ${token.length}-character token for ${config.jira.email} and cleared the clipboard`);
      const me = await jiraClient(config).myself();
      console.log(`✔ Jira accepts it: signed in as ${me.displayName}`);
      return;
    }
    case 'whoami': {
      const me = await jiraClient(loadConfig()).myself();
      console.log(`${me.displayName}: ${me.accountId}`);
      return;
    }
    case 'doctor': {
      const check = async (name: string, fn: () => unknown | Promise<unknown>) => {
        try {
          const detail = await fn();
          console.log(`✔ ${name}${detail ? `: ${detail}` : ''}`);
        } catch (e) {
          console.log(`✖ ${name}: ${(e as Error).message.split('\n')[0]}`);
          process.exitCode = 1;
        }
      };
      let config: ReturnType<typeof loadConfig> | undefined;
      await check('config', () => {
        config = loadConfig();
        return configPath();
      });
      if (!config) return;
      const c = config;
      await check('approvers', () => {
        if (!c.approvers.length) throw new Error('empty: no approval will count (foreman whoami prints your id)');
        if (c.approvers.some((a) => a.startsWith('<'))) throw new Error('still the example placeholder (foreman whoami prints your id)');
        return `${c.approvers.length}`;
      });
      await check('jira', async () => {
        const me = await jiraClient(c).myself();
        return `signed in as ${me.displayName}`;
      });
      await check('gh', () =>
        execFileSync('gh', ['auth', 'status', '--active'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
          .split('\n')
          .find((l) => l.includes('Logged in'))
          ?.trim(),
      );
      await check('claude', () => execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim());
      await check('sdlc plugin', () => {
        if (!existsSync(join(PLUGIN_DIR, '.claude-plugin', 'plugin.json'))) throw new Error(`${PLUGIN_DIR} is not the sdlc plugin`);
        return PLUGIN_DIR;
      });
      for (const [project, repo] of Object.entries(c.repos)) {
        await check(`repo ${project}`, () => {
          if (!existsSync(join(repo.path, '.git'))) throw new Error(`${repo.path} is not a git checkout`);
          if (!existsSync(join(repo.path, 'VERIFY.md'))) throw new Error(`${repo.path} has no VERIFY.md; set it up with /sdlc:verify first`);
          return `${repo.path} → ${repo.github}`;
        });
      }
      console.log(agentInfo());
      return;
    }
    default:
      console.log(USAGE);
      if (cmd && cmd !== 'help' && cmd !== '--help') process.exitCode = 1;
  }
};

main().catch((e) => {
  // A plain Error is one this code threw with a message meant for people; anything else is a bug, and its stack helps.
  j.write(`✖ ${e instanceof Error && e.constructor !== Error ? e.stack : (e as Error).message}`);
  console.error(`${stamp()} ✖ ${(e as Error).message}`);
  process.exitCode = 1;
});
