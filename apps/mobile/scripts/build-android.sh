#!/usr/bin/env bash
# Builds the Android app in the `android` Docker service, from the repository root:
#
#   docker compose --profile android run --rm android
#       Release build, the one releases use: every ABI, R8, the unit tests, the APK and (with the
#       release key) the App Bundle for Google Play, out/mobile/corvus-mobile-<version>.apk/.aab.
#   docker compose --profile android run --rm -e CORVUS_ANDROID_ABIS=x86_64 android
#       Test build for one ABI (x86_64: the emulator; arm64-v8a: a phone; or a comma-separated
#       list): the same release build (R8, release key, so it behaves like the release) without the
#       App Bundle, out/mobile/corvus-mobile-<version>-<abi>.apk.
#       Add -e CORVUS_ANDROID_SKIP_TESTS=1 to skip the unit tests.
#   Add -e CORVUS_ANDROID_CLEAN=1 to either to generate the native project again and build it from
#   scratch (the caches still apply). Arguments after `android` go to Gradle (e.g. --profile).
#
# The native project is generated (expo prebuild) and never committed. It lives, with Gradle's
# build state, in the Docker volume mounted at apps/mobile/android (docker-compose.yml), so a build
# only redoes what changed; the outputs land in out/mobile/. See "Android builds" in docs/MOBILE.md.
#
# The APK is signed with the release key when /secrets holds corvus-mobile.keystore and
# corvus-mobile-keystore.env (KEYSTORE_PASSWORD, KEY_ALIAS, KEY_PASSWORD), a folder outside every
# repository; otherwise it keeps the debug signature, for local testing only. With the release key
# the release build also makes the App Bundle for Google Play, signed by Gradle with the same key:
# Play uses it as the upload key, and as the app signing key once that key has been handed to Play
# App Signing (see docs/MOBILE.md).
set -euo pipefail
shopt -s nullglob dotglob

ABIS="${CORVUS_ANDROID_ABIS:-}"
SKIP_TESTS="${CORVUS_ANDROID_SKIP_TESTS:-0}"
if [ -n "$ABIS" ]; then
  for abi in ${ABIS//,/ }; do
    case "$abi" in
      armeabi-v7a | arm64-v8a | x86 | x86_64) ;;
      *) echo "CORVUS_ANDROID_ABIS: unknown ABI \"$abi\" (armeabi-v7a, arm64-v8a, x86, x86_64)" >&2; exit 2 ;;
    esac
  done
elif [ "$SKIP_TESTS" = 1 ]; then
  echo "CORVUS_ANDROID_SKIP_TESTS is for test builds (with CORVUS_ANDROID_ABIS): release builds always run the tests." >&2
  exit 2
fi

started=$SECONDS
cd /workspace
pnpm install --frozen-lockfile >/dev/null
pnpm --filter @corvus/shared --filter @corvus/sync-core build >/dev/null

MOBILE=/workspace/apps/mobile
NATIVE="$MOBILE/android"
STAMP="$NATIVE/.corvus-prebuild"
cd "$MOBILE"
VERSION="$(node -p "require('./package.json').version")"

