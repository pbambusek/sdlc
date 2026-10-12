# Feedback: <project>

How to read what CI and review say about a commit of <project>, which the feedback skill reads. Update this file in the change that alters any of it.

## Checks

<!-- One entry per check that needs more than the default: a failure is a finding, its log tail is what was observed, success and skip say nothing. -->

- `<check name>`: <what it runs>. Reproduce with `<local command>`. <How to read its output when the default isn't enough: where the result is (job log, artifact, a comment it posts), what in it is a finding and what is noise.>
- `<check that must be read when green, such as a Terraform plan>`: read it on success too. <Where its output is, and what in it is a finding: for a plan, a replace or destroy of a stateful resource is a finding against the claim it touches; tag changes are not.>
- `<check that fails for reasons outside the code>`: <which failures are `blocked` instead of findings, and how to tell them apart in the log.>

## Expected

<!-- Checks that run on every commit. One missing from a commit is raised as an advisory finding. Leave out checks that run only on some changes. -->

- `<check name>`

## Review

<Whose reviews count, and which to skip (a bot that only summarises). How a reviewer marks severity, when it isn't critical / warning / nit.>

## Pitfalls

<Traps that make a red check look like a code bug, or the reverse.>
