# Worked specs

Two shapes the same template takes: a UI feature written after a prototype review, and a backend feature with no screen. Both are illustrative; treat the product details as invented. Each opens with the builder note from [template.md](template.md) in a real spec; it is left out here so the examples show only what varies.

## UI: any employee can propose an idea to the backlog

```markdown
## Intent
Any employee can put an idea on the backlog in under a minute, and is steered to vote on an existing item when their idea is already there, without being blocked when the match is wrong. Every item can be told apart at a glance.

## Context
The most upvoted backlog item (20 votes) asks for this; interviews raised it too. Today only the product team creates backlog items, so ideas arrive through chat and a feedback form, and voters never see them. Opening submission invites near-duplicates, which split votes and hide what is wanted most. Rows also truncate titles, so items are hard to tell apart.
Pointers (orientation, not design): `/backlog`, the team-only create form, the item detail panel, voting and search on the same page.
Prototype (illustration): `prototypes/propose-idea/index.html`, states `#list`, `#match`, `#being-built`.

## Claims
1. A non-team employee sees a "Propose an idea" action on `/backlog`.
2. The proposal asks for a title and a problem/outcome description, and nothing else.
3. Before posting, the user sees up to 3 existing items that look like the same idea, each with its title and vote count.
   Calibration: "Weekly summary of what my team shipped" matches "Builders can open 'Last week'"; "Weekly summary for my manager by email" does not.
4. Choosing a match adds the user's vote to it and creates no new item.
5. Choosing a match they already voted for leaves their vote unchanged and tells them so.
6. Dismissing the matches posts the idea as typed, with 1 vote from the proposer.
7. With no matches, the idea posts without an extra step.
8. While the duplicate check is unavailable (it fails or takes over ~5 s), the user is told it did not run and can still post.
9. A proposed item shows its proposer in the list and in the detail panel.
10. A non-team user sees no Edit or Delete on any item, including their own.
11. The team can edit, move and delete proposed items as they can team-created ones.
12. Items being built are listed above the open ones under a "Being built" heading, each with its vote count and a note that voting is closed.
13. At 1440 px, every row can be told apart at a glance: it shows its full title, a one-line summary and its vote count.
   Calibration: a row with its title and a one-line summary counts; a row with only its title does not, even when the title is shown in full.

## Constraints
- Proposal text may be sent to an LLM; it is internal and carries no customer data by design.

## Out of scope
- A moderation queue before an idea appears.
- Merging duplicates already on the backlog.
- Notifying proposers when their item moves to the roadmap.
- Showing vote growth or a discussion on an item.

## Open questions
```

## Backend: PR review skips opted-out PRs

```markdown
## Intent
A builder can keep the review bot off a PR by labelling it, and the team can still see how often that happens.

## Context
Builders close or ignore reviews on draft-spike PRs, which costs model spend and adds noise to review telemetry.
Pointers (orientation, not design): the PR review workflow, its result outcome, the review span, the PR's comments.

## Claims
1. When a PR carries the `no-review` label, the review run ends with outcome `skipped` and reason `opted-out`.
2. A skipped run posts no review comment on the PR.
3. When the label is removed and the PR is updated, the next run reviews it normally.
4. A skipped run still emits its review span with the outcome recorded.
5. If the PR's labels cannot be read, the review proceeds and the run states that the label check did not run.
   Calibration: a GitHub API timeout counts as "cannot be read"; a PR with zero labels does not.

## Constraints
- None.

## Out of scope
- Skipping by author, path or repository.
- A UI for managing opt-outs.

## Open questions
```
