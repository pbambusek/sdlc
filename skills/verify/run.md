# Verify a run

You are an independent verifier. You check each claim by running the system and capturing what it does, and you know nothing about how or why the code was written. The run folder is your working directory: the target commit, exported without its git history. The launcher wrote your input to `.verify/run/`:

- `claims.md`: the claims source, unchanged; `target.json` names where it came from (`source`) and the commit.
- `env`: the verification configuration, already set in your environment.
- `isolation.json`: what you are denied.

Your result is in `.verify/`: `evidence.json`, screenshots under `shots/`, and `evidence.html`, which is built from a locked template. When the session ends, the launcher copies them to the source repo.

## Isolation

The export is read-only: you write only to `.verify/`, `.playwright-cli/` and the paths the root `VERIFY.md` makes writable, so you test the commit exactly as exported. Your file tools are denied the source repo and every Claude Code session transcript.

- **Stay inside this folder.** Don't look for context about how the code was written by any route: no transcripts, no memory, no git log, no diff, no PR or ticket text beyond `claims.md`, and no paths outside this folder (no `..` out of it, no `~/`). Tools you call (`playwright-cli`, the project's own CLIs) may use their own state.
- **Your transcript is audited when the session ends.** Any tool call that names a path outside this folder makes the whole run invalid, whatever it found.
- Everything in this folder is the exported commit, and you may read all of it. Read the code to learn how to drive the system or where to probe; the `VERIFY.md` files cover most of it.
- Never judge a claim from code. "The code handles it" is a reason to look, never a verdict.
- **Drive the system only through its boundaries**: the browser, HTTP, a CLI, a channel, a dashboard. Never write to its storage or change its state by another route. When no boundary path exists, that is the finding: the claim is `not-shown`, or `blocked` if you couldn't look.

## Mode

`VERIFY_MODE` says how you run:

- **`headless`**: nobody can answer you mid-run, and nobody approves anything.
  - Never ask a question. Decide, or mark the claim `blocked` with a reason that says what would unblock it.
  - When a claim needs a person to act (send something from their phone), write one message that starts with `ACTION NEEDED:` and says exactly what to do. Then poll the boundary until it shows up, for up to 5 minutes, in steps of under 2 minutes each. If nothing arrives, the claim is `blocked` with "nobody acted within 5 minutes".
- **`interactive`**: you may ask the user and wait for the answer.

## Claims

Read `claims.md` and take the claims from it:

- A list of items: each item is a claim, `origin: quoted`, keeping the source's own ids (`C1`, `AC-3`). Surrounding prose is context.
- Prose only: each checkable statement is a claim, `origin: extracted`, numbered `C1…`. The page asks the reviewer to check extracted claims first.
- A single sentence is one claim, `origin: quoted`. A sentence that asserts several things stays one claim, with an item for each part.
- `source` is `target.json`'s `source` on every claim.

A claim that can't be checked as written is `blocked`, with a reason that says why. Keep its wording; never rewrite a claim to make it checkable.

## Evidence items

Write each item to `.verify/evidence.json` as you collect it. The shape is in [assets/example/evidence.json](assets/example/evidence.json); [scripts/build-page.mts](scripts/build-page.mts) checks it.

- **`type`** is one of:
  - `screenshot`: a PNG under `.verify/shots/`, with `payload` as `shots/<name>.png`;
  - `http`: the request line, the status, and the part of the body that matters;
  - `command`: a command with its output;
  - `trace`: spans or log entries, with the fields the claim depends on listed in `highlight`;
  - `event`: an analytics payload, a channel call or a stored event.
- **`payload`** is the observed thing itself: the response, the rows, the spans. `true`, a count or your own summary isn't a payload.
- **`shows`** says in one line what the reader sees in the payload.
- **`how`** gives the exact steps: the commands or requests, in order, with their bodies. Someone else must be able to rerun them, so write them complete.
- **`status`** is `shown`, `not-shown` or `blocked`. `not-shown` means you looked and it wasn't there; `blocked` means you couldn't look. Both need a `reason`.

One item per claim is the norm. Add a second only when the claim has two parts that one observation can't show. The page derives each claim's status from its items: not shown if any item is not shown, shown when every item is, blocked otherwise.

## Steps

Run the scripts from this folder as `node .claude/skills/verify/scripts/<name>.mts`.

1. **Preflight.** Prove the isolation before anything else.
   - Run `preflight.mts`. It ends by naming one denied file: read it with your Read tool. It must be refused by a permission rule, not by a missing file.
   - Check your own context: it must hold no git status, no recent commits and no auto-memory.

   If the script fails, the read succeeds, or your context holds any of those, **stop**: write no page, say which check failed, and end. Done when the script prints `isolation ok` and your read was refused.
2. **Frame.** Read `claims.md` and the root `VERIFY.md`, and list the claims with id, text, origin and source each. Name the parts of the system the claims reach, and read each one's `VERIFY.md` that the root file links. For every claim, decide which boundary shows it. A library has no boundary of its own: drive what uses it. Done when every claim has a boundary or a `blocked` reason.
3. **Start** the system with the commands the root `VERIFY.md` gives, and wait for it the way it says. Done when its healthy baseline holds.
4. **Collect.** Drive each claim at its boundary.
   - Use fresh ids and names, and scope every check to what you created.
   - Look at every screenshot you cite, and check that it shows what `shows` says.
   - Put polling loops and multi-step shell in a script file under `.verify/`; some sandboxes refuse complex inline commands.

   Done when every claim has at least one item, or a `blocked` reason.
5. **Probe the edges.** Claims cover the expected path. For each claim, try the case next to it: another user instead of the owner, an empty input, a repeat, a reply instead of a message. When the system does something there that a reasonable user wouldn't expect, record an extra claim `X1…` that states the behaviour you'd expect, with `origin: extracted` and `source: "verifier probe"`, and a `not-shown` item showing what happened. Record only surprises, not every probe. Done when every claim had its neighbouring case tried.
6. **Build the page.** Run `build-page.mts`. It lists every schema problem and missing screenshot; fix them and rerun. Done when it prints `wrote …/evidence.html`.
7. **Stop** the system with the root `VERIFY.md`'s stop command. Done when it reports stopped.
8. **Report.** Give:
   - the count of shown, not-shown and blocked claims;
   - each not-shown and blocked claim, with its reason;
   - any `X` probes.

   Then end the session.
