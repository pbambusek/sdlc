## What and why

## Checklist

- [ ] Each changed skill's `name` matches its folder, and its `description` says when to use it.
- [ ] Logic a skill runs is in a script in the skill's folder, with tests under `tests/`; the skill stays prose.
- [ ] No project-, company- or person-specific content in skills, examples, tests or specs.
- [ ] `yarn check:repo`, `yarn lint`, `yarn format:check` and `yarn test` pass.
- [ ] Tried in Claude Code (`claude --plugin-dir ./plugins/<plugin>`).
