---
name: verify
description: Independent runtime verification. A fresh Claude Code session that knows nothing of how the code was written runs one commit of a project, drives it at its real boundaries (browser, HTTP, CLI, a channel), and collects evidence for stated claims into one evidence page. Use when asked to verify a change, a claim, a spec or a ticket's acceptance criteria, to produce evidence that something works, or to set a project up for verification (write its VERIFY.md files).
---

# Verify claims at runtime

A verifier that knows how the code was written checks what it expects, not what the system does. So verification always runs in a separate session that sees one exported commit and nothing else: no git history, no transcripts, no memory. Passing tests are never evidence; evidence is what the running system does at a boundary a user or caller meets.

When the repo has no `VERIFY.md` at its root, set the project up with [setup.md](setup.md) before anything else: setup needs no claims, so don't ask for them first. Say so in one line as you start ("No VERIFY.md here, setting the project up first."), so the user can stop you. Then launch a run.

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
4. **Report** what the launcher printed last: the page path, the counts of shown, not-shown and blocked claims, and each claim that is not shown with its reason. When it says the audit failed, say the page is invalid.

The page and its evidence land in `<repo>/.verify/<slug>/<timestamp>-<commit>/`, which the project gitignores, with the verified commit under `target` in `evidence.json`, and the page opens (`VERIFY_NO_OPEN=1` keeps it closed). Sharing it is the caller's decision.
