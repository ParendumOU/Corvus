#!/usr/bin/env bash
# Builds the Android app (release APK) in the `android` Docker service:
#   docker compose run --rm android
# The native project is generated (expo prebuild) and never committed. The APK lands in
# out/mobile/. It is signed with the release key when /secrets holds corvus-mobile.keystore and
# corvus-mobile-keystore.env (KEYSTORE_PASSWORD, KEY_ALIAS, KEY_PASSWORD), a folder outside every
# repository; otherwise it keeps the debug signature, for local testing only. With the release key
# it also builds the App Bundle for Google Play (out/mobile/corvus-mobile-<version>.aab), signed by
# Gradle with the same key: Play uses it as the upload key, and as the app signing key once that
# key has been handed to Play App Signing (see docs/MOBILE.md).
set -euo pipefail
cd /workspace
pnpm install --frozen-lockfile >/dev/null
pnpm --filter @corvus/shared --filter @corvus/sync-core build >/dev/null

cd apps/mobile
VERSION="$(node -p "require('./package.json').version")"
pnpm exec expo prebuild --platform android --no-install --clean
cd android
# Release builds are shrunk and obfuscated with R8 (the generated project's
# android.enableMinifyInReleaseBuilds); the keep rules the app needs beyond those its libraries ship
# are in plugins/proguard-rules.pro (see "R8" in docs/MOBILE.md).
GRADLE_FLAGS=(--no-daemon --console=plain)
# The QR scanner's decoder is tested first, on real QR images (modules/qr-scanner, QrDecoderTest;
# library modules only have unit tests for the debug build type), and the browser's ad and tracker
# matcher on the cases the app's own matcher passes (modules/browser-kit, ContentBlockerTest).
./gradlew "${GRADLE_FLAGS[@]}" :qr-scanner:testDebugUnitTest :browser-kit:testDebugUnitTest assembleRelease

APK=app/build/outputs/apk/release/app-release.apk
MAPPING=app/build/outputs/mapping/release/mapping.txt
BUILD_TOOLS="$(ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -1)"
# Google ML Kit sends Google diagnostics, so it must stay out of the app (see "The QR scanner has no
# Google code" in docs/MOBILE.md): no ML Kit classes in the APK and nothing of it in its manifest.
# R8 renames classes, so their original names are looked up in its mapping file too.
MLKIT_PATTERN='L(com/google/mlkit|com/google/android/gms/internal/mlkit_[a-z_]+|com/google/android/gms/vision|androidx/camera/mlkit)/'
MLKIT_CLASSES="$( { unzip -p "$APK" 'classes*.dex'; sed -nE 's/^([^ #][^ ]*) -> .*:$/L\1\//p' "$MAPPING" | tr . /; } | grep -aoE "$MLKIT_PATTERN" | sort -u || true)"
MLKIT_MANIFEST="$("$BUILD_TOOLS/aapt2" dump xmltree --file AndroidManifest.xml "$APK" | grep -iE 'mlkit|vision\.DEPENDENCIES' || true)"
if [ -n "$MLKIT_CLASSES$MLKIT_MANIFEST" ]; then
  echo "Google ML Kit is in the APK:" >&2
  printf '%s\n' "$MLKIT_CLASSES" "$MLKIT_MANIFEST" >&2
  exit 1
fi
echo "No Google ML Kit in the APK or its manifest."
OUT_DIR=/workspace/out/mobile
mkdir -p "$OUT_DIR"
OUT="$OUT_DIR/corvus-mobile-$VERSION.apk"
# R8's mapping file turns the obfuscated names in stack traces (Play Console's crashes and ANRs) back
# into the real ones. The App Bundle carries it for Play; this copy goes with the APK and the release.
cp "$MAPPING" "$OUT_DIR/corvus-mobile-$VERSION-mapping.txt"
if [ -f /secrets/corvus-mobile.keystore ] && [ -f /secrets/corvus-mobile-keystore.env ]; then
  set -a
  # shellcheck disable=SC1091
  . /secrets/corvus-mobile-keystore.env
  set +a
  "$BUILD_TOOLS/zipalign" -f -p 4 "$APK" /tmp/corvus-aligned.apk
  "$BUILD_TOOLS/apksigner" sign --ks /secrets/corvus-mobile.keystore --ks-pass env:KEYSTORE_PASSWORD \
    --ks-key-alias "$KEY_ALIAS" --key-pass env:KEY_PASSWORD --out "$OUT" /tmp/corvus-aligned.apk
  "$BUILD_TOOLS/apksigner" verify "$OUT"
  echo "Signed with the release key."

  # The generated project signs release builds with the debug key; Gradle's injected signing
  # properties replace it for the bundle, so it carries one signature, ours.
  ./gradlew "${GRADLE_FLAGS[@]}" bundleRelease \
    -Pandroid.injected.signing.store.file=/secrets/corvus-mobile.keystore \
    -Pandroid.injected.signing.store.password="$KEYSTORE_PASSWORD" \
    -Pandroid.injected.signing.key.alias="$KEY_ALIAS" \
    -Pandroid.injected.signing.key.password="$KEY_PASSWORD"
  AAB_OUT="$OUT_DIR/corvus-mobile-$VERSION.aab"
  cp app/build/outputs/bundle/release/app-release.aab "$AAB_OUT"
  keytool -printcert -jarfile "$AAB_OUT" | grep -E "Owner:|SHA256:"
  sha256sum "$AAB_OUT"
else
  cp "$APK" "$OUT"
  echo "Signed with the debug key (no release key in /secrets): for local testing only."
fi
sha256sum "$OUT"
