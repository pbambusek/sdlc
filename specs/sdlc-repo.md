# The repo holds the sdlc plugin's skills and its tested runtime together

> **Building this?** The claims are the acceptance criteria; how to meet them is your call. When a claim is unclear, conflicts with another, or stops fitting what you learn, ask on this issue and wait for the spec to be updated. A linked prototype shows the intended look and wording; where it and a claim differ, the claim wins.

## Intent
The repo becomes the sdlc repo. It holds the plugin's skills as prose and the TypeScript runtime they call, tested on macOS and Linux, so a skill and the code it depends on change in one commit and are pinned by one sha. Anyone installing the plugin gets the same skills as today, with no tests in the install. Anyone contributing finds the repo's rules written down.

## Context
The verify skill carries 740 lines of TypeScript (`skills/sdlc/verify/scripts/*.mts`): the launcher, the credential declaration and proxy, the leak scans, the transcript audit and the evidence page builder. None of it is tested. CI (`.github/check.mjs`) checks only that the manifests parse and that each skill has a valid `SKILL.md`. The next planned change to verify, a confined workspace with the verifier outside it and commands routed in, adds more code than everything there today. So the place for code and its tests has to exist before that change lands, or with it.

These decisions are already taken:
- One repo for skills and runtime, so they change together and the marketplace sha pins both. The runtime ships inside the plugin, uses only Node's standard library, and runs on Node 24 or later with no build step and no install, as the scripts do today. It is not published to npm.
- Development tooling lives at the repo root, outside the plugin: Yarn as the package manager, Vitest for tests, oxlint and oxfmt for lint and formatting. None of it ships in the plugin or is needed to run it.
- Skills stay prose: method, honesty rules, claims and evidence rules, templates. Anything that runs lives in the runtime and is tested there. Skills call it and embed no logic.
- Tests, fixtures and evals live outside the plugin folder, in a tree that mirrors it, so installs never carry them.
- The repo stays public, personal and generic. Org- or project-specific material lives in that org's or project's repos (a project's `VERIFY.md`), or in a private plugin added as a second marketplace.
- A skill's inputs, outputs and project files (`VERIFY.md`, `FEEDBACK.md`, `PROTOTYPE.md`) are the same whatever runs it, locally or on a platform. Only the runner differs.

The repo is renamed on GitHub. GitHub redirects the old name, so existing `/plugin marketplace add pbambusek/skills` setups and pinned shas in other repos' `.claude/settings.json` keep resolving.

Pointers (orientation, not design):
- `.claude-plugin/marketplace.json` (source `./skills/sdlc`, marketplace name `pbambusek`) and `skills/sdlc/.claude-plugin/plugin.json`.
- `.github/check.mjs` and `.github/workflows/check.yml`, which run on `ubuntu-latest` with Node 22.
- `.github/pull_request_template.md`, which already asks for no project-, company- or person-specific content and names `--plugin-dir ./skills/<plugin>`.
- Skill docs that call the scripts as `<skill dir>/scripts/…`: `verify/SKILL.md` (the launcher) and `verify/setup.md` (`--export-only`). `verify/run.md` (the page builder) runs inside the verifier's session, and reads `assets/example/evidence.json` as the evidence shape. That file is skill material, not a test fixture.
- README: Install, Layout and Developing.
- sdlc-tick, the local orchestrator, starts the launcher through its config's `verify.launcher` and documents the call in its `CONTRACT.md`.

## Claims
### Installing the plugin
1. In a fresh Claude Code session, `/plugin marketplace add pbambusek/sdlc` followed by `/plugin install sdlc@pbambusek` installs the plugin, and `/sdlc:spec`, `/sdlc:build`, `/sdlc:verify`, `/sdlc:feedback` and `/sdlc:prototype` are all available.
2. A repo whose `.claude/settings.json` adds the marketplace as `pbambusek/skills` with a sha pinned after the restructure still gets all five skills in a new session.
3. The installed plugin's folder in Claude Code's plugin cache contains no tests, fixtures or evals.
4. The README's install steps and settings example name `pbambusek/sdlc`, and the plugin id stays `sdlc@pbambusek`.

### Skills work as before
5. A verify run started as the verify skill's docs now describe, on a project with a `VERIFY.md`, ends with an evidence page and an audit verdict, as it did before the restructure.
6. A verify run on a project whose `VERIFY.md` declares credentials ends with an evidence page showing that the credentialed requests went through the proxy, as before.
7. `--export-only`, run as `verify/setup.md` describes, prints the export folder, as before.
8. Comparing the restructure with the commit before it, the Markdown of every skill differs only in the paths it uses to reach runtime code or its own files.
9. When a skill's Markdown names a file in the plugin that does not exist, CI fails and names the skill file and the missing path.

### The runtime is tested
10. From the repo root, after `yarn install`, `yarn test` runs every runtime test and exits non-zero when any test fails.
11. Every runtime behaviour a skill relies on has a test at the module's exported surface: launcher argument handling, the credential declaration and placeholder substitution, the leak scans, the transcript audit, and the page builder's schema check.
    Calibration: a test that plants a credential value in a run folder and expects the leak scan to report it counts; a test that only imports the module, or only checks that a function exists, does not.
12. A test that needs a tool the machine lacks (`claude`, `nono`, `az`) is reported as skipped and names the missing tool. It is never reported as passed.
13. On a pull request or a push to main, the runtime tests run on a macOS runner and on a Linux runner, and each appears as its own check next to the manifest check.
14. CI fails, naming the file, when runtime or test code has a lint error or is not formatted.
15. The README states Node 24 as the minimum, and CI runs the tests on Node 24.
16. When runtime code imports anything but Node's standard library or other runtime files, CI fails and names the file and the import.

### Where things live
17. The README's Layout section shows where the skills, the runtime, the tests, fixtures and evals, and the repo's specs live, and the repo's tree matches it: the plugin in `plugins/sdlc/`, its skills in `plugins/sdlc/skills/<skill>/`, its runtime in `plugins/sdlc/runtime/`, and tests mirroring the plugin under `tests/sdlc/`.
18. When a test, fixture or eval file is added inside the plugin folder, CI fails and names the file.
19. The README's Developing section and the PR template name the plugin folder's new path for `claude --plugin-dir`.

### The repo's rules are written down
20. The repo's contributing rules state that skills hold method in prose and that anything that runs belongs in the runtime with tests, and a Claude Code session opened in the repo loads them.
21. The contributing rules state that a skill's inputs, outputs and project files are the same whatever runner invokes it, locally or on a platform.
22. The contributing rules state that nothing specific to one company or project goes in the repo, and say where such material goes instead.
23. At the restructure commit, a search of the whole tree for internal hostnames, vault names, company or project names and local home paths finds none.
    Calibration: `example.com`, or `<vault>` as a placeholder in a template, counts as generic; a real vault name, or a path under a real user's home, does not.

### The orchestrator follows the move
24. sdlc-tick's example config and its default launcher path name the launcher's new location.

## Constraints
- The repo stays public, under Apache-2.0, and owned personally.
- Specs in `specs/` follow the same no-company-specifics rule as everything else, this one included. Tracker keys and internal names stay in the tracker.

## Out of scope
- Changing any skill's behaviour or method, beyond the paths it uses.
- The confined workspace for verify (verifier outside, commands routed in). It lands on this layout afterwards, as the runtime's first big addition.
- Remote runners or providers, and a hosted verify agent.
- Publishing the runtime to npm, or a CI publish-on-tag step.
- Writing evals for skills. This change only creates the place for them.
- Renaming the marketplace or the plugin.
- A shim at the old launcher path: its callers are few and still in development.
- Running a full sdlc-tick round against the new layout.

## Open questions
