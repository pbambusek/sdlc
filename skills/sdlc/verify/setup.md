# Set a project up for verification

A project is ready when its root has a `VERIFY.md` that tells the launcher how to prepare a run and tells the verifier how to run and drive the system. Write it from [assets/verify-template.md](assets/verify-template.md). Every value in it must come from the project's source or from a command you ran: a guessed port or flag sends the verifier the wrong way, and it can't ask.

## Which files

- **The repo root's `VERIFY.md`** is required. It covers the whole system: how to install, start, wait for and stop it, and its shared configuration. Only it has the frontmatter.
- **A package's own `VERIFY.md`**, beside its code, when the package has rules of its own: its own surface, identity, seams or pitfalls. Link each one from the root file's Packages section. A package that adds nothing keeps no file.
- A project with one system and few surfaces keeps everything in the root file.

## Steps

1. **Find how it runs.** Read the README, the package scripts, and whatever starts the system (an orchestrator such as Aspire or Docker Compose, a dev server). Note the project's own commands to start it detached, wait until it is healthy, and stop it. Use those commands, never a hand-written polling loop: when the project has no wait command, say what to poll in Surface.
2. **Prepare a run without a session.** Write the frontmatter, commit it on a branch, and run the launcher with `--prepare-only` and any claims file. Then, in the prepared folder, start the system with the commands from step 1. Every path it fails to write to belongs under `writable`; every gitignored file it misses belongs under `copy` or the `install` command. Repeat until it starts.
3. **Write the sections.** For the root and for each package with rules of its own, fill the six sections: Surface, Identity & flags, Seams, Observability, Healthy baseline, Pitfalls. Drive each surface once in the prepared folder, and write down what you saw.
4. **List what can't be verified yet.** A part with no local surface, or one that needs a secret or a login the run can't have, goes under Not yet verifiable with what blocks it. A claim that reaches it is blocked, with that reason.
5. **Gitignore `.verify/`** in the repo: it holds every run's page and evidence.
6. **Stop** what you started, and delete the prepared folder (`chmod -R -P u+w <folder> && rm -rf <folder>`).

Done when a prepared run starts the system and reaches its healthy baseline with only the commands in `VERIFY.md`.
