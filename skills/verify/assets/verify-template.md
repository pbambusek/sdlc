---
# Only the repo root's VERIFY.md has this frontmatter; the launcher reads it. A package's VERIFY.md starts at the heading.
# Runs once in the exported commit, before it turns read-only.
install: yarn install --immutable
# Gitignored files the run needs, copied from your checkout, such as an .env that holds only secret references.
copy: []
# Paths in the export that the running system writes to; everything else is read-only.
writable: []
# The verification configuration, set in the verifier's environment. ${FREE_PORT} is a free port, ${VERIFY_DIR} the run's .verify folder.
env:
  EXAMPLE_DATA_DIR: ${VERIFY_DIR}/data
# Run after the session ends, to stop whatever it left running.
stop: <the project's own stop command>
---

# Verify: <project or package>

The facts about <project or package> that the verify skill reads. Update this file in the change that alters any of them.

## Surface

<How to start it and wait until it is up, with the project's own commands. Where it listens, and how to drive it: the browser, HTTP routes, a CLI, a channel. How to take a screenshot.>

## Identity & flags

<How to act as a user, or as another user. Which flags are on, which you can change, and which you can't.>

## Seams

<The other systems it calls, and how: real, faked, or not reachable.>

## Observability

<Where its traces, logs, metrics and events show up, and the commands that read them.>

## Healthy baseline

<What normal looks like once it is up: a health response, a page title, zero console errors.>

## Pitfalls

<Traps specific to it that cost a verifier time or give a false result.>

<!-- The repo root's VERIFY.md only, when the repo has packages with their own rules: -->

## Packages

- [<path>](<path>/VERIFY.md): <what it is>.

## Not yet verifiable

- <part>: <what blocks verifying it>.
