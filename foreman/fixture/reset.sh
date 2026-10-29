#!/bin/sh
# Puts the fixture repo back to its baseline: closes every open PR (never merged) and deletes every branch but main.
# usage: foreman/fixture/reset.sh <owner/repo>
set -eu
repo=${1:?usage: reset.sh <owner/repo>}
for n in $(gh pr list -R "$repo" --state open --json number -q '.[].number'); do gh pr close "$n" -R "$repo" --delete-branch; done
for b in $(gh api "repos/$repo/branches" --paginate -q '.[].name' | grep -vx main); do gh api -X DELETE "repos/$repo/git/refs/heads/$b"; done
echo "reset $repo: no open PRs, only main"
