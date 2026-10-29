---
name: verify
description: Independent runtime verification. A fresh verifier session that knows nothing of how the code was written runs one commit of a project, drives it at its real boundaries (browser, HTTP, CLI, a channel), and collects evidence for stated claims into one evidence page. Use when asked to verify a change, a claim, a spec or a ticket's acceptance criteria, to produce evidence that something works, or to set a project up for verification (write its VERIFY.md files).
---

# Verify claims at runtime

A verifier that knows how the code was written checks what it expects, not what the system does. So verification always runs in a separate session that sees one exported commit and nothing else: no git history, no transcripts, no memory. Passing tests are never evidence; evidence is what the running system does at a boundary a user or caller meets.

When the repo has no `VERIFY.md` at its root, set the project up with [setup.md](setup.md) before anything else: setup needs no claims, so don't ask for them first. Say so in one line as you start ("No VERIFY.md here, setting the project up first."), so the user can stop you. A run follows the `VERIFY.md` files on the default branch, so the setup goes there in its own pull request before the first run.

## Start a run

A runner starts every run: it makes the run's workspace, starts the verifier with [run.md](run.md) as its instructions, and hands back the run folder. This skill doesn't start one itself, and works the same whichever runner does. Use the runner the user names or the environment provides; when there is none, say a run needs one and stop.

The session that asks for verification may be the one that wrote the code. It hands the runner the target and the claims source in the user's words, and nothing of its own. A project's own rules can be stricter, for example that only its owner starts a run: follow them.

1. **Claims source.** Take it from the request, unchanged:
   - A spec in the repo: its path. The runner reads it at the target commit.
   - Sentences the user wrote: write them unchanged to a file in a temporary folder.
   - A ticket: its title, description and acceptance criteria, copied unchanged into a file, with the ticket's URL as the source. Leave out its comments: they narrate the work.
   - Never a PR description, a commit message or your own summary: they say what was done, written by whoever did it. Follow the ticket a PR links instead.

   When the request holds no source, ask for one sentence of what should be true. Never write claims yourself.
2. **Target.** A branch, tag or commit; the current branch when none is named. A run verifies a commit, so uncommitted changes are not verified: say so when the working tree has any.
3. **Start** the run with the runner, with each gitignored file the root `VERIFY.md` says a run needs. A run takes minutes, so run it in the background.
4. **Report** what the runner returned: the page path, the counts of shown, not-shown and blocked claims, and each claim that is not shown with its reason. When the audit flagged tool calls, name them: a person judges whether the evidence still counts. When it stopped before starting the verifier, there is no page: report what it said, and that the run needs the project, its `VERIFY.md` or the runner's machine fixed first.

## What a runner guarantees

Every runner keeps these, each in its own way, and states on the page how it kept them.

- **The verifier can't learn how the code was written.** Not from git history, a diff, a PR or ticket beyond the claims, any session's transcript or memory, the owner's instructions, plugins or skills, or a connector. It starts with nothing of the owner's setup, and sees the exported commit and the `VERIFY.md` files. The commit's own code may be read: it is what is under test.
- **The verifier reaches the system only through the workspace.** Every command, the commit's own code included, runs in a workspace made for this run, and is logged with its exit status in the page's `commands.jsonl`. The verifier's tools are running a command there and viewing an image it saved; any other tool is refused without asking anyone.
- **The workspace holds nothing of the owner's** beyond what the run needs: no source repo, transcripts, keys or logins. It is thrown away when the run ends, with every process and container the run started.
- **Credentials arrive without a person.** Each credential the root `VERIFY.md` declares reaches the run without a prompt, or the run doesn't start: a declared credential that can't be read is named with the reason, for a person to fix. Whether the workspace holds the value or a placeholder swapped on the declared hosts is the runner's choice, and the page says which.
- **The instructions come from the default branch.** A run executes the commit's own code, so it doesn't take its instructions from that commit too: it follows the project's `VERIFY.md` files as they are on the remote's default branch when it starts. When the commit changes any of them, the run names each one and follows the default branch's version: a change to `VERIFY.md` goes to the default branch in its own pull request first. When the default branch has no `VERIFY.md` at its root, or can't be read, no run starts.
- **The verifier's reach is checked.** The runner states what its confinement leaves open, and checks the session for any attempt to reach how the code was written: git history, a PR, a ticket, a connector. The page lists every such attempt as a warning for a person to judge; each claim keeps the status its evidence gives it.

The page and its evidence land in `<repo>/.verify/<slug>/<timestamp>-<commit>/`, which the project gitignores, with the verified commit under `target` in `evidence.json` and the runner's statements and verdict in `audit.json`. Sharing it is the caller's decision.
