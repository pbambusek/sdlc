# Feedback: <project>

How to read what CI and review say about a commit of <project>, which the feedback skill reads. Update this file in the change that alters any of it.

## Checks

<!-- One entry per check that needs more than the default: a failure is a finding, its log is what was observed, success and skip say nothing. An entry says how to read the check's result, never what produces it or how to run it again: CI reruns it on the next commit. -->

- `<workflow> / <check name>`: <where its result is when the log doesn't show it (a line earlier in the log, an artifact, a comment it posts), and what in it is a finding and what is noise.>
- `<workflow> / <check that must be read when green, such as a Terraform plan>`: read it on success too. <Where its output is, and what in it is a finding: for a plan, a replace or destroy of a stateful resource is a finding against the claim it touches; tag changes are not.>
- `<workflow> / <check that fails for reasons outside the code>`: <which failures are `blocked` instead of findings, and how to tell them apart in the log.>

## Expected

<!-- Checks that run on every commit. One missing from a commit is raised as an advisory finding. Leave out checks that run only on some changes. -->

- `<workflow> / <check name>`

## Review

<Whose reviews count, and which to skip (a bot that only summarises). How a reviewer marks severity, when it isn't critical / warning / nit.>

## Pitfalls

<Traps that make a red check look like a code bug, or the reverse.>
