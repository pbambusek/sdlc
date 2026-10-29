# Owners get a weekly summary of their ideas

> **Building this?** The claims are the acceptance criteria; how to meet them is your call. When a claim is unclear, conflicts with another, or stops fitting what you learn, ask on this issue and wait for the spec to be updated. A linked prototype shows the intended look and wording; where it and a claim differ, the claim wins.

## Intent

Every owner gets one short notification a week listing their ideas, so they remember what they proposed without opening the board.

## Context

Owners forget ideas they proposed weeks ago, and nobody follows them up. A weekly reminder was asked for on the board itself ("Weekly summary email").

Pointers (orientation, not design): notifications go through `src/outbox.mjs`; the app has no scheduler today.

## Claims

1. Every Monday at 09:00 UTC, each user who owns at least one idea receives one notification listing each of their ideas, newest first, with its title and the day it was proposed.
2. A user who owns no ideas receives no summary.
3. Each owner receives one summary per week, also when the app restarts on a Monday after 09:00 UTC.
4. An idea deleted before the summary is sent is not listed in it.

## Constraints

- No dependencies: the standard library only, as the rest of the app.

## Out of scope

- Real email delivery, unsubscribing, choosing the day or time.

## Open questions
