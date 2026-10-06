# skills

Agent skills for Claude Code, grouped into plugins by area and published as a plugin marketplace.

## Plugins

### `sdlc` — software delivery lifecycle

- `feature-spec` — a one-page issue stating intent and numbered, verifiable claims, leaving the solution to the builder.
- `verify` — independent runtime verification: a fresh, isolated session runs one commit, drives it at its boundaries, and proves each claim on one evidence page. A project describes how to run it in `VERIFY.md` files. Experimental.

Skills are invoked as `/<plugin>:<skill>`, e.g. `/sdlc:verify`, or picked up by Claude from their descriptions.

## Install

For yourself:

```
/plugin marketplace add pbambusek/skills
/plugin install sdlc@pbambusek
```

For everyone working in a repository, commit `.claude/settings.json` there. Pin a commit with `sha` so the team gets changes only when the pin moves:

```json
{
  "extraKnownMarketplaces": {
    "pbambusek": {
      "source": { "source": "github", "repo": "pbambusek/skills", "sha": "<commit>" }
    }
  },
  "enabledPlugins": { "sdlc@pbambusek": true }
}
```

## Layout

```
.claude-plugin/marketplace.json     the marketplace: one entry per plugin
skills/<plugin>/
  .claude-plugin/plugin.json        the plugin; its own folder holds its skills
  <skill>/SKILL.md                  one folder per skill, supporting files beside it
```

## Developing

Add a clone as a local marketplace; it is read in place, so edits apply on the next session or after `/reload-plugins`:

```
/plugin marketplace add ./path/to/skills
/plugin install sdlc@pbambusek
```

To try a single plugin without installing it: `claude --plugin-dir ./skills/sdlc`.

Adding a skill: create `skills/<plugin>/<skill>/SKILL.md` with `name` and `description` frontmatter, where `name` matches the folder, and list it above. Adding a plugin: create `skills/<plugin>/.claude-plugin/plugin.json` with `"skills": ["./"]` and add an entry to `marketplace.json`. Supporting files are referenced relative to the skill's folder.

## License

[Apache-2.0](LICENSE)
