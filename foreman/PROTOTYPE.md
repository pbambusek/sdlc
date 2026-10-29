# Prototype: foreman dashboard

The facts about the dashboard that the prototype skill reads. Update this file in the change that alters any of them.

## Host

`bin/foreman serve` serves it at `http://127.0.0.1:4519/` (`serve.port` in the config), from `src/server.mts`: the Now page at `/` and the History page at `/history`, both from `src/dashboard.mts`. Each page renders from `~/.sdlc/last-tick.json`, the archive and the journal on every request, so a capture shows the last saved tick; `bin/foreman tick` saves one, a dry run does not.

## Access

No sign-in; it answers only on 127.0.0.1. Both pages have a 60 s `<meta http-equiv="refresh">`; a capture taken right after loading is unaffected.

## Look

All values are CSS custom properties on `:root` in `STYLE` in `src/dashboard.mts`. Two themes, following the OS: light on `:root`, dark under `@media (prefers-color-scheme: dark)`. There is no switch in the page.

- Light: `--bg #fff`, `--fg #1a1a1a`, `--muted #6b6b6b`, `--line #e4e4e4`, `--warn #b42318`, `--ok #067647`.
- Dark: `--bg #161616`, `--fg #ececec`, `--muted #9a9a9a`, `--line #2e2e2e`, `--warn #f97066`, `--ok #47cd89`.
- Body 14px/1.5, margin 24px 16px. `h1` 18px. Table cells 8px padding with a 1px `--line` bottom border, header text `--muted` at weight 500. Tiles: 1px `--line` border, 8px radius, 8px 12px padding, value 20px tabular numbers, label 12px `--muted`.

## Fonts

The system stack `-apple-system, system-ui, sans-serif`. No web font to load.

## Icons

None. State is shown by colour: a Needs you card's left border and state (`--warn` to unblock, `--amber` waiting for input, `--ok` ready for review), and the run chips.

## Shell

A top bar (`h1`, Now and History tabs, the tick's health), the totals tiles, then sections. At 390 px tables stack each row and drop the run chips.

## Pitfalls

- A last tick saved by an older foreman lacks `totals`, and the tiles are left out. Run `bin/foreman tick` first.
