#!/usr/bin/env bash
# On a Mac with Xcode, from a checkout with node_modules installed: checks the iOS cookie banner
# code that runs without a WebView (modules/browser-kit/ios/ConsentRules.swift and
# ConsentMessages.swift) against Autoconsent's own filterCompactRules and the app's message cases,
# the same checks ConsentRulesTest and ConsentMessagesTest run on Android.
# Usage: bash apps/mobile/scripts/ios-consent-check.sh
set -euo pipefail
mobile="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
(cd "$mobile" && node scripts/consent-assets.mjs "$work/assets" --ios)
ios="$mobile/modules/browser-kit/ios"
swiftc -O -o "$work/consent-check" "$ios/ConsentRules.swift" "$ios/ConsentMessages.swift" "$ios/Tests/main.swift"
"$work/consent-check" "$work/assets/assets/corvus-consent/rules.txt" "$work/assets/test/corvus-consent/cases.tsv" \
  "$mobile/modules/browser-kit/android/src/test/resources/consent/messages.tsv"
