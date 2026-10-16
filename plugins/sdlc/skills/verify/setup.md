# Set a project up for verification

A project is ready when its root has a `VERIFY.md` that tells the verifier how to install, start, drive and stop the system. Write it from [assets/verify-template.md](assets/verify-template.md). Every value in it must come from the project's source or from a command you ran: a guessed port or flag sends the verifier the wrong way, and it can't ask.

## Which files

- **The repo root's `VERIFY.md`** is required. It covers the whole system: how to install, start, wait for and stop it, and its shared configuration.
- **A package's own `VERIFY.md`**, beside its code, when the package has rules of its own: its own surface, identity, seams or pitfalls. Link each one from the root file's Packages section. A package that adds nothing keeps no file.
- A project with one system and few surfaces keeps everything in the root file.

## Steps

1. **Find how it runs.** Read the README, the package scripts, and whatever starts the system (an orchestrator such as Aspire or Docker Compose, a dev server). Note the project's own commands to install, start it detached, wait until it is healthy, and stop it. Use those commands, never a hand-written polling loop: when the project has no wait command, say what to poll in Surface.
2. **Say what the workspace installs.** A run's VM starts from Lima's Ubuntu with Docker and Node. Write what else the project needs in a `## Workspace` section: a ```json block with `provision` (a shell script, as a string or a list of lines, run once when the template is baked), `caches` (host folders a run reads read-only, each `{ "host", "guest", "env" }`: the host folder, where the VM sees it, and the variables that point the tool at it), and `cpus`, `memory` and `disk` (defaults 4, 8 GiB and 60 GiB). Install toolchains at the versions the project pins. A cache is only for a tool's downloaded packages, such as Yarn's global cache, and never a folder that holds the home folder, the repo or Claude Code's config.
3. **Try it in an export.** Run `node <runtime dir>/launch.mts --export-only`: it exports the current commit, copies each `--copy` file, bakes the template from the commit's own `VERIFY.md` when it is new, and moves the export into a fresh VM. It prints the command that opens a shell there and the one that deletes the VM. In that shell, install and start the system with the commands from step 1. A command that needs something the VM lacks fails there, as it would in a run: add it to `provision`, or write the way around it under Pitfalls. Every gitignored file it misses (an `.env` that holds only secret references) goes in Surface as a file to copy, and you export again with `--copy` for it. Repeat until it starts, then delete the VM.
4. **Write the sections.** For the root and for each package with rules of its own, fill the six sections: Surface, Identity & flags, Seams, Observability, Healthy baseline, Pitfalls. Drive each surface once in the export, and write down what you saw. When the port is configurable, say how to pick a free one.
5. **Replace people with seams.** A claim that needs a person to act (send a message from their phone) is blocked. Where the project has a way to act without one (a test endpoint that injects the inbound message, a fake channel), describe it under Seams.
6. **Declare the credentials a run may use.** A real service a claim needs (a model gateway, Slack) gets a credential in a `## Credentials` section. It's a ```json block with the Key Vault (`vault`) and, for each credential:
   - the variable the system reads (`name`);
   - its secret in that vault (`secret`);
   - the exact hosts it may be sent to (`hosts`);
   - how it is sent: `header` (default `Authorization`) and `format` (default `Bearer {}`), or `"basic": true` for HTTP basic auth with a `user:password` value.

   Mark a calibration credential whose value is not secret `"known": true`. The run holds a per-run token in the variable, and nono's proxy puts the real value on every request to those hosts. The vault holds keys used on behalf of code you don't trust, never an app's own. Whoever launches a run needs `az login` with read access to the vault; a run with nothing declared doesn't. A declared credential that can't be read stops every launch until it is fixed.
7. **List what can't be verified yet.** A part with no local surface, or one that needs a secret or a login the run can't have, goes under Not yet verifiable with what blocks it. A claim that reaches it is blocked, with that reason.
8. **Gitignore `.verify/`** in the repo: it holds every run's page and evidence.
9. **Stop** what you started, and delete the VM with the command the export printed.
10. **Merge it first.** A run follows the `VERIFY.md` files on the remote's default branch, never the commit under test's, and refuses to start while the default branch has none. Commit the `VERIFY.md` files and the gitignore on their own and say they go to the default branch in their own pull request before the first run. A later change to them goes the same way.

Done when an export's VM starts the system and reaches its healthy baseline with only the commands in `VERIFY.md`.
