# sdlc

Agent skills for the software delivery lifecycle, and the runtime they call, published as a Claude Code plugin marketplace; and [foreman](foreman/README.md), which runs them locally.

## Plugins

### `sdlc` — software delivery lifecycle

- `spec` — a one-page issue stating intent and numbered, verifiable claims, leaving the solution to the builder.
- `build` — builds a spec as pushed commits on a draft pull request, and on a later round fixes the findings fed back about its claims, from `verify` or any other source. It ends in a result file that a person or an orchestrator acts on, and knows nothing of `verify`'s format or files.
- `verify` — independent runtime verification: a fresh, isolated session runs one commit, drives it at its boundaries, and proves each claim on one evidence page. A runner starts each run in a workspace made for it, with the verifier outside; the skill states what every runner guarantees, and foreman is the local one. A project describes how to run it in `VERIFY.md` files, which a run reads from the default branch. Experimental.
- `feedback` — reads what CI, a verification run and code review found on one pushed commit, and writes it as findings for the next `build` round. It reads only and never waits: an orchestrator calls it once the signals are in. A project describes how to read its checks in a `FEEDBACK.md` file.
- `prototype` — a clickable, self-contained HTML prototype of a change to a web app's page, built on the running app's look. A project describes how to capture and reproduce its look in `PROTOTYPE.md` files.

Skills are invoked as `/<plugin>:<skill>`, e.g. `/sdlc:verify`, or picked up by Claude from their descriptions. The runtime needs Node 24 or later and nothing else: no install, no build step.

## foreman

[foreman](foreman/README.md) runs the loop on your machine: each tick reads the issues in Jira, works out the next stage from Jira and GitHub, and starts it. It is also `verify`'s local runner (`foreman verify`). It is not part of the plugin: run it from a checkout of this repo, where every stage uses that checkout's skills. Needs [Lima](https://lima-vm.io) and [nono](https://nono.sh) for verify runs.

## Install

For yourself:

```
/plugin marketplace add pbambusek/sdlc
/plugin install sdlc@pbambusek
```

For everyone working in a repository, commit `.claude/settings.json` there. Pin a commit with `sha` so the team gets changes only when the pin moves. The sha pins the skills and the runtime together:

```json
{
  "extraKnownMarketplaces": {
    "pbambusek": {
      "source": { "source": "github", "repo": "pbambusek/sdlc", "sha": "<commit>" }
    }
  },
  "enabledPlugins": { "sdlc@pbambusek": true }
}
```

The repo was called `pbambusek/skills`; GitHub redirects that name, so setups that still use it keep working.

## Layout

```
.claude-plugin/marketplace.json       the marketplace: one entry per plugin
plugins/<plugin>/                     what an install carries, and nothing else
  .claude-plugin/plugin.json          the plugin
  skills/<skill>/SKILL.md             one folder per skill: the method in prose, its templates and assets beside it
  runtime/<skill>/                    the TypeScript a skill runs; Node's standard library only
foreman/                              the local runner: the loop, and verify's runner; never installed with the plugin
tests/<plugin>/runtime/<skill>/       the runtime's tests, mirroring the plugin
tests/<plugin>/skills/<skill>/        a skill's fixtures and evals
tests/repo/                           tests of the repo's own checks
.github/                              the repo check (check.mjs) and CI: check, lint, and tests on macOS and Linux
```

The repo's rules for what goes where are in [CLAUDE.md](CLAUDE.md).

## Developing

Add a clone as a local marketplace; it is read in place, so edits apply on the next session or after `/reload-plugins`:

```
/plugin marketplace add ./path/to/sdlc
/plugin install sdlc@pbambusek
```

To try the plugin without installing it: `claude --plugin-dir ./plugins/sdlc`.

The tooling (Yarn, Vitest, oxlint, oxfmt) lives at the repo root and never ships in the plugin. With Node 24 or later and Corepack:

```
corepack enable
yarn install
yarn test             # the runtime's and the repo check's tests
yarn lint             # oxlint
yarn format           # oxfmt; format:check only checks
yarn check:repo       # manifests, skill references, no tests in the plugin, runtime imports
```

`yarn test` also runs foreman's tests: its own with `node --test`, its verify runner's with Vitest. A test that needs a tool the machine lacks (`limactl`, `nono`) is skipped, and its name says which tool.

Adding a skill: create `plugins/<plugin>/skills/<skill>/SKILL.md` with `name` and `description` frontmatter, where `name` matches the folder, and list it above. Supporting files are referenced relative to the skill's folder as `<skill dir>/…`, and its runtime code as `<runtime dir>/…`; the repo check fails when either names a file that does not exist. Adding a plugin: create `plugins/<plugin>/.claude-plugin/plugin.json` with `"skills": ["./skills/"]` and add an entry to `marketplace.json`.

## License

[Apache-2.0](LICENSE)
