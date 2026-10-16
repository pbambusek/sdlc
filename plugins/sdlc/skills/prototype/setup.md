# Set a project up for prototyping

A project is ready when its root has a `PROTOTYPE.md` that tells the skill how to reach, capture and reproduce the app's pages. Write it from [assets/prototype-template.md](assets/prototype-template.md). Every value in it must come from the project's source or from a command you ran: a guessed port or selector sends every later prototype the wrong way.

## Which files

- **A repo with one web app** keeps everything in the root `PROTOTYPE.md`.
- **A repo with several web apps** gives each app that can host a prototype its own `PROTOTYPE.md` beside its code, and the root `PROTOTYPE.md` holds only the Apps section, linking each one. An app nobody prototypes keeps no file.

## Steps

1. **Find how it runs.** Read the README and the package scripts. Note the command that starts the app, the URL it serves, and how to start a second instance on another port. Start it. Done when a page answers `200`.
2. **Find access.** Open a page with `playwright-cli`. When it redirects to a sign-in, look for the project's own way around it: a development mode that skips sign-in, a test user, a preview deploy. Done when a headless browser shows a real page.
3. **Capture one page** at 1440×900 and 390×844, plus an accessibility snapshot. Use other sizes when the app targets other screens, and record them under Viewports.
4. **Trace the look.** From the page's stylesheet or theme setup, find where the design values live, how many themes there are, and how the app switches between them. Find each font family, and whether a public copy exists. Find the icon library, if any, and how an icon the page does not show yet can be reproduced. Name the shell elements and how they change at the narrowest size. Done when every section of the template has a value you checked.
5. **Gitignore** `.prototype/`, which holds every prototype, and `.playwright-cli/`, where `playwright-cli` writes its logs. Exclude `.prototype/` from any lint, format or duplication tool that does not read `.gitignore`.
6. **Try it.** Build a one-state prototype of the captured page in `.prototype/setup-check/index.html`, using only what `PROTOTYPE.md` says, and check it as the skill's step 6 does. Every difference from the capture is a missing or wrong value: fix `PROTOTYPE.md` and rebuild. Delete the folder when it matches.
7. **Stop** what you started.

Done when a prototype built only from `PROTOTYPE.md` matches the captured page at every viewport and in every theme.
