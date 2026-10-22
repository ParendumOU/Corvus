#!/usr/bin/env bash
# Build Corvus for Windows + Linux in the Docker builder and publish the installers and the
# electron-updater feed (latest.yml, latest-linux.yml, blockmaps) to a DRAFT GitHub release
# v<version> on ParendumOU/Corvus, then upload SHA256SUMS.txt covering every asset of that draft.
# Nothing becomes visible to users or installed apps until the owner publishes the draft on GitHub.
#
# Usage (repo root, host with git, gh and Docker; see docs/RELEASE.md):
#   scripts/publish-release.sh 0.2.0                    build win + linux, publish to draft v0.2.0
#   scripts/publish-release.sh 0.2.0 --checksums-only   only regenerate SHA256SUMS.txt (after macOS)
#
# The version must already be set in apps/desktop/package.json (this script never bumps it).
# Auth: the token of the gh account ParendumOU (`gh auth token -u ParendumOU`), passed to the
# container and to gh as the GH_TOKEN environment variable only. It is never printed or stored, and
# the active gh account is not changed. Windows signing: CSC_LINK / CSC_KEY_PASSWORD as for
# scripts/release.sh.
set -euo pipefail

PUBLIC_REPO="${CORVUS_PUBLIC_REPO:-ParendumOU/Corvus}"
GH_USER="${CORVUS_PUBLIC_GH_USER:-ParendumOU}"

die() { echo "publish-release: $*" >&2; exit 1; }

[ $# -ge 1 ] || die "usage: scripts/publish-release.sh <version> [--checksums-only]"
version="${1#v}"
shift
checksums_only=0
case "${1:-}" in
  "") ;;
  --checksums-only) checksums_only=1 ;;
  *) die "unknown argument: $1" ;;
esac
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || die "not a semver version: $version"
tag="v$version"

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
command -v gh >/dev/null 2>&1 || die "gh is required"

token="$(gh auth token -u "$GH_USER" 2>/dev/null)" || die "no gh token for $GH_USER (gh auth login, then retry)"
[ -n "$token" ] || die "empty gh token for $GH_USER"

# isDraft of release $tag: "true", "false", or empty when it does not exist.
release_state() {
  GH_TOKEN="$token" gh release view "$tag" -R "$PUBLIC_REPO" --json isDraft --jq .isDraft 2>/dev/null || true
}

if [ "$checksums_only" -eq 0 ]; then
  app_version="$(sed -n 's/^  "version": "\(.*\)",$/\1/p' apps/desktop/package.json | head -1)"
  [ "$app_version" = "$version" ] || die "apps/desktop/package.json is $app_version, not $version: bump and commit it first"
  [ -z "$(git status --porcelain)" ] || die "working tree is not clean: commit first so the release matches a commit"
  [ "$(release_state)" != "false" ] || die "$tag is already published on $PUBLIC_REPO: refusing to touch a public release"
  command -v docker >/dev/null 2>&1 || die "docker is required"

  echo "Building $tag (Windows + Linux) and publishing to the draft release on $PUBLIC_REPO..."
  CORVUS_PUBLISH=always GH_TOKEN="$token" docker compose --profile release run --rm builder win linux
fi

[ "$(release_state)" = "true" ] || die "no draft release $tag on $PUBLIC_REPO (expected electron-builder to create it)"

work="$(mktemp -d "${TMPDIR:-/tmp}/corvus-release.XXXXXX")"
trap 'rm -rf "$work"' EXIT
echo "Downloading the assets of draft $tag to compute checksums..."
GH_TOKEN="$token" gh release download "$tag" -R "$PUBLIC_REPO" -D "$work/assets"
rm -f "$work/assets/SHA256SUMS.txt"
# The website links to these names under releases/download/$tag/; the yml files are the update feed.
for f in "Corvus-Setup-$version.exe" "Corvus-Portable-$version.exe" "Corvus-$version-x86_64.AppImage" \
  "corvus_${version}_amd64.deb" latest.yml latest-linux.yml; do
  [ -f "$work/assets/$f" ] || die "draft $tag is missing $f"
done
if command -v sha256sum >/dev/null 2>&1; then sha256() { sha256sum "$@"; }; else sha256() { shasum -a 256 "$@"; }; fi
(cd "$work/assets" && LC_ALL=C ls | while IFS= read -r f; do sha256 "$f"; done) > "$work/SHA256SUMS.txt"
GH_TOKEN="$token" gh release upload "$tag" -R "$PUBLIC_REPO" --clobber "$work/SHA256SUMS.txt"

echo "Draft $tag on $PUBLIC_REPO now has:"
GH_TOKEN="$token" gh release view "$tag" -R "$PUBLIC_REPO" --json assets --jq '.assets[] | "  \(.name)  \(.size)"'
echo "Still a draft. Review it at https://github.com/$PUBLIC_REPO/releases and publish it there when ready."
