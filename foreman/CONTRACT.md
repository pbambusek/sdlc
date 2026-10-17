# Contract

What foreman assumes from people and from each stage. The stages are the `sdlc` skills, and each skill defines its own inputs and outputs without knowing any tracker; the tick is one way to run them, translating between them and Jira.

## Rules

1. Stages never call each other. They meet only in the ledger: Jira for the spec and its history, GitHub for code.
2. The tick gives a stage references to the ledger (a spec snapshot, a commit, a verify run folder, a feedback output), never content it wrote itself. Feedback receives verify's run folder unchanged; build receives feedback's output unchanged, and nothing else about its earlier round.
3. Each stage writes only its own outputs. The tick writes everything that touches Jira.
4. A requirement the change adds to running the system goes in `VERIFY.md`, in the same commit.
5. People approve the spec and merge the code.

## People

| To                           | Do                                                                                                                                                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Put an issue in the pipeline | Add the `sdlc` label. The description is the spec (the `feature-spec` shape).                                                                                                                                       |
| Approve it                   | An approver adds `sdlc-approved`. Only approvers in the config count; the tick reads who added it from the changelog.                                                                                               |
| Change an approved spec      | Edit the description, then remove `sdlc-approved` and add it again. An edit after approval stops the pipeline until then.                                                                                           |
| Continue a parked issue      | Answer what the park comment asks, then remove `sdlc-parked`. Every count (builds, verify runs) starts again from that moment. A build reads only the spec: answer its questions there, and approve the spec again. |
| Ship                         | Review and merge the PR once the issue is ready for review: feedback found nothing blocking in verify, CI or the review. The `sdlc/verify` commit status says whether verify passed.                                |

## Build stage

The `build` skill's own contract (its inputs, its result file, what it never does) is in its `SKILL.md`. The tick runs it like this:

1. It adds a detached worktree at `~/.sdlc/work/<KEY>-<n>-<id>`: at the PR head on a fix round or after an answer, at the remote default branch's head for the first build.
2. It starts a background Claude Code session in that worktree:

   ```
   claude --bg --session-id <uuid> -n "sdlc:build <KEY> #<n>" -- "/sdlc:build <spec snapshot> --source <issue URL> [--branch <PR branch>] [--feedback <archived feedback output>] --result <file> --headless"
   ```

   The spec snapshot is `~/.sdlc/runs/<KEY>/spec-<approval time>.md`, the issue's title and description as approved; verify and feedback get the same file. `--feedback` is the archived output of the round that asked for fixes (`~/.sdlc/archive/<KEY>/feedback/<file>`), passed on a fix round only.

