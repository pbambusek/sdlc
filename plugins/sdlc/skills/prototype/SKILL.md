---
name: prototype
description: UI prototype — a clickable, self-contained HTML file showing a proposed change to a page or flow of a web app in the current repo, built on the running app's look and shareable as a ticket attachment or claude.ai Artifact. Use when asked for a prototype, mock-up or clickable demo of an app page or flow, to revise or publish one, or to set an app up for prototyping (write its PROTOTYPE.md files).
---

# Prototype a UI change

Build a throwaway, clickable prototype of a change to a web app's page in the `--out` file when the caller names one, else in `<repo>/.prototype/<slug>/index.html`. The file is self-contained: one HTML file with no sibling files, so it travels as a ticket attachment or a spec appendix. It may link public resources, so a reader may need internet. `.prototype/` is gitignored; attaching, linking or sharing the file is the caller's decision.

When the repo has no `PROTOTYPE.md` at its root, set the project up with [setup.md](setup.md) before anything else. Say so in one line as you start ("No PROTOTYPE.md here, setting the project up first."), so the user can stop you. Then build the prototype.

## Rules for every prototype

- **One question per prototype.** Everything on the page helps answer it. Leave out the rest.
- **Start from a real page.** Change an existing page captured from the running app, and match its look exactly. Sizes, spacing and layout come from the capture's screenshots, never from component code or memory.
- **One file.** Styles and scripts are inline. External resources are only those the profile names.
- **Realistic sample data, marked as sample.** Plausible content in one `DATA` block. No real person's activity.
- **Prototype controls look like prototype controls.** Version switches and forced outcomes live only in the `[data-prototype-control]` bar.
- **Every state opens from a `#name` link.** Each state is an entry in `STATES`.
- **Feedback stays with its prototype.** Apply a review comment to that file only. It is not a rule for the next prototype.
- **The local file is the master copy.** A claude.ai Artifact is a copy generated from it.

## The profile

The app's facts live in `PROTOTYPE.md`, written from [assets/prototype-template.md](assets/prototype-template.md); this skill holds the method. The repo root's `PROTOTYPE.md` covers a single-app repo; in a repo with several apps it lists each app's own `PROTOTYPE.md` under Apps. Every step below that names a heading reads it from the host app's profile: **Host**, **Access**, **Viewports**, **Look**, **Fonts**, **Icons**, **Shell** and **Pitfalls**. Without a **Viewports** section, the sizes are 1440×900 and 390×844.

## Steps

`<scratch>` is a temporary folder (`mktemp -d`). Captures, screenshots and the Artifact copy go there, never into the repo. Run `playwright-cli --help` for the browser commands.

