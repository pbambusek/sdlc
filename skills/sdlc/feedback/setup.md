# Set a project up for feedback

A project is ready when its root has a `FEEDBACK.md` that lists every check a pull request can get, each with where its result is and when it is expected. Write it from [assets/feedback-template.md](assets/feedback-template.md). Every value in it must come from the repo's CI configuration or from a run you read: a guessed check name sends the next build round the wrong way.

The file is a list of checks and places, not a catalogue of their output. It states rules as classes ("a replace or destroy of a stateful resource", "a cloud provider outage"). Log text, error messages, test names and path filters change with every dependency bump, and the reader finds them in the logs and workflow files. The file never says what produces a result, how to run a check again, or what to do about a signal: CI reruns every check on the next commit, and the builder needs only the findings.

## Steps

1. **List the checks.** Read the CI configuration (`.github/workflows/`, or whatever runs the checks) and the check runs on recent pull requests' heads. Name each `<workflow file> / <check name>`, with the check name exactly as the check run shows it, so two workflows' `build` jobs stay apart. A check from outside GitHub Actions keeps its check name alone. Done when every check on those pull requests, and every pull-request-triggered job in the CI configuration, has an entry.
2. **Result.** For each check, read a recent failed run (`gh run list --workflow <file> --status failure`) only to find where the signal is. The default is the failed job's log. Name a step, a comment marker or a details URL when the signal is elsewhere, or when the log's last error hides it.
3. **Finding.** Add it only where the default is wrong: a check whose output must be judged when it passes (a Terraform plan, a schema diff, a bundle size report), or a non-success result that is not a finding (a scanner's `neutral`). State what is a finding as a class of change.
4. **Blocked.** Add it only for a check that has failed for reasons outside the code (a cloud provider outage, a held state lock, a permission the CI identity lacks). Name the class, not the message.
5. **Expected.** `every commit` when the workflow's pull request trigger has no path filter and the job no condition. `when triggered` otherwise: the reader checks the trigger in the workflow file. Leave out checks that never run on a pull request.
6. **Review**: which reviewers' comments count, how they mark severity when it isn't critical / warning / nit, and which parts of a review are not requested changes. A pull request with no review has nothing to read: no review is not a finding.

Done when every check that can run on a pull request has an entry, and no entry quotes log text or holds a guessed value.
