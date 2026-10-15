# Set a project up for verification

A project is ready when its root has a `VERIFY.md` that tells the verifier how to install, start, drive and stop the system. Write it from [assets/verify-template.md](assets/verify-template.md). Every value in it must come from the project's source or from a command you ran: a guessed port or flag sends the verifier the wrong way, and it can't ask.

## Which files

- **The repo root's `VERIFY.md`** is required. It covers the whole system: how to install, start, wait for and stop it, and its shared configuration.
- **A package's own `VERIFY.md`**, beside its code, when the package has rules of its own: its own surface, identity, seams or pitfalls. Link each one from the root file's Packages section. A package that adds nothing keeps no file.
- A project with one system and few surfaces keeps everything in the root file.

## Steps

1. **Find how it runs.** Read the README, the package scripts, and whatever starts the system (an orchestrator such as Aspire or Docker Compose, a dev server). Note the project's own commands to install, start it detached, wait until it is healthy, and stop it. Use those commands, never a hand-written polling loop: when the project has no wait command, say what to poll in Surface.
2. **Try it in an export.** Run `node <runtime dir>/launch.mts --export-only`: it exports the current commit, copies each `--copy` file, and prints the folder. In that folder, install and start the system with the commands from step 1. Every gitignored file it misses (an `.env` that holds only secret references) goes in Surface as a file to copy, and you export again with `--copy` for it. Repeat until it starts.
3. **Write the sections.** For the root and for each package with rules of its own, fill the six sections: Surface, Identity & flags, Seams, Observability, Healthy baseline, Pitfalls. Drive each surface once in the export, and write down what you saw. When the port is configurable, say how to pick a free one.
4. **Replace people with seams.** A claim that needs a person to act (send a message from their phone) is blocked. Where the project has a way to act without one (a test endpoint that injects the inbound message, a fake channel), describe it under Seams.
5. **Declare the credentials a run may use.** A real service a claim needs (a model gateway, Slack) gets a credential in a `## Credentials` section. It's a ```json block with the Key Vault (`vault`) and, for each credential:
   - the variable the system reads (`name`);
   - its secret in that vault (`secret`);
   - the exact hosts it may be sent to (`hosts`);
   - how it is sent: `header` (default `Authorization`) and `format` (default `Bearer {}`), or `"basic": true` for HTTP basic auth with a `user:password` value.

   Mark a calibration credential whose value is not secret `"known": true`. The run holds a per-run token in the variable, and nono's proxy puts the real value on every request to those hosts. The vault holds keys used on behalf of code you don't trust, never an app's own. Whoever launches a run needs nono and `az login` with read access to the vault; a run with nothing declared needs neither.
6. **List what can't be verified yet.** A part with no local surface, or one that needs a secret or a login the run can't have, goes under Not yet verifiable with what blocks it. A claim that reaches it is blocked, with that reason.
7. **Gitignore `.verify/`** in the repo: it holds every run's page and evidence.
8. **Stop** what you started. The export stays in the system's temp folder.

Done when an export starts the system and reaches its healthy baseline with only the commands in `VERIFY.md`.
