# Verify: <project or package>

The facts about <project or package> that the verify skill reads. A run follows this file as it is on the default branch, so a change to it goes there in its own pull request, ahead of the change that needs it.

## Surface

<How to install, start it detached and wait until it is up, with the project's own commands, and how to stop it. Which port it listens on and how to pick a free one. Where it listens, and how to drive it: the browser, HTTP routes, a CLI, a channel. How to take a screenshot.>

<!-- The repo root's VERIFY.md only, when a run needs gitignored files: -->

Copy into a run:

- `<path>`: <what it is, such as an .env that holds only secret references>.

<!-- The repo root's VERIFY.md only. A runner may add its own settings here, in the form its documentation gives. -->

## Workspace

<The operating system and architecture the system runs on, and what a run's workspace needs beyond the system's own install: toolchains and tools at the versions the project pins, each with how to install it, images worth fetching ahead, the memory a cold start peaks at, and any tool cache a run gains from.>

<!-- The repo root's VERIFY.md only, when a claim needs a real service. The runner reads each credential without a prompt; it hands the run the value, or a placeholder it swaps on the declared hosts only. -->

## Credentials

<What each credential is for, and how the run hands it to the system (such as writing the variable into an .env).>

```json
{ "vault": "<key vault>", "credentials": [{ "name": "<ENV_VAR>", "secret": "<vault secret>", "hosts": ["<host>"], "header": "Authorization", "format": "Bearer {}" }] }
```

## Identity & flags

<How to act as a user, or as another user. Which flags are on, which you can change, and which you can't.>

## Seams

<The other systems it calls, and how: real, faked, or not reachable. How a run stands in for a person who would act during it.>

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
