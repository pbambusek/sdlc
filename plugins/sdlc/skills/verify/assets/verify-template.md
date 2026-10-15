# Verify: <project or package>

The facts about <project or package> that the verify skill reads. Update this file in the change that alters any of them.

## Surface

<How to install, start it detached and wait until it is up, with the project's own commands, and how to stop it. Which port it listens on and how to pick a free one. Where it listens, and how to drive it: the browser, HTTP routes, a CLI, a channel. How to take a screenshot.>

<!-- The repo root's VERIFY.md only, when a run needs gitignored files: -->

Copy into a run (`launch.mts --copy <path>`):

- `<path>`: <what it is, such as an .env that holds only secret references>.

<!-- The repo root's VERIFY.md only, when a claim needs a real service. A run holds a token; the launcher's nono proxy puts the real value on requests to the declared hosts. -->

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
