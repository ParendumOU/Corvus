#!/usr/bin/env bash
# On a Mac with Xcode, node and CocoaPods: builds Corvus for mobile for the iOS Simulator from this
# checkout (Release, JavaScript bundled, no signing), installs it on a simulator and starts it. For
# trying native changes (such as modules/browser-kit/ios) without a phone or a TestFlight build.
# Nothing is signed or uploaded. The build goes to apps/mobile/ios/build.
# Usage: bash apps/mobile/scripts/ios-simulator.sh [simulator name] [--no-install]
#   then: xcrun simctl openurl booted 'corvus://browser?open=https%3A%2F%2Fexample.com'
#         xcrun simctl io booted screenshot shot.png
set -euo pipefail
device="${1:-iPhone 18 Pro}"
root="$(cd "$(dirname "$0")/../../.." && pwd)"
bundle=com.parendum.corvus.mobile
export LANG="${LANG:-en_US.UTF-8}" LC_ALL="${LC_ALL:-en_US.UTF-8}"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=true EXPO_NO_TELEMETRY=1

cd "$root"
if [ "${2:-}" != --no-install ]; then
  pnpm install --frozen-lockfile --filter "@corvus/mobile..."
  pnpm --filter @corvus/shared --filter @corvus/sync-core build
fi
cd apps/mobile
pnpm exec expo prebuild --platform ios --clean --no-install
(cd ios && pod install)
proj="$(ls -d ios/*.xcodeproj | head -1)"
ws="${proj%.xcodeproj}.xcworkspace"
scheme="$(basename "${proj%.xcodeproj}")"
log="ios/build/xcodebuild.log"
mkdir -p ios/build
xcodebuild -workspace "$ws" -scheme "$scheme" -configuration Release -sdk iphonesimulator \
  -destination "platform=iOS Simulator,name=$device" -derivedDataPath ios/build/derived \
  CODE_SIGNING_ALLOWED=NO build >"$log" 2>&1 ||
  { grep -E 'error:' "$log" | head -30 >&2; tail -30 "$log" >&2; exit 1; }
app="$(ls -d ios/build/derived/Build/Products/Release-iphonesimulator/*.app | head -1)"
echo "built $app"

xcrun simctl boot "$device" 2>/dev/null || true
xcrun simctl bootstatus "$device" -b >/dev/null
xcrun simctl install "$device" "$app"
xcrun simctl launch "$device" "$bundle"
echo IOS_SIMULATOR_READY
