# Approval checklist

A spec is **ready** when every item passes.

## Builder note
- [ ] Present at the top, verbatim from the template.

## Intent
- [ ] One or two sentences, naming the end state and who it is for.
- [ ] Read alone, it would steer the builder correctly on a case no claim covers.

## Context
- [ ] States the problem with evidence (link, quote or metric).
- [ ] Self-contained: every reference to a discussion carries its conclusion.
- [ ] Pointers name existing things and where the feature is consumed.
- [ ] A linked prototype is reviewed, and every decision in it that must hold is a claim, a calibration line or an Out of scope line.

## Claims
- [ ] Numbered, ordered as a user or caller meets them.
- [ ] When they serve more than one outcome, grouped under `###` headings, each naming one outcome or situation without an "and"; numbers run on across groups, never restarting.
- [ ] No two groups could ship separately and each be useful alone; if they could, ask whether this is two specs.
- [ ] Each is observable at a boundary: UI, CLI, API, sent message, workflow result, or telemetry.
- [ ] Each is provable by exactly one piece of evidence from running the change.
- [ ] Each names only what is visible at the boundary; any table, column, endpoint path, library, internal function, or new component it names is a solution to strip out.
- [ ] Each judgement word (*similar*, *relevant*, *fast*, *clear*) has a calibration line, or is replaced by a value.
- [ ] Beyond the happy path, the empty, failure and permission cases that apply are covered.
- [ ] No two claims contradict each other.

## Constraints, scope, questions
- [ ] Constraints hold only what evidence cannot show.
- [ ] Out of scope lists at least one adjacent idea.
- [ ] Where the feature's taste calls for a prototype, a reviewed one is linked.
- [ ] No `[NEEDS CLARIFICATION]` remains.
