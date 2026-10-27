# Rules for this repo

This repo is the sdlc plugin: skills, the scripts they run, and the tests for both. The layout is in [README.md](README.md#layout). These rules hold for every change, by a person or an agent.

## Skills are prose; anything that runs is a script

A skill holds the method: instructions, honesty rules, claims and evidence rules, templates. It embeds no logic. Anything that runs (parsing, launching, scanning, building a page) is a script in the skill's own folder, `plugins/<plugin>/skills/<skill>/scripts/`, with tests under `tests/<plugin>/skills/<skill>/`. A skill calls it by path, as `node <skill dir>/scripts/<file>.mts`. The plugin has no `runtime` folder.

A script imports only Node's standard library and other files of its skill, and runs on Node 24 with no install and no build step. Development tooling (Yarn, Vitest, oxlint, oxfmt) stays at the repo root.

Tests, fixtures and evals never go inside `plugins/`, so an install never carries them. `yarn check:repo` fails when they do.

## The same wherever it runs

A skill's inputs, outputs and project files (`VERIFY.md`, `FEEDBACK.md`, `PROTOTYPE.md`) are the same whatever runner invokes it: a person in a local session, an orchestrator, or a platform. Only the runner differs. A change that needs a runner to behave differently changes the runner, not the skill's contract.

A skill names no runner, workspace provider, operating system or proxy. It states what it needs from whoever runs it; each runner keeps that in its own way and documents how. `foreman/` is the local runner: it lives outside the plugin, may use any tool its machine has, and never ships in an install.

## Nothing specific to one company or project

The repo is public and generic. It holds no internal hostnames, vault or secret names, company, team or project names, ticket keys, or local paths, in skills, examples, tests or specs. Use placeholders (`example.com`, `<vault>`) and invented examples instead.

Such material goes where it belongs instead:
- a project's own repo, in its project files (its `VERIFY.md`, `FEEDBACK.md`, `PROTOTYPE.md`);
- an org's private plugin, added as a second marketplace beside this one.

## Before you finish a change

Run `yarn check:repo`, `yarn lint`, `yarn format:check` and `yarn test`. CI runs the same, the tests on macOS and Linux.
