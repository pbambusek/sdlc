# sdlc-skills

Personal Claude Code skills for the software delivery lifecycle.

## Layout

- `skills/<name>/SKILL.md` — one directory per skill; supporting files sit beside `SKILL.md` and are referenced relatively.
- `link.sh` — symlinks each skill into `~/.claude/skills/`.

## Skills

- `feature-spec` — a one-page issue stating intent and numbered, verifiable claims, leaving the solution to the builder.
- `verify` — independent runtime verification: a fresh, isolated session runs one commit, drives it at its boundaries, and proves each claim on one evidence page. A project describes how to run it in `VERIFY.md` files.

## Install

```sh
./link.sh
```

Each skill becomes `~/.claude/skills/<name> -> <repo>/skills/<name>`, so edits here are live in Claude Code with no copy step. Re-run after adding a skill. `CLAUDE_SKILLS_DIR` overrides the destination.

## Adding a skill

1. Create `skills/<name>/SKILL.md` with `name` and `description` frontmatter; `name` must match the directory.
2. Run `./link.sh`.
3. Add it to the list above and commit.
