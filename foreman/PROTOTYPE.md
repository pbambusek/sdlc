# Prototype: foreman status page

The facts about the status page that the prototype skill reads. Update this file in the change that alters any of them.

## Host

There is no server: every tick (`bin/foreman tick`, or launchd) rewrites `~/.sdlc/status.html` from `page()` in `src/status.mts`. To capture it, copy the file into a scratch folder and serve that folder, for example `python3 -m http.server --directory <scratch>/host 8765`, then open `http://localhost:8765/`. Don't serve `~/.sdlc/` itself: it holds the config. For a page from current code without waiting for launchd, run `bin/foreman tick --dry-run` first; it does not save, so the file is whatever the last real tick wrote.

## Access

No sign-in. The page has a 60 s `<meta http-equiv="refresh">`; a capture taken right after loading is unaffected.

## Look

All values are CSS custom properties on `:root` inside the page's own `<style>` in `src/status.mts`. Two themes, following the OS: light on `:root`, dark under `@media (prefers-color-scheme: dark)`. There is no switch in the page.

- Light: `--bg #fff`, `--fg #1a1a1a`, `--muted #6b6b6b`, `--line #e4e4e4`, `--warn #b42318`, `--ok #067647`.
- Dark: `--bg #161616`, `--fg #ececec`, `--muted #9a9a9a`, `--line #2e2e2e`, `--warn #f97066`, `--ok #47cd89`.
- Body 14px/1.5, margin 24px 16px. `h1` 18px. Table cells 8px padding with a 1px `--line` bottom border, header text `--muted` at weight 500. Tiles: 1px `--line` border, 8px radius, 8px 12px padding, value 20px tabular numbers, label 12px `--muted`.

## Fonts

The system stack `-apple-system, system-ui, sans-serif`. No web font to load.

## Icons

None. State is shown by text colour (`--warn` for parked, `--ok` for ready for review and live spend).

## Shell

None: an `h1`, a muted meta line, the spend tiles, then the table. At 390 px the table keeps its columns and wraps text in each cell.

## Pitfalls

- The page written by an older tick may lack sections the current `src/status.mts` renders (such as the spend tiles). Take the look of a missing section from the source, not the capture.