1. **Frame.** Write the question, the host app, and the host page URL as one line each. Pick a kebab-case slug. Ask the user only if the question or the host page is unclear. Read the root `PROTOTYPE.md` and the host app's profile. Done when all three lines are concrete and the profile is read.
2. **Check prerequisites.** The host URL answers `200` (`curl -s -o /dev/null -w '%{http_code}' <url>`); if not, start the app as **Host** says. `playwright-cli --version` prints a version; if not, ask the user to install `@playwright/cli` globally. Done when both pass.
3. **Capture.** With `playwright-cli`, open the host URL as **Access** says and save to `<scratch>/capture`: a screenshot at each **Viewports** size, a full-page screenshot at the widest, and an accessibility snapshot. When the app has several themes, screenshot the widest size in each. If the change touches a dialog or another state of the host page, open it and screenshot it too. Note each icon the page shows, and the ones the change adds. Done when you can name every **Shell** element, every section of the host page, and the icon beside each.
4. **Collect the look.** Read **Look**, **Fonts** and **Icons**, and gather what each says: the design values for every theme with values unchanged, the font loading, and the markup or source for every icon from step 3. Done when you hold a value for each design token the page uses, in every theme, and the markup for every icon.
5. **Build** the prototype file, following [File structure](#file-structure). Copy the host page's real content first, then add the change under test. Done when every part of File structure is present and no placeholder text remains.
6. **Check.** Serve the folder on localhost (`python3 -m http.server --directory <its folder> <port>`, in the background); browsers and `playwright-cli` refuse `file://` pages. Open each `#state` with `playwright-cli`, with `localStorage` cleared, and screenshot it at each **Viewports** size, and at the widest size in each theme. Read every screenshot and compare the default state with the capture. If a state looks blank or broken, read the browser console; it covers only the current page load, so read it after each navigation. Fix and re-check. Done when each state matches the live page's look, shows the change, and has no sideways scroll at the narrowest size. Stop the server.
7. **Report.** Give the file path, the command to open it, the `#state` links, and the Artifact URL if published. When it is in `.prototype/`, say that the folder is gitignored. Say that the file can be attached to a ticket as it is.

## File structure

A sensible default; adapt the markup to the host page. Every part below is required.

- **Header comment** right after `<title>`, in exactly this shape:

  ```html
  <!--
    PROTOTYPE, not production code.
    Question: <the one question this prototype answers>
    Base: <host page URL>, captured <YYYY-MM-DD>
    Fake: <everything simulated: sample data, any "AI" result, timings, a fallback font, the [data-prototype-control] bar>
    States: <one #name per state, e.g. #default, #dialog, #match>
    Artifact: <claude.ai URL once published, else "not published">
  -->
  ```

- **Head links**: only what **Fonts** and **Icons** name, at the versions they say. Nothing else external.
- **Tokens** as CSS custom properties. One theme: one block on `:root`. A light and a dark theme: the light block on `:root`, the dark block inside `@media (prefers-color-scheme: dark) { :root:not([data-theme='light']) { … } }`, and again on `:root[data-theme='dark']`. More themes: the default on `:root`, each other on `:root[data-theme='<name>']`. Prototype-only tokens, such as an overlay colour, go in every block. `body` sets `background` and `color` from the tokens.
- **Shell**: the **Shell** chrome rebuilt from the snapshot, every group and item in order, with the host page active. Build it from the snapshot, which lists every element; a screenshot shows only the viewport. At the narrowest size, it behaves as that capture shows.
- **Icons**: as **Icons** says. Without other direction, inline the `<svg>` markup from the captured page.
- **`DATA`**: one block of sample data. Each state starts from a fresh copy of it.
- **`STATES`**: an object mapping each state name to a function that sets up that state. On load and on `hashchange`, reset to fresh data, run `STATES[location.hash.slice(1)] ?? STATES.default`, and render. An unknown or stale `#name` opens the default state. A bare `#name` is the only link form an Artifact passes through.
- **Control bar**: one element with `data-prototype-control`, fixed at the bottom centre of the content area. It holds a `Prototype` tag, a state switch that sets `location.hash`, a theme switch when the app has more than one theme, and any forced-outcome switches. Its `z-index` is below dialogs and sheets, so it never covers one.
- **Theme**, when the app has more than one: the switch sets `data-theme` on `<html>`, and the default follows the app's own default. The choice is remembered in `localStorage` under `prototype-<slug>-v1-theme`, with every read and write in `try`/`catch`. Bump the `-v1-` suffix whenever a remembered default changes, so earlier viewers get the new one.

## Revise

Edit the same file, then repeat step 6. Republish if the prototype is published.

## Publish to claude.ai

Only when the user asks.

1. Check that every head link sits on a claude.ai Artifact allowed host: Google Fonts for stylesheets, cdnjs, jsdelivr or unpkg for scripts. Inline anything else, or tell the user what the Artifact copy will lose.
2. Write `<scratch>/<slug>.artifact.html`: the file without the `<!doctype>`, `<html>`, `<head>` and `<body>` tags, and without the charset and viewport `<meta>` tags. Everything else stays in order, including the head links. The Artifact wraps the page itself, and a copy with its own document tags renders wrong.
3. Publish that copy with the Artifact tool. On a later publish, pass the URL from the header comment as `url`; without it, a new session creates a second Artifact.
4. Write the URL into the header comment's `Artifact:` line on first publish.
5. Tell the user that names and figures in the prototype are sample data before they share it.

Edit only the local file. The Artifact copy is regenerated on each publish.

When a step fails or the browser behaves unexpectedly, read the profile's **Pitfalls**. When you hit a trap that cost time and is specific to this app, add it there with its fix.
