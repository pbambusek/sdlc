---
name: verify
description: Independent runtime verification. A fresh Claude Code session that knows nothing of how the code was written runs one commit of a project, drives it at its real boundaries (browser, HTTP, CLI, a channel), and collects evidence for stated claims into one evidence page. Use when asked to verify a change, a claim, a spec or a ticket's acceptance criteria, to produce evidence that something works, or to set a project up for verification (write its VERIFY.md files).
---

# Verify claims at runtime

A verifier that knows how the code was written checks what it expects, not what the system does. So verification always runs in a separate session that sees one exported commit and nothing else: no git history, no transcripts, no memory. Passing tests are never evidence; evidence is what the running system does at a boundary a user or caller meets.

When the repo has no `VERIFY.md` at its root, set the project up with [setup.md](setup.md) before anything else: setup needs no claims, so don't ask for them first. Say so in one line as you start ("No VERIFY.md here, setting the project up first."), so the user can stop you. A run follows the `VERIFY.md` files on the default branch, so the setup goes there in its own pull request before the first run.

## Launch a run

The session that asks for verification may be the one that wrote the code. It hands the launcher the target and the claims source in the user's words, and nothing of its own. A project's own rules can be stricter, for example that only its owner starts a run: follow them.

1. **Claims source.** Take it from the request, unchanged:
   - A spec in the repo: its path. The launcher reads it at the target commit.
   - Sentences the user wrote: write them unchanged to a file in a temporary folder.
   - A ticket: its title, description and acceptance criteria, copied unchanged into a file, with `--source <ticket URL>`. Leave out its comments: they narrate the work.
   - Never a PR description, a commit message or your own summary: they say what was done, written by whoever did it. Follow the ticket a PR links instead.

   When the request holds no source, ask for one sentence of what should be true. Never write claims yourself.
2. **Target.** A branch, tag or commit; the current branch when none is named. The launcher exports a commit, so uncommitted changes are not verified: say so when the working tree has any.
3. **Launch** from inside the repo. Pass `--copy` for each gitignored file the root `VERIFY.md` says a run needs. A run takes minutes, so run it in the background:

   ```bash
   node <skill dir>/scripts/launch.mts <spec path> [ref]
   node <skill dir>/scripts/launch.mts --claims <file> [--source <label>] [ref]   # options: --copy <path>, --slug <name>
   ```

   `<skill dir>` is this skill's base directory. The launcher starts the verifier as a new process with [run.md](run.md) as its instructions, prints a line per step, and audits the session when it ends. `--interactive` opens a normal session instead, for the user to watch or debug a run in their own terminal.
4. **Report** what the launcher printed last: the page path, the counts of shown, not-shown and blocked claims, and each claim that is not shown with its reason. When it says the audit failed, say the page is invalid. When it stopped before starting the verifier, or says the workspace refused an access, there is no page: report what it printed, and that the run needs the project, its `VERIFY.md` or the machine fixed first.

## What a run follows

A run executes the commit's own code, so it doesn't take its instructions from that commit too. It follows the project's `VERIFY.md` files as they are on the remote's default branch when it launches, which the launcher fetches. When the commit changes any of them, the launcher names each one and runs with the default branch's version: a change to `VERIFY.md` goes to the default branch in its own pull request first. When the default branch has no `VERIFY.md` at its root, or can't be read, no run starts.

## The workspace

Every command a run executes, the commit's own code included, runs in a confined workspace: it reads and writes the run's folder and temp, with a home of its own inside the folder, and reads the skill folder and the toolchains a build needs, linked read-only. The source repo, every Claude Code session's transcripts and memory, and the owner's keys and logins are not there for it. The verifier itself stays outside, with its own login and transcript, and loads nothing of the owner's Claude Code setup: its only tools are a command in the workspace and viewing an image the workspace saved, and any other tool is refused without asking. Every command is logged with its exit status in the page's `commands.jsonl`.

On the owner's machine the workspace is nono's sandbox (Seatbelt on macOS, Landlock on Linux; `brew install nono`). Without it, no run starts. Run folders live under `~/.sdlc-verify/`; a run that produces a page removes its own, and a broken run keeps it for inspection. HTTPS endpoints in the run (an Aspire dashboard, any ASP.NET app) get a localhost certificate made for the run, because the developer certificate lives in the macOS keychain. Playwright's own Chromium must be installed once (`playwright-cli install-browser chromium`): an installed Chrome can't start in the workspace. Whatever the run left running, its processes and the containers it started, is stopped when it ends. One way out remains: a run may use the owner's Docker, and a container it starts can mount any folder Docker shares from the host.

A run the workspace refused anything is broken: the launcher prints each refused path, exits non-zero and writes no page. The refusals come from each command's output and from the workspace's own report.

## Credentials

When the root `VERIFY.md` declares credentials, the launcher reads them with the Azure CLI's cached login and never prompts. A declared credential that can't be read stops the launch, named with the reason, for a person to fix. nono's proxy holds the values outside the workspace, which gets placeholders; the page lists every request that used one.

The page and its evidence land in `<repo>/.verify/<slug>/<timestamp>-<commit>/`, which the project gitignores, with the verified commit under `target` in `evidence.json`, and the page opens (`VERIFY_NO_OPEN=1` keeps it closed). Sharing it is the caller's decision.