# Everything expo prebuild reads: the app config, its config plugins and the images they copy, the
# npm packages (lockfile and patches) and this script, which runs it.
prebuild_inputs() {
  (
    cd /workspace
    {
      find apps/mobile/app.json apps/mobile/package.json apps/mobile/plugins apps/mobile/assets \
        apps/mobile/modules/*/expo-module.config.json apps/mobile/scripts/build-android.sh \
        package.json pnpm-lock.yaml patches -type f
    } | LC_ALL=C sort | xargs -d '\n' sha256sum
    node --version
  ) | sha256sum | cut -d ' ' -f 1
}

# The generated files of a native project, without what building it adds.
project_hash() {
  (
    cd "$1"
    find . \( -path ./.gradle -o -path ./.kotlin -o -path ./build -o -path ./app/build -o -path ./app/.cxx \
      -o -path ./.corvus-prebuild \) -prune -o -type f -print | LC_ALL=C sort | xargs -d '\n' sha256sum
  ) | sha256sum | cut -d ' ' -f 1
}

# expo prebuild cannot replace apps/mobile/android, a mount point, so it generates the project in a
# scratch copy of the app made of symbolic links (same layout, so the same relative paths).
fresh_prebuild() {
  local scratch=/tmp/corvus-prebuild entry
  rm -rf "$scratch"
  mkdir -p "$scratch/apps/mobile"
  for entry in /workspace/package.json /workspace/pnpm-workspace.yaml /workspace/pnpm-lock.yaml /workspace/node_modules; do
    ln -s "$entry" "$scratch/"
  done
  for entry in "$MOBILE"/*; do
    case "${entry##*/}" in android | ios) ;; *) ln -s "$entry" "$scratch/apps/mobile/" ;; esac
  done
  (cd "$scratch/apps/mobile" && pnpm exec expo prebuild --platform android --no-install >&2)
  if grep -rqF "$scratch" "$scratch/apps/mobile/android"; then
    echo "expo prebuild wrote its scratch path into the native project" >&2
    exit 1
  fi
  echo "$scratch/apps/mobile/android"
}

# A test build reuses the native project while what prebuild reads is unchanged. A release build
# always checks it against a fresh prebuild (a few seconds). A project that differs, or that an
# interrupted run left without its stamp, is replaced and its build state dropped.
prepare_native_project() {
  local inputs generated
  inputs="$(prebuild_inputs)"
  if [ "${CORVUS_ANDROID_CLEAN:-0}" = 1 ]; then
    echo "CORVUS_ANDROID_CLEAN=1: native project and build state dropped."
    find "$NATIVE" -mindepth 1 -delete
  fi
  if [ -n "$ABIS" ] && [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$inputs $(project_hash "$NATIVE")" ]; then
    echo "Native project reused: what expo prebuild reads has not changed."
    return
  fi
  generated="$(fresh_prebuild)"
  if [ -f "$STAMP" ] && [ "$(project_hash "$generated")" = "$(project_hash "$NATIVE")" ]; then
    echo "Native project reused: the same as a fresh expo prebuild."
  else
    echo "Native project generated again: its build state starts over (Gradle's and ccache's caches still apply)."
    find "$NATIVE" -mindepth 1 -delete
    cp -a "$generated/." "$NATIVE/"
  fi
  echo "$inputs $(project_hash "$NATIVE")" >"$STAMP"
}
prepare_native_project
prepared=$SECONDS

# One Gradle run makes everything, on every core, reusing task outputs from Gradle's build cache
# (in the gradle_cache volume) and from the previous build of this project. The init script puts
# the local modules' build folders in the volume too, and compiles C++ through ccache.
GRADLE_FLAGS=(--no-daemon --console=plain --build-cache --parallel "--max-workers=$(nproc)"
  "-Dorg.gradle.jvmargs=-Xmx6g -XX:MaxMetaspaceSize=1g -XX:+HeapDumpOnOutOfMemoryError -Dfile.encoding=UTF-8"
  "-Pkotlin.daemon.jvmargs=-Xmx3g" --init-script "$MOBILE/scripts/build-android.init.gradle")
# The C++ of React Native's new architecture (the app's own and the native modules', per ABI) goes
# through ccache, kept in a volume, so a project generated again does not compile it all again.
if command -v ccache >/dev/null 2>&1; then
  export CCACHE_DIR=/root/.cache/ccache CCACHE_MAXSIZE=5G CCACHE_SLOPPINESS=include_file_mtime,include_file_ctime,time_macros
  ccache --zero-stats >/dev/null
fi
# Test builds keep Metro's transform cache between builds (a volume too), so a JavaScript change
# only transforms the files that changed. Release builds bundle from scratch.
if [ -n "$ABIS" ]; then
  export EXPO_METRO_CACHE_OUTPUT_DIR=/root/.cache/metro
fi

SIGNED=0
if [ -f /secrets/corvus-mobile.keystore ] && [ -f /secrets/corvus-mobile-keystore.env ]; then
  SIGNED=1
  set -a
  # shellcheck disable=SC1091
  . /secrets/corvus-mobile-keystore.env
  set +a
fi

cd "$NATIVE"
TASKS=()
# The QR scanner's decoder is tested first, on real QR images (modules/qr-scanner, QrDecoderTest;
# library modules only have unit tests for the debug build type), and the browser's ad and tracker
# matcher on the cases the app's own matcher passes (modules/browser-kit, ContentBlockerTest).
if [ "$SKIP_TESTS" != 1 ]; then
  TASKS+=(:qr-scanner:testDebugUnitTest :browser-kit:testDebugUnitTest)
fi
# Release builds are shrunk and obfuscated with R8 (the generated project's
# android.enableMinifyInReleaseBuilds); the keep rules the app needs beyond those its libraries ship
# are in plugins/proguard-rules.pro (see "R8" in docs/MOBILE.md).
TASKS+=(assembleRelease)
if [ -n "$ABIS" ]; then
  GRADLE_FLAGS+=("-PreactNativeArchitectures=$ABIS")
elif [ "$SIGNED" = 1 ]; then
  TASKS+=(bundleRelease)
fi
if [ "$SIGNED" = 1 ]; then
  # The generated project signs release builds with the debug key; Gradle's injected signing
  # properties replace it, so the bundle carries one signature, ours (apksigner signs the APK again
  # below, after zipalign).
  GRADLE_FLAGS+=(
    -Pandroid.injected.signing.store.file=/secrets/corvus-mobile.keystore
    "-Pandroid.injected.signing.store.password=$KEYSTORE_PASSWORD"
    "-Pandroid.injected.signing.key.alias=$KEY_ALIAS"
    "-Pandroid.injected.signing.key.password=$KEY_PASSWORD")
fi
./gradlew "${GRADLE_FLAGS[@]}" "${TASKS[@]}" "$@"
built=$SECONDS

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
NAME="corvus-mobile-$VERSION"
[ -z "$ABIS" ] || NAME="$NAME-${ABIS//,/+}"
OUT="$OUT_DIR/$NAME.apk"
# R8's mapping file turns the obfuscated names in stack traces (Play Console's crashes and ANRs) back
# into the real ones. The App Bundle carries it for Play; this copy goes with the APK and the release.
cp "$MAPPING" "$OUT_DIR/$NAME-mapping.txt"
if [ "$SIGNED" = 1 ]; then
  "$BUILD_TOOLS/zipalign" -f -p 4 "$APK" /tmp/corvus-aligned.apk
  "$BUILD_TOOLS/apksigner" sign --ks /secrets/corvus-mobile.keystore --ks-pass env:KEYSTORE_PASSWORD \
    --ks-key-alias "$KEY_ALIAS" --key-pass env:KEY_PASSWORD --out "$OUT" /tmp/corvus-aligned.apk
  "$BUILD_TOOLS/apksigner" verify --print-certs "$OUT" | grep -E 'SHA-256'
  echo "Signed with the release key."
  if [ -z "$ABIS" ]; then
    AAB_OUT="$OUT_DIR/$NAME.aab"
    cp app/build/outputs/bundle/release/app-release.aab "$AAB_OUT"
    keytool -printcert -jarfile "$AAB_OUT" | grep -E "Owner:|SHA256:"
    sha256sum "$AAB_OUT"
  fi
else
  cp "$APK" "$OUT"
  echo "Signed with the debug key (no release key in /secrets): for local testing only."
fi
sha256sum "$OUT"
if command -v ccache >/dev/null 2>&1; then
  ccache --show-stats | grep -iE 'hits|misses' | head -3 || true
fi
echo "Done in $((SECONDS - started)) s (install and native project $((prepared - started)) s, Gradle $((built - prepared)) s)."
