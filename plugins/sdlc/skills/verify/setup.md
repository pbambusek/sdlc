# Set a project up for verification

A project is ready when its root has a `VERIFY.md` that tells the verifier how to install, start, drive and stop the system. Write it from [assets/verify-template.md](assets/verify-template.md). Every value in it must come from the project's source or from a command you ran: a guessed port or flag sends the verifier the wrong way, and it can't ask.

## Which files

- **The repo root's `VERIFY.md`** is required. It covers the whole system: how to install, start, wait for and stop it, and its shared configuration.
- **A package's own `VERIFY.md`**, beside its code, when the package has rules of its own: its own surface, identity, seams or pitfalls. Link each one from the root file's Packages section. A package that adds nothing keeps no file.
- A project with one system and few surfaces keeps everything in the root file.

## Steps

1. **Find how it runs.** Read the README, the package scripts, and whatever starts the system (an orchestrator such as Aspire or Docker Compose, a dev server). Note the project's own commands to install, start it detached, wait until it is healthy, and stop it. Use those commands, never a hand-written polling loop: when the project has no wait command, say what to poll in Surface.
2. **Say what the workspace needs.** Write it in a `## Workspace` section, in prose: the operating system and architecture the system runs on, the toolchains and tools beyond the system's own install (at the versions the project pins), images worth fetching ahead, the memory a cold start peaks at, and any tool cache a run gains from, such as Yarn's global cache. Say how to install each, so a workspace that lacks one can add it. A runner may keep its own settings for preparing a workspace in this section, in the form its documentation gives; this skill never reads them.
3. **Try it in a workspace.** Ask the runner for a workspace like a run's, with the current commit exported into it and each gitignored file a run needs copied in; its documentation says how. In it, install and start the system with the commands from step 1. A command that needs something the workspace lacks fails there, as it would in a run: add it to `## Workspace`, or write the way around it under Pitfalls. Every gitignored file it misses (an `.env` that holds only secret references) goes in Surface as a file to copy. Repeat until it starts.
4. **Write the sections.** For the root and for each package with rules of its own, fill the six sections: Surface, Identity & flags, Seams, Observability, Healthy baseline, Pitfalls. Drive each surface once in the export, and write down what you saw. When the port is configurable, say how to pick a free one.
5. **Replace people with seams.** A claim that needs a person to act (send a message from their phone) is blocked. Where the project has a way to act without one (a test endpoint that injects the inbound message, a fake channel), describe it under Seams.
6. **Declare the credentials a run may use.** A real service a claim needs (a model gateway, Slack) gets a credential in a `## Credentials` section. It's a ```json block with the Key Vault (`vault`) and, for each credential:
   - the variable the system reads (`name`);
   - its secret in that vault (`secret`);
   - the exact hosts it may be sent to (`hosts`);
   - how it is sent: `header` (default `Authorization`) and `format` (default `Bearer {}`), or `"basic": true` for HTTP basic auth with a `user:password` value.

   Mark a calibration credential whose value is not secret `"known": true`. The runner reads each value without a prompt and hands it to the run, as the value or as a placeholder it swaps on those hosts only. The vault holds keys used on behalf of code you don't trust, never an app's own. Whoever starts a run needs `az login` with read access to the vault; a run with nothing declared doesn't. A declared credential that can't be read stops every run until it is fixed.
7. **List what can't be verified yet.** A part with no local surface, or one that needs a secret or a login the run can't have, goes under Not yet verifiable with what blocks it. A claim that reaches it is blocked, with that reason.
8. **Gitignore `.verify/`** in the repo: it holds every run's page and evidence.
9. **Stop** what you started, and close the workspace.
10. **Merge it first.** A run follows the `VERIFY.md` files on the remote's default branch, never the commit under test's, and refuses to start while the default branch has none. Commit the `VERIFY.md` files and the gitignore on their own and say they go to the default branch in their own pull request before the first run. A later change to them goes the same way.

Done when a fresh workspace starts the system and reaches its healthy baseline with only the commands in `VERIFY.md`.
