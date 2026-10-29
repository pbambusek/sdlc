# Ideas show who proposed them, by name, and when

> **Building this?** The claims are the acceptance criteria; how to meet them is your call. When a claim is unclear, conflicts with another, or stops fitting what you learn, ask on this issue and wait for the spec to be updated. A linked prototype shows the intended look and wording; where it and a claim differ, the claim wins.

## Intent

Anyone reading the board sees who proposed each idea and when, in words a person reads, not a login name and a raw date.

## Context

The list and an idea's page show the owner's login (`alice`) and an ISO date (`2026-01-05`). People asked who "alice" is, and the dates read like a log.

Pointers (orientation, not design): `src/views.mjs`; users have a display name in `src/db.mjs`.

## Claims

1. Each idea, on the list and on its own page, shows its owner's display name: the name they signed in with, starting with a capital letter.
   Calibration: `alice` shown as "Alice" counts; "alice" does not.
2. Each idea, on the list and on its own page, shows the day it was proposed as day, short month and year.
   Calibration: "5 Jan 2026" counts; "2026-01-05" does not.

## Constraints

- No dependencies: the standard library only, as the rest of the app.

## Out of scope

- Letting users change their display name.
- Relative times ("3 days ago").

## Open questions
