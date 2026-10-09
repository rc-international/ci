#!/usr/bin/env bash
# Verify that a wilco -> ci sync PR is an EXACT copy of already-reviewed wilco
# code, then approve it as github-actions[bot].
#
# Why: wilco's sync-ci workflow opens these PRs as valors-release-bot, and
# GitHub does not let an app approve its own PR, so every sync waited for a
# human (ci#31, 2026-10-09). The code was already reviewed and merged in wilco;
# a second human review of a byte-identical copy adds nothing.
#
# Approves ONLY when all of these hold, else exits 1 with the reason:
#   - the PR title names a wilco commit ("... from wilco <sha>") that is on
#     wilco main (an ancestor of main: merged through review, not a branch);
#   - every changed file is a destination in that commit's scripts/sync-ci.sh
#     `publish <wilco path> <ci path>` lines (the sync's own source of truth);
#   - no file is removed or renamed;
#   - each changed file's blob at the PR head equals the wilco blob at that
#     commit (git blob SHA = content hash, so equal SHA = byte-identical).
#
# Env: PR_NUMBER, PR_TITLE, HEAD_SHA, BASE_SHA, REPO (owner/ci), WILCO_REPO,
#      READ_TOKEN (can read wilco + ci), APPROVE_TOKEN (GITHUB_TOKEN).
#      DRY_RUN=1 verifies and reports without posting the approval.
# PR text arrives only through env, never interpolated into this script.
set -euo pipefail

: "${PR_NUMBER:?}" "${PR_TITLE:?}" "${HEAD_SHA:?}" "${BASE_SHA:?}" "${REPO:?}" "${WILCO_REPO:?}"
: "${READ_TOKEN:?}" "${APPROVE_TOKEN:?}"

fail() {
    echo "::error::sync PR not auto-approved: $*" >&2
    exit 1
}

short=$(printf '%s' "$PR_TITLE" | sed -nE 's/.*from wilco ([0-9a-f]{7,40})\b.*/\1/p')
[[ -n "$short" ]] || fail "title does not name a wilco commit: $PR_TITLE"

wsha=$(GH_TOKEN=$READ_TOKEN gh api "repos/$WILCO_REPO/commits/$short" --jq .sha) ||
    fail "wilco commit $short not found"
[[ "$wsha" =~ ^[0-9a-f]{40}$ ]] || fail "bad wilco sha for $short: $wsha"

# Reviewed code only: the commit must be on wilco main (merged through review),
# not merely exist on some branch. compare/<sha>...main is "identical" or
# "ahead" exactly when <sha> is an ancestor of main.
rel=$(GH_TOKEN=$READ_TOKEN gh api "repos/$WILCO_REPO/compare/$wsha...main" --jq .status) ||
    fail "cannot compare wilco ${wsha:0:12} with main"
[[ "$rel" == identical || "$rel" == ahead ]] ||
    fail "wilco ${wsha:0:12} is not on main (compare status: $rel)"

# Destination -> source map from the sync script at that exact commit.
sync_sh=$(GH_TOKEN=$READ_TOKEN gh api "repos/$WILCO_REPO/contents/scripts/sync-ci.sh?ref=$wsha" \
    --jq .content | base64 -d) || fail "cannot read scripts/sync-ci.sh at $wsha"
declare -A SRC=()
while read -r kw from to; do
    [[ "$kw" == publish && -n "$from" && -n "$to" ]] && SRC["$to"]=$from
done <<<"$sync_sh"
((${#SRC[@]} > 0)) || fail "no publish lines in scripts/sync-ci.sh at $wsha"

# File list at the PINNED commits (base...head), not the live PR: a push
# after this event must not change what was verified versus what is approved.
files=$(GH_TOKEN=$READ_TOKEN gh api "repos/$REPO/compare/$BASE_SHA...$HEAD_SHA" \
    --jq '.files[] | "\(.status) \(.filename)"') || fail "cannot list changed files"
[[ -n "$files" ]] || fail "PR changes no files"

n=0
while read -r status path; do
    [[ "$status" == added || "$status" == modified ]] || fail "$path is $status (only added/modified allowed)"
    src=${SRC[$path]:-}
    [[ -n "$src" ]] || fail "$path is not a sync-ci.sh destination"
    ci_blob=$(GH_TOKEN=$READ_TOKEN gh api "repos/$REPO/contents/$path?ref=$HEAD_SHA" --jq .sha) ||
        fail "cannot read $path at PR head"
    w_blob=$(GH_TOKEN=$READ_TOKEN gh api "repos/$WILCO_REPO/contents/$src?ref=$wsha" --jq .sha) ||
        fail "cannot read wilco $src at $wsha"
    [[ "$ci_blob" == "$w_blob" ]] || fail "$path differs from wilco $src at ${wsha:0:12}"
    echo "ok: $path == wilco:$src@${wsha:0:12} (blob ${ci_blob:0:12})"
    n=$((n + 1))
done <<<"$files"

if [[ "${DRY_RUN:-}" == 1 ]]; then
    echo "DRY_RUN: would approve PR #$PR_NUMBER ($n file(s) verified against wilco ${wsha:0:12})"
    exit 0
fi
body="Auto-approved: all $n changed file(s) are byte-identical to wilco ${wsha:0:12} (already reviewed and merged there), and every path is a scripts/sync-ci.sh destination."
jq -n --arg body "$body" --arg sha "$HEAD_SHA" '{event: "APPROVE", body: $body, commit_id: $sha}' |
    GH_TOKEN=$APPROVE_TOKEN gh api "repos/$REPO/pulls/$PR_NUMBER/reviews" --method POST --input - >/dev/null ||
    fail "approve call failed"
echo "approved PR #$PR_NUMBER ($n file(s) verified against wilco ${wsha:0:12})"
