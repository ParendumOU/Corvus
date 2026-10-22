#!/usr/bin/env bash
# Build release artifacts inside the builder container (or a CI job using the same image).
# Usage (from repo root, on any host with Docker):
#   docker compose --profile release run --rm builder              # Windows (default)
#   docker compose --profile release run --rm builder linux        # Linux
#   docker compose --profile release run --rm builder win linux    # both
#
# Windows code signing (optional): set CSC_LINK (path, https URL or base64 of a .pfx/.p12)
# and CSC_KEY_PASSWORD. Without them the build is unsigned. See docs/CODE-SIGNING.md.
#
# Publishing: CORVUS_PUBLISH=always (+ GH_TOKEN) uploads the artifacts and latest*.yml to the draft
# GitHub release configured in apps/desktop/electron-builder.yml. Default is never; use
# scripts/publish-release.sh rather than setting it by hand.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
targets=("${@:-win}")
publish="${CORVUS_PUBLISH:-never}"
case "$publish" in
  never) ;;
  always) [ -n "${GH_TOKEN:-}" ] || { echo "CORVUS_PUBLISH=always needs GH_TOKEN" >&2; exit 1; } ;;
  *) echo "CORVUS_PUBLISH must be never or always, got: $publish" >&2; exit 1 ;;
esac
echo "Publish: $publish"

if [ -n "${CSC_LINK:-}" ]; then
  # Relative paths are relative to the repo root (electron-builder runs from apps/desktop).
  case "$CSC_LINK" in /*|https://*|data:*) ;; *) [ -f "$CSC_LINK" ] && export CSC_LINK="$root/$CSC_LINK" ;; esac
  echo "Code signing: enabled (certificate from CSC_LINK)"
else
  echo "Code signing: disabled (CSC_LINK not set)"
  export CSC_IDENTITY_AUTO_DISCOVERY=false
fi

pnpm install --frozen-lockfile
pnpm -r --filter "!@corvus/desktop" run build
pnpm --filter @corvus/desktop run build
cd apps/desktop
for t in "${targets[@]}"; do
  case "$t" in
    win)   pnpm exec electron-builder --win nsis portable --x64 --publish "$publish" ;;
    linux) pnpm exec electron-builder --linux AppImage deb --x64 --publish "$publish" ;;
    mac)   pnpm exec electron-builder --mac dmg zip --publish "$publish" ;; # needs a macOS host
    *)     echo "unknown target: $t" >&2; exit 1 ;;
  esac
done
mkdir -p "$root/release"
cp -v release/*.exe release/*.AppImage release/*.deb release/*.dmg release/*.zip "$root/release/" 2>/dev/null || true
