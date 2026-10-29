# foreman

The local runner for the `sdlc` skills: it moves each issue through the loop, and is verify's runner on this machine. Each tick reads every Jira issue labelled `sdlc`, works out from Jira and GitHub what should happen next, and launches it: a build or a feedback run as a background Claude Code session, a verify run with its own launcher (below), a code review by the repo's own reviewer. It holds no state of its own: the ledger is Jira and GitHub, so a tick can run by hand, from launchd, or twice in a row, and do the right thing.

What it assumes from people and stages is in [CONTRACT.md](CONTRACT.md). The skills know nothing of Jira or of the tick: the tick hands each one references and translates what comes back.

```
                               ┌─ verify ─┐
approved ─► build ─► PR head ─►├─ CI ─────┤─► all finished ─► feedback ─► clean ─► ready for review (a person merges)
              ▲                └─ review ─┘                       │
              └───────────────────────── fix ─────────────────────┘   blocked, a build's question, or too many rounds ─► parked (a person continues)
```

A round is one PR head: verify, CI and the review all run on it, and the build gets one feedback about all of them, never a part.

## Setup

Needs Node 24, `gh` signed in, Claude Code, [Lima](https://lima-vm.io) and [nono](https://nono.sh) for verify runs, and a repo set up for verify (a `VERIFY.md`). Run it from a checkout of this repo: every stage uses the skills in its `plugins/sdlc/` (`--plugin-dir`), never an installed copy, so foreman and the skills it runs always come from one commit. A repo's `FEEDBACK.md` says how to read its checks; without one, the feedback skill's defaults apply. A repo's `review` in the config says how to ask its reviewer for a review of each head (a trigger label, a reviewer, and the check run the review posts); without it, a round has no review.

1. Config: `mkdir -p ~/.sdlc && cp config.example.json ~/.sdlc/config.json`, then fill it in. `repos` maps a Jira project key to its checkout and GitHub repo; the build names branches by the repo's own rule.
2. Jira API token ([create one](https://id.atlassian.com/manage-profile/security/api-tokens)): copy it, then run `bin/foreman set-token`. It stores the clipboard in your keychain, clears the clipboard, and checks that Jira accepts it. Don't use `security add-generic-password -w` on its own: its hidden prompt cuts input at 128 characters, and Atlassian tokens are longer. `JIRA_API_TOKEN` in the environment works too.
3. `bin/foreman whoami` prints your Jira account id; put the approvers' ids in `approvers`.
4. `bin/foreman doctor` checks all of it.
5. GitHub: the tick puts an `sdlc` label on each build's PR, and creates the label in the repo if it isn't there.

## Use

```
bin/foreman tick --dry-run       what a tick would do, doing nothing
bin/foreman tick                 one tick
bin/foreman tick --only PROJ-67  one issue (not saved as the last tick)
bin/foreman serve                the dashboard, on this machine only; opens it and prints its address
bin/foreman status               the last tick, the launchd agent's state, the dashboard's address and the log
bin/foreman status --live        observe now, act on nothing
bin/foreman stats                tokens, cost, time and rounds per feature, from the archive (--since 7d, --json)
bin/foreman stats PROJ-67        the same for each of the issue's runs
bin/foreman log -f               follow the journal: every tick, action and error
bin/foreman log PROJ-67 -f       follow the issue's running (or latest) verify, one line per step
```

Builds show up in `claude agents` as `sdlc:build <KEY> #<n>`; `claude attach <id>` opens one. A session waiting for permission shows as `build waiting for input` in the status. Each build runs in its own detached worktree under `~/.sdlc/work/`, which the tick removes once the build has ended.

A verify run is foreman's launcher, a detached process running a headless session, so it is not in `claude agents`. Its launcher log (`~/.sdlc/runs/<KEY>/…-verify.log`) shows each step as it happens, and `foreman log <KEY> -f` follows it. The log names the verifier's session; after the run, `claude --resume <id>` in the run folder opens it.

## The dashboard

`foreman serve` runs the dashboard at `http://127.0.0.1:<serve.port>/` (4519 by default), on the loopback only, so another machine can't reach it. It opens it in the browser and prints its address; `foreman status` prints it too while it runs. It only shows: each page renders from `~/.sdlc/last-tick.json`, which every saved tick writes, the archive and the journal, and reloads itself each minute. A dry run or `--only` tick does not save it.

- **Now**: the tick's health (when it last ran, launchd's state and last exit code, errors in the last 24 h, and a banner when no tick has run for two intervals); spend, agent time and tasks run by stage since tracking began; **Needs you**, a card per issue waiting on a person (parked, a session waiting for permission, an invalid approval, no repo, a closed PR, ready for review) with only the facts foreman holds and what to do; what is running, with how long; and the rest in flight, each with its rounds from the ledger, such as `B1 ✓ → V ✗ failed → F ↻ fix → B2 ✓`.
- **History**: issues that have ended or left the JQL, with how they ended, their rounds, agent time and cost; the activity from the journal, with ticks that did nothing folded into one line; spend per day for the last 14 days.

## Verify runs

`src/verify/launch.mts` is the verify skill's runner on this machine; the tick starts it for each round, and `bin/foreman verify` starts one by hand:

```
bin/foreman verify <spec path> [ref]
bin/foreman verify --claims <file> [--source <label>] [ref]   options: --copy <path>, --slug <name>, --out <folder>, --model <id>, --interactive
bin/foreman verify --export-only [ref]                        setup: a workspace like a run's, and how to open a shell in it
```

It keeps the skill's guarantees this way:

- **Workspace.** Every command runs in a Linux VM made for the run (Lima), cloned from a template baked once per recipe. The VM holds the exported commit on its own disk and shares with the host only the run's `.verify/` folder and, read-only, the plugin's folder, the runner's folder and the caches the recipe declares. It has Docker of its own. Claude Code's Bash tool reaches it through `workspace-shell.mts` (`CLAUDE_CODE_SHELL_PREFIX`), which logs each command. The VM is deleted when the run ends, with everything it started.
- **The verifier** stays on the host with its own login and transcript, loads nothing of the owner's setup (`--safe-mode`, `--restricted`, no MCP), and has `Bash` and `Read` on images only; anything else is refused without asking. Its model is `--model`, else `verify.model` in the config, else Claude Code's default; the tick passes `verify.model` too.
- **Credentials** are read from the declared Key Vault with the Azure CLI's cached login, never with a prompt. nono's proxy holds the values on the host; the VM gets placeholders and reaches the proxy at `host.lima.internal`. Each credentialed request is logged in `credential-requests.jsonl`.
- **Audit.** After the session, `audit.mts` scans its transcript for a reach for how the code was written (git history, `gh`, the tracker, a connector) and lists the exported files the run changed. Its verdict, the workspace line and the credential line go in `audit.json`.
- **Left open:** the VM reaches every service on the host's loopback, not only the proxy, and the web: a public repository's pull request can be fetched. The audit catches an attempt.

**Recipe.** The template comes from the first ```json block in the `## Workspace` section of the root `VERIFY.md` on the default branch: `provision` (a shell script, as a string or a list of lines, run once when the template is baked), `caches` (host folders a run reads through a layer of its own, each `{ "host", "guest", "env" }`: the host folder, where the VM sees it, and the variables that point the tool at it), and `cpus`, `memory` and `disk` (defaults 4, 8 GiB and 60 GiB). It starts from Lima's Ubuntu with Docker, and Node for the workspace server. It trusts the host's extra roots: of the System keychain (macOS) or `/usr/local/share/ca-certificates` (Linux), only the unexpired certificates marked as a CA, since one malformed device identity there stops workerd from loading the VM's whole bundle. A cache is only a tool's downloaded packages: one that is or holds the home folder, the source repo or Claude Code's config stops the launch. The first launch with a new recipe bakes it, which takes minutes; later ones clone it in seconds.

`--export-only` exports the commit, copies each `--copy` file, bakes the template when it is new, and moves the export into a fresh VM. It prints `limactl shell …` for a shell in it and `limactl delete -f …` for when you are done. Run folders live under `~/.sdlc-verify/`; a run that produces a page removes its own, and a broken run keeps its `.verify/` for inspection.

## Usage and cost

Each archived run carries a usage summary read from its transcript and its subagents' transcripts: tokens (input, output, cache reads and writes) by model, API responses, tool calls by tool, subagents, and wall-clock time. A verify run also records its launcher's exit code and run time from the journal. Claude Code writes one transcript line per content block, each repeating the response's usage, so a response is counted once, by message id.

Cost is at list price, from the table in `src/usage.mts`. `prices` in the config overrides it per model, in dollars per million tokens: `{"claude-opus-5-5": {"input": 4, "output": 20, "cacheRead": 0.2, "cacheWrite5m": 5, "cacheWrite1h": 8}}`. A model with no price is left out of the dollars and named under the stats. What an Enterprise plan bills is not list price, so read the dollars as relative. Runs archived before usage was recorded are read from their archived transcript, without their subagents.

## The journal

`~/.sdlc/sdlc.log` is one append-only log of everything: every tick, from launchd or by hand, dry runs and `--only` included; every action, deferral and error, with the full message; every fatal error of any command; and every verify launcher's exit code, written when it exits. Each line is `<time> [<command> <run id> <launchd|manual>] <text>`, so `grep 'tick 5717aa'` gives one run and `grep PROJ-67` one issue's history. Nothing reads it to decide anything, and nothing rotates it.

## Run it every 5 minutes

```
bin/foreman install    load a LaunchAgent: tick at load and every 300 s (--every <s> to change)
bin/foreman kick       tick now, through launchd
bin/foreman status     shows "launchd: com.sdlc.foreman loaded; state = …; runs = …; last exit code = …"
bin/foreman log -f     every tick's output, in the journal
bin/foreman uninstall  stop and remove it
```

The agent is `~/Library/LaunchAgents/com.sdlc.foreman.plist`. A tick writes the journal itself; launchd's own stderr goes to `~/.sdlc/launchd-stderr.log`, which holds only what never reached the journal, such as `node` not starting. An agent installed before the journal wrote `~/.sdlc/tick.log`: run `install` again. It runs as you while you are logged in; a tick missed during sleep runs once on wake. The plist carries a PATH with the directories of `node`, `claude`, `gh` and `git` as they were at install: run `install` again after moving any of them. macOS lists it under System Settings → General → Login Items & Extensions.

## Local files

`~/.sdlc/` holds the config, the journal, the tick's lock, the last tick, the dashboard's address (`serve.json`), and:

- `work/`: the worktrees of running builds.
- `runs/<KEY>/`: the spec snapshot of each approval, each build's result file (read once, when the build ends), and each verify run's launcher log.
- `features.json`: each feature a saved tick has seen, as it last saw it, for the history page.
- `archive/<KEY>/`: per feature, `manifest.jsonl` (one line per stage run, with its usage), the transcript of every build and verifier session with its subagents' transcripts, and every verify run's folder, which the launcher writes there and a fix build reads as its report. Claude Code deletes transcripts after `cleanupPeriodDays`; this copy keeps them. Transcripts can hold secrets: the archive stays on this machine.

Deleting `~/.sdlc/` (except the config) while nothing runs loses history and the reports for the next fix builds, never a decision: the ledger is Jira and GitHub.

## Develop

```
yarn test                   from the repo root (Vitest): the table, the ledger format, ADF conversion, result classification, usage counting, the dashboard
```

`src/decide.mts` is the table: pure, observed facts in, one decision out. Everything else observes (`tick.mts` → `jira.mts`, `github.mts`, `sessions.mts`, `evidence.mts`), acts, or shows (`server.mts`, `dashboard.mts`).
