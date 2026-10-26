#!/usr/bin/env bash
# Runs scripts/validate.sh in the dev container, unless this exact code already passed it.
#
#   scripts/validate-docker.sh                      # main checkout (Compose project "corvus")
#   scripts/validate-docker.sh -p corvus-wt-<x>     # a worktree
#   CORVUS_VALIDATE_FULL=1 scripts/validate-docker.sh   # always run the full validation
#   scripts/validate-docker.sh --fingerprint        # print the code fingerprint and exit
#
# Runs on the host (Git Bash on Windows): it needs git and docker. The fingerprint covers every file
# git tracks or would track (untracked files that are not ignored count too), except docs/ and
# Markdown, with each package.json / plugin.json "version" line blanked. So a release commit, which
# only bumps versions and edits CHANGELOG and docs, reuses the result of the validation its code
# already passed instead of running the same ~6 minutes again. Results are kept in the git common
# directory, so a pass in a worktree also counts for main. Ends with "VALIDATION: OK" or
# "VALIDATION: FAILED", like validate.sh.
set -euo pipefail

project=""
only_fingerprint=0
case "${1:-}" in
  "") ;;
  -p) project="${2:?usage: scripts/validate-docker.sh [-p <compose project>] | --fingerprint}" ;;
  --fingerprint) only_fingerprint=1 ;;
  *) echo "usage: scripts/validate-docker.sh [-p <compose project>] | --fingerprint" >&2; exit 2 ;;
esac

cd "$(dirname "$0")/.."
command -v git >/dev/null 2>&1 || { echo "validate-docker: git is required" >&2; exit 2; }

fingerprint() {
  local files manifests others
  # Tracked files deleted from the working tree are left out (there is nothing to hash).
  files="$(git -c core.quotepath=off ls-files -co --exclude-standard | grep -vxF -f <(git -c core.quotepath=off ls-files -d) | grep -vE '^docs/|\.md$' | LC_ALL=C sort -u)"
  manifests="$(printf '%s\n' "$files" | grep -E '(^|/)(package|plugin)\.json$' || true)"
  others="$(printf '%s\n' "$files" | grep -vE '(^|/)(package|plugin)\.json$' || true)"
  {
    paste -d ' ' <(printf '%s\n' "$others") <(printf '%s\n' "$others" | git hash-object --stdin-paths)
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      printf '%s %s\n' "$f" "$(sed -E 's/^([[:space:]]*"version": )"[^"]*"/\1""/' "$f" | git hash-object --stdin)"
    done <<<"$manifests"
  } | git hash-object --stdin
}

stamps="$(git rev-parse --git-common-dir)/corvus-validate"
fp="$(fingerprint)"
stamp="$stamps/$fp"
if [ "$only_fingerprint" = 1 ]; then
  echo "$fp"
  exit 0
fi

if [ "${CORVUS_VALIDATE_FULL:-}" != "1" ] && [ -f "$stamp" ]; then
  echo "[validate] same code as an earlier passing run, reused:"
  sed 's/^/[validate]   /' "$stamp"
  echo "VALIDATION: OK"
  exit 0
fi

log="$(mktemp)"
trap 'rm -f "$log"' EXIT
status=0
if [ -n "$project" ]; then
  docker compose -p "$project" run --rm dev sh scripts/validate.sh 2>&1 | tee "$log" || status=$?
else
  docker compose run --rm dev sh scripts/validate.sh 2>&1 | tee "$log" || status=$?
fi

# Only a run that ended in VALIDATION: OK is recorded, and only if the code did not change meanwhile.
if [ "$status" -eq 0 ] && tail -n 1 "$log" | grep -q '^VALIDATION: OK$' && [ "$(fingerprint)" = "$fp" ]; then
  mkdir -p "$stamps"
  {
    echo "commit $(git rev-parse --short HEAD)$( [ -n "$(git status --porcelain)" ] && echo ' (with uncommitted changes)' ), $(date '+%Y-%m-%d %H:%M')"
    grep -E '^\[validate\] (smoke checks passed|.*Tests +[0-9])' "$log" | sed 's/^\[validate\] //' || true
  } >"$stamp"
fi
exit "$status"
