---
name: verify
description: Independent runtime verification. A fresh, isolated Claude Code session runs one commit of a project, drives it at its real boundaries (browser, HTTP, CLI, a channel), and collects evidence for stated claims into one evidence page. Use when asked to verify a change, a claim, a spec or a ticket's acceptance criteria, to produce evidence that something works, or to set a project up for verification (write its VERIFY.md files).
---

# Verify claims at runtime

A verifier that knows how the code was written checks what it expects, not what the system does. So verification always runs in a separate session that sees one exported commit and nothing else: no git history, no transcripts, no memory. Passing tests are never evidence; evidence is what the running system does at a boundary a user or caller meets.

Pick the entry point by where you are:

- **`.verify/run/target.json` exists in the working directory:** you are the verifier. Follow [run.md](run.md), and nothing else in this file.
- **The repo has no `VERIFY.md` at its root:** set the project up with [setup.md](setup.md).
- **Otherwise:** launch a run, as below.

## Launch a run

The session that asks for verification may be the one that wrote the code. It hands the launcher the target and the claims source in the user's words, and nothing of its own. A project's own rules can be stricter, for example that only its owner starts a run: follow them.

1. **Claims source.** Take it from the request, unchanged:
   - A spec in the repo: its path. The launcher reads it at the target commit.
   - Sentences the user wrote: write them unchanged to a file in a temporary folder.
   - A ticket: its title, description and acceptance criteria, copied unchanged into a file, with `--source <ticket URL>`. Leave out its comments: they narrate the work.
   - Never a PR description, a commit message or your own summary: they say what was done, written by whoever did it. Follow the ticket a PR links instead.

   When the request holds no source, ask for one sentence of what should be true. Never write claims yourself.
2. **Target.** A branch, tag or commit; the current branch when none is named. The launcher exports a commit, so uncommitted changes are not verified: say so when the working tree has any.
3. **Launch** from inside the repo. A run takes minutes, so run it in the background:

   ```bash
   node <skill dir>/scripts/launch.mts <spec path> [ref]
   node <skill dir>/scripts/launch.mts --claims <file> [--source <label>] [ref]   # options: --slug <name>
   ```

   `<skill dir>` is this skill's base directory. When a claim needs a person to act during the run (send a message from their phone), give the user the command to run in their own terminal instead, where they see the `ACTION NEEDED` lines as they come; `--interactive` there opens a normal session they can talk to.
4. **Report** what the launcher printed last: the page path, the counts of shown, not-shown and blocked claims, and each claim that is not shown with its reason. When it says the isolation audit failed, say the page is invalid.

The page and its evidence land in `<repo>/.verify/<slug>/<timestamp>-<commit>/`, which the project gitignores. Sharing the page is the caller's decision.
