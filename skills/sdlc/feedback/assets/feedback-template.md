# Feedback: <project>

How to read what CI and review say about a commit of <project>, which the feedback skill reads. Update this file in the change that alters any of it.

## Checks

<!-- One entry per check that can run on a pull request, named `<workflow file> / <check name>` with the check name exactly as the check run shows it (`<check name>` alone for a check outside GitHub Actions). One entry may name several checks that read alike. Each field states a place or a class, never quoted log text, a test name, or what produces the result. -->

- `<workflow file> / <check name>`
  - Result: <where its result is: the failed job's log, one step of it, a comment it posts, its details URL.>
  - Finding: <only where the default is wrong: what in a green result is a finding (for a Terraform plan, a replace or destroy of a stateful resource), or a non-success result that is not one.>
  - Blocked: <only for a check that fails for reasons outside the code: the class of failure, such as a cloud provider outage or a held state lock.>
  - Expected: <`every commit`, or `when triggered` for a check whose workflow filters on paths or conditions.>

## Review

<Whose reviews count, and which to skip (a bot that only summarises). How a reviewer marks severity, when it isn't critical / warning / nit. Which parts of a review are not requested changes.>
