# Set a project up for feedback

A project is ready when its root has a `FEEDBACK.md` that says how to read each of its checks where the default isn't enough. Write it from [assets/feedback-template.md](assets/feedback-template.md). Every value in it must come from the repo's CI configuration or from a run you read: a guessed check name sends the next build round the wrong way.

The file says how to read a signal that is there: where a check's result is, what in it is a finding, what is `blocked`. It never says what produces a result, how to run a check again, or what to do about a signal (rerun it, request a review): CI reruns every check on the next commit, the builder needs only the findings. A missing signal is covered by Expected or by nothing.

## Steps

1. **List the checks.** Read the CI configuration (`.github/workflows/`, or whatever runs the checks) and the checks on a recent pull request's head. For each check, note its workflow and which changes trigger it. Done when every check on that pull request is named by `<workflow> / <check name>`.
2. **Read a failure of each.** For each check, find a recent failed run (`gh run list --workflow <file> --status failure`) and read its log. Where the default (the failed job's log) doesn't show what failed, say in Checks where it is: an artifact, a comment the check posts, a later part of the log.
3. **Find the checks read when green.** A check whose output must be judged even when it passes (a Terraform plan, a schema diff, a bundle size report) gets an entry saying where its output is and what in it is a finding.
4. **Separate infrastructure failures.** Failures that aren't the code's (a lost runner, a rate limit, an expired secret) go under that check, with how to tell them apart in the log. They become `blocked`, not findings.
5. **List Expected checks**: those whose trigger has no path filter and no condition, so they run on every commit.
6. **Review**: which reviewers' comments count, and how they mark severity when it isn't critical / warning / nit. A pull request with no review has nothing to read: no review is not a finding, unless Expected lists one.

Done when every check in the CI configuration is either in Checks or fully covered by the default, and the file holds no guessed value.
