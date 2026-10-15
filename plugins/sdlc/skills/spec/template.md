# Spec template

Plain Markdown, so it works as a Jira or GitHub issue description. The issue title is the feature, stated as an outcome ("Any employee can propose an idea to the backlog").

```markdown
> **Building this?** The claims are the acceptance criteria; how to meet them is your call. When a claim is unclear, conflicts with another, or stops fitting what you learn, ask on this issue and wait for the spec to be updated. A linked prototype shows the intended look and wording; where it and a claim differ, the claim wins.

## Intent
<One or two sentences: the end state once this exists, and for whom.>

## Context
<Why: the problem and its evidence — a link, a quote, a metric.>
<Who is affected, and what they do today instead.>
Pointers (orientation, not design): <existing screens, modules, workflows or docs this touches, and where the feature is consumed>.

## Claims
### <An outcome a user or caller reaches, or a situation they are in>
1. <Who/what, in which situation, observes what — at a boundary.>
2. <...>
   Calibration: <a case that counts>; <a case that does not>.

### <The next outcome>
3. <...>

## Constraints
- <Only what no evidence can show: policy, data handling, compliance.>

## Out of scope
- <What not to build, even though it is adjacent.>

## Open questions
- [NEEDS CLARIFICATION] <question> — Recommended: <answer>
```

## Per section

- **Builder note** — verbatim on every spec. It is the builder's whole briefing on how to use the spec, so a builder who has never seen this skill still treats the claims as the contract.
- **Intent** — the end state, not a feature list. Read alone, it steers the builder right on a case no claim covers.
- **Context** — self-contained: summarise what a linked thread decided instead of writing "as discussed". Pointers name what exists; designing what is new is the builder's job.
- **Claims** — numbered from 1, in the order a user or caller meets them: happy path first, then the empty, failure and permission cases next to the step they belong to. Phrase each in the situation it holds in: "When …", "While …", "If … then …".
- **Claim groups** — when the claims serve more than one outcome, group them under `###` headings, in the order a user meets them. A heading names one outcome a user or caller reaches, or one situation they are in ("A proposer can merge into an open item"). A heading that needs an "and" is two groups; claims that need the same starting situation belong together; a group of one claim is fine. Numbers run on across groups (1…n, never restarting), so every claim has one number in the whole spec. Claims that all serve one outcome need no heading. Verification reports by group.
- **Constraints** — a constraint that evidence could show is a claim; move it there.
- **Out of scope** — the adjacent ideas a capable builder would be tempted to add.
- **Open questions** — the section is empty in an approved spec; keep the heading so its emptiness is visible.

A reviewed prototype is linked from Context as `Prototype (illustration): <link>, <the states it shows>`. The claims decide, so write what it settled into the spec:

- Anything visible that must hold becomes a claim: what is shown, what it is called, what is grouped or ordered how.
- A taste word gets a calibration line, with the cases taken from what the prototype showed.
- Whatever the review dropped goes to Out of scope.
- How it is built (markup, styling, spacing values) stays out.
