# foreman's fixture

A small app and three issues to push through foreman by hand, end to end. The app is Ideaboard: Node 24, no dependencies, its own repo (`app/` is not kept here: the repo's `main` is the baseline, and nothing is ever merged into it).

## Use

1. In foreman's config, map the issues' Jira project to the fixture repo: `"repos": { "<PROJECT>": { "path": "<local clone>", "github": "<owner/repo>" } }`.
2. Create each issue in `issues/` in that project: the first line is the summary, the rest the description. Add the `sdlc` label, then `sdlc-approved` as an approver.
3. Run `bin/foreman tick` (or let launchd) and answer what it asks.

To start again: abandon or close what is open, run `reset.sh <owner/repo>`, take the `sdlc` label off the old issues, and create the issues afresh. Every run starts from new issues, so no ledger carries over.

## What each issue is for

The traps are kept here, not in the app's repo, so no builder or verifier reads them.

**1 — votes**: the long round.

- Claim 6, "5 votes per week", is ambiguous: a calendar week or the last 7 days, in which time zone, and whether a withdrawn vote (claim 5) or a deleted idea's vote (claim 9) is given back. A build should ask.
- Claim 6's "when they can vote again" and claim 8's ten voters are slow to check by hand; nothing can move the clock.
- New routes must be listed in `docs/api.md`, and SQL must stay in `src/db.mjs` (`lint.yml / rules`). Easy to miss.
- Seeded bugs a probe can find: `GET /api/ideas/<missing id>` answers 500, and any signed-in user can delete anyone's idea. Voting on a missing idea likely inherits the first.
- Claim 10 (anonymous votes) fails if a build returns voters in the API.
- Leave a review comment you mean to dispute (e.g. "votes should be a separate service"), and one starting `nit:`.

**2 — author names**: the short, green round.

- Two claims, small change, touches `src/views.mjs`, so `smoke.yml / pages` runs (a `when triggered` check).
- Should end ready to merge, with nothing to decide.

**3 — weekly summary**: a claim the verifier can't check.

- The verifier can't move time, so claims 1 and 3 are blocked unless the build adds a seam (a dev route that runs the summary for a given moment).
- A seam described in the PR's own `VERIFY.md` isn't read: a run follows `VERIFY.md` on `main`. The verifier has to find it in the code, or the claim stays blocked: verify again, or change the claim.
