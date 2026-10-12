---
name: spec
description: Spec — a one-page issue that states intent and numbered, verifiable claims while leaving the solution to whoever builds it. Use when turning a problem description (a few sentences, a screenshot), a link (Slack thread, ticket, backlog item) or a reviewed prototype into a spec, or checking whether a spec is ready to approve.
---

A **spec** states *what* must be true and *why*, never *how*. It is written so that anyone can build from it unattended — an agent or a person, with or without this skill — and so that the result can be checked claim by claim. A human approves it before building starts.

## The concepts

- **Intent**: one or two sentences naming the end state and who it is for. It is the tiebreaker: whenever no claim covers a case, the builder decides by the intent.
- **Claim**: one numbered statement of something observably true once the feature exists. Claims are the acceptance criteria.
- **Claim group**: a `###` heading over the claims that serve one outcome a user or caller reaches, or one situation they are in. Groups keep a long spec readable, and verification reports by group. Claims that all serve one outcome need no group.
- **Boundary**: where a user, caller or downstream system meets the feature — a UI, CLI output or exit code, an API response, a message sent (Slack, PR comment, event), a workflow or tool result, telemetry. Every claim is stated at a boundary. Internal state (a table row, a cache, which function ran) is the builder's choice, so a claim that names it prescribes the solution.
- **Evidence**: the one artefact that proves a claim, obtained by running the change: a screenshot, command output, a response body, a posted message, a span. **One claim = one piece of evidence.** Needs two: split it. Nothing could prove it: rewrite it, or move it to Intent or Constraints.
- **Calibration**: an indented line under a claim that carries a judgement word (*similar*, *relevant*, *clear*), giving one case that counts and one that does not. It is the only kind of example a spec carries.
- **Open question**: `[NEEDS CLARIFICATION] <question> — Recommended: <answer>`. The spec cannot be approved while any remain.
- **Taste**: how much a feature's success depends on how it looks or reads to a person, not only on what it does. A calibration line pins taste down in words when one case that counts and one that does not are enough. When they are not, the spec needs a **prototype**. Recommend one when any of these holds:
  - The intent rests on a taste word at a UI boundary that one calibration line cannot pin down (*at a glance*, *less cramped*, *uncluttered*).
  - More than one layout or flow is plausible, and the choice changes how people use the feature.
  - The feature adds a new screen or reshapes an existing one.
  - People move through several states that are judged by seeing them side by side.

  It is not needed when the feature has no UI, follows a pattern the product already has (one more field on a form), changes only wording, or carries taste that a calibration line settles.
- **Prototype**: a clickable sketch of every screen and state the feature changes: one prototype covers the whole feature. Once a person has reviewed it, the prototype and what the reviewer decided are a source of claims: what the user sees, what it is called, where it sits. How it is built (markup, styling, spacing values) stays the builder's choice. The rules for writing it into the spec are in [template.md](template.md), under Context.
- **Builder note**: the fixed note at the top of every spec, in [template.md](template.md). It carries the rules a builder needs into the issue itself, because the spec is the only thing a builder is guaranteed to read. Copy it verbatim.

The sections and their order are in [template.md](template.md). Two worked specs, one UI and one backend, are in [examples.md](examples.md).

## Modes

Pick the mode from the request: a problem to turn into a spec → **Draft**; a spec to judge → **Lint**.

### Draft

The usual input is a few sentences about a problem, maybe a screenshot or a link. The human brings the *why*; you do the rest, and they steer the draft rather than answer an interview.

1. **Read the input.** Sentences state the problem and often a wished-for solution; keep the problem and turn the wish into intent. A screenshot or an unreviewed sketch shows what exists today or a wish: context, never a design to copy. A reviewed prototype is different: read it, together with what its reviewer decided (in the file, the issue or the conversation), as a source of claims. A link is an equally good starting point, alone or alongside sentences: fetch it and read it the same way — a Slack thread with the Slack tools (read the whole thread, not only the first message), a Jira ticket with the Atlassian tools, a GitHub issue with `gh issue view`, a backlog item from its page or source. Done when you can state the problem and who has it in one sentence; if you cannot, ask that one question and nothing else.
2. **Research what exists.** Read the code and docs behind the feature: today's behaviour, who may do what, where the feature will be consumed, and any evidence of demand (votes, interviews, feedback). Done when Context can name the existing surfaces it touches and the boundary each claim will be observed at.
3. **Write the full draft** in [template.md](template.md)'s shape, builder note included, claims ordered as a user or caller meets them and grouped by outcome when they serve more than one. Go beyond the input: the empty, failure and permission cases the human did not mention are where the draft earns its keep. Where a reasonable person could decide differently, pick your best answer for the claim and record the choice as an open question with that recommendation. Then judge the feature's **taste**. When it calls for a prototype and no reviewed one exists, write the behaviour claims in full, write the look-and-wording claims as your best guess, and add `[NEEDS CLARIFICATION] Prototype before approval? — Recommended: yes, because <the signal that holds>; it settles <the claims or choices it decides>`.
4. **Lint your own draft** with every item of [checklist.md](checklist.md) and fix what fails. Done when each item passes or its gap is an open question.
5. **Present and steer.** Show the spec, then put the open questions to the human, each with its recommendation, and fold every answer back into the claims. A yes to the prototype question starts the prototype, in this session or as a separate task, and the draft waits for it. When the reviewed prototype comes back, read it as in step 1 and fold its decisions in the same way. Done when no open question remains, or the human approves with the rest explicitly parked.
6. **Publish** to the tracker only when the human says so; the tracker is shared, so posting is their call.

### Lint

Apply every item of [checklist.md](checklist.md) to the spec, and judge every claim on its own. Report per claim number: `ok`, or the failure (`not at boundary`, `compound`, `prescribes solution`, `uncalibrated`, `unprovable`) with a rewrite. Then list section-level failures and remaining open questions, and end with a verdict: **ready** or **not ready**. Done when every claim and every checklist item has a verdict.