3. Once the session has ended, the tick reads the result file and records it as a `[sdlc] build-result` comment, then removes the worktree. Every tick also removes any build worktree no running session works in.
   - `built`: the skill pushed the commit and opened a PR (or updated an existing one's body to describe the change). The tick labels the PR `sdlc`, marks it ready for review if it is still a draft (so code owners are asked), and starts a round on its head.
   - `asked`: the comment lists the questions, and the issue is parked. Once answered, the next build continues from the commit the build asked on, without verifying it first.
   - no result: counts as a build attempt; the tick retries within its limits, then parks.

The build skill pushes and opens the PR; it never writes to Jira, never launches verify, never marks its PR ready: the tick does. The tick finds the PR from the branch the latest build result named.

## Verify stage

Started by the tick as foreman's verify launcher (`src/verify/launch.mts`, see the README), a detached process:

```
node launch.mts --claims <spec snapshot> --source <issue URL> --slug <KEY> [--copy …] <sha>
```

The launcher runs as it always does. Its run folder `<repo>/.verify/<KEY>/<time>-<sha7>/` is the result: the tick reads `evidence.json` and `audit.json` once the launcher has exited.

| Run                                            | Result                                 |
| ---------------------------------------------- | -------------------------------------- |
| Audit clean, every claim shown                 | `passed`                               |
| Any claim blocked                              | `blocked`                              |
| Otherwise any claim not shown                  | `failed`                               |
| Audit not clean, no evidence, or no run folder | `invalid`: verified again, then parked |

A valid result (`passed`, `failed`, `blocked`) decides nothing by itself: it is one part of the round, which feedback reads. The tick projects it into the ledger: the `sdlc/verify` commit status on the commit, the run's `evidence.json` and `evidence.html` attached to the issue unchanged (as `sdlc-verify-<run>.json` and `.html`), and a `[sdlc] reported` comment naming both attachments and the run. It also copies the whole run folder to the archive, where feedback reads it.

## Review

When the repo's config has a `review`, the tick asks for a review of each new PR head once, alongside its first verify launch: it adds the trigger `label`, requests the `reviewer`, or both, and records a `[sdlc] review-requested` comment. A reviewer that is already asked, or has already reviewed that head (a code owner asked when the PR went ready), is not asked again; on a later head the request re-requests its review. The reviewer posts its review on the PR and, as `check`, a check run on the commit; the round waits for that check to exist and finish. The tick never reads the review: feedback does.

## The round

A round is one PR head. It has ended when verify has a valid result and nothing on the commit is still running: every check run has finished (a failure counts), no commit status outside the tick's own `sdlc/` ones is pending, and the reviewer's check exists. A head with no check run at all has ended once 5 minutes have passed since its first verify launch. GitHub is the source: the tick reads the commit's checks each tick, and waits for nothing else. After `roundTimeoutMinutes` (120 by default) the round ends anyway, and feedback lists what is still running as blocked.

## Feedback stage

Once the round has ended, the tick runs the `feedback` skill in a background Claude Code session, in a detached worktree at the head:

```
claude --bg --session-id <uuid> -n "sdlc:feedback <KEY> #<n>" -- "/sdlc:feedback <sha> --pr <number> --spec <spec snapshot> [--verify <archived run folder>] --out <file> --headless"
```

Once the session has ended, the tick archives the output (`~/.sdlc/archive/<KEY>/feedback/<file>`), attaches it to the issue unchanged, records a `[sdlc] feedback-result` comment listing the blocking findings and what nobody could read, and removes the worktree.

| Output    | Next                                                                  |
| --------- | --------------------------------------------------------------------- |
| `clean`   | ready for review                                                      |
| `fix`     | a fix build with `--feedback` the archived output, within `maxBuilds` |
| `blocked` | parked: a person unblocks what nobody could read                      |
| none      | run again, then parked after `maxFeedbackRuns`                        |

## What the tick writes to Jira

Every comment's first line starts `[sdlc]` and carries `key=value` fields; the rest is for people.

```
[sdlc] launched stage=build attempt=2 base=<sha|none> session=<uuid> work=<worktree> result=<result file>
[sdlc] build-result attempt=2 session=<uuid> outcome=built|asked|none [branch=<name>] [commit=<sha>] [review=<PR URL>]
[sdlc] launched stage=verify attempt=1 sha=<sha> log=<path>
[sdlc] review-requested sha=<sha>
[sdlc] reported sha=<sha> result=passed|failed|blocked|invalid [evidence=<attachment id> page=<attachment id>] [run=<run folder>]
[sdlc] launched stage=feedback attempt=1 sha=<sha> session=<uuid> work=<worktree> result=<output file>
[sdlc] feedback-result attempt=1 sha=<sha> session=<uuid> outcome=fix|blocked|clean|none [file=<archived output>]
[sdlc] parked
[sdlc] notice code=<why an approval does not count>
```

These comments are the tick's state: attempts and results are counted from them, since the latest approval or un-park. A run's number is the exception: it counts every run of its stage the issue has had, so an un-park never reuses a session name or result file. `maxBuilds` counts the same way; the verify and feedback limits stay per head and epoch.

## Shortcuts in this version

Each is a step short of the target, and each has its replacement.

| Shortcut                                                                                     | Replacement                                                                 |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Spec snapshots, results and run folders are local paths                                      | References a hosted dispatcher can resolve                                  |
| Verify's result comes from a local folder; the tick attaches it to Jira and posts the status | Verify posts its report and a check run under its own identity              |
| Every write to Jira and GitHub is made as you                                                | A separate identity per stage                                               |
| The verifier runs as a `claude -p` child, not visible in `claude agents`                     | The launcher starts it with `--bg`                                          |
| The round's end is read from GitHub each tick                                                | GitHub's `check_suite` and `pull_request_review` events wake the dispatcher |
| Gitignored files for a run come from the config                                              | The launcher reads them from `VERIFY.md`                                    |
