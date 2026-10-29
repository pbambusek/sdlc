# People vote for the ideas they want most

> **Building this?** The claims are the acceptance criteria; how to meet them is your call. When a claim is unclear, conflicts with another, or stops fitting what you learn, ask on this issue and wait for the spec to be updated. A linked prototype shows the intended look and wording; where it and a claim differ, the claim wins.

## Intent

Signed-in people can vote for other people's ideas, and the board shows which ideas have the most support, so an idea's owner knows whether to pursue it.

## Context

Today the board lists ideas newest first, and nothing says which ones people want. Owners ask around in chat instead.

Pointers (orientation, not design): the list and an idea's page (`src/views.mjs`), the routes (`src/app.mjs`, `docs/api.md`), storage (`src/db.mjs`), notifications (`src/outbox.mjs`).

## Claims

### Voting

1. When a signed-in user votes for another user's idea, the idea's vote count, shown on the list and on its page, goes up by one.
2. When the same user votes for the same idea again, its count does not change.
3. An idea's owner sees no vote button on their own idea, and a vote by the owner through the API is refused with 403 and leaves the count unchanged.
4. A visitor who is not signed in sees each idea's count and no vote button, and a vote through the API is refused with 401.
5. A user who voted for an idea can withdraw the vote, and its count goes down by one.

### Limits

6. A user has at most 5 votes per week. A sixth vote is refused with a message that says when they can vote again, and no count changes.

### Finding the most wanted

7. The list can be sorted by votes, most first, with ideas of equal votes newest first. The chosen order stays when the page is reloaded.

### The owner hears about support

8. When an idea reaches 10 votes, its owner receives one notification naming the idea. It does not come again when the count drops below 10 and climbs back.

### Deleted ideas

9. When an idea is deleted, its votes are gone, and they no longer count toward any voter's votes for the week.

### Votes are anonymous

10. No page and no API response says who voted for an idea, other than whether the signed-in user did.

## Constraints

- No dependencies: the standard library only, as the rest of the app.

## Out of scope

- Downvotes, weighted votes, comments.
- Changing who may delete an idea.

## Open questions
