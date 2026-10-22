#!/bin/sh
# Marketing screenshots (Linux / Docker dev image). Run `pnpm -r build` first.
# Starts Corvus on a virtual display sized to the window at 2x, with a fresh profile, and lets
# src/main/capture-marketing.ts play a scripted scenario. Frames + manifest.json land in
# out/marketing/ (CORVUS_CAPTURE_OUT). CORVUS_CAPTURE_LANG=es|et records the localized task.
cd "$(dirname "$0")/.." || exit 1

SCALE="${CORVUS_CAPTURE_SCALE:-2}"
WIDTH=1600
HEIGHT=1000

# The UI is designed for Inter / JetBrains Mono; the demo pages use EB Garamond and Charis SIL.
# Debian packages are downloaded once into out/.capture-fonts and reused on later runs.
FONT_CACHE="$PWD/out/.capture-fonts"
FONT_PACKAGES="fonts-inter fonts-jetbrains-mono fonts-ebgaramond fonts-sil-charis"
if [ ! -f "$FONT_CACHE/.complete" ]; then
  rm -rf "$FONT_CACHE" && mkdir -p "$FONT_CACHE/deb" "$FONT_CACHE/files"
  (cd "$FONT_CACHE/deb" && apt-get update -qq >/dev/null && apt-get download $FONT_PACKAGES >/dev/null) || {
    echo "[capture] could not download fonts ($FONT_PACKAGES)" >&2
    exit 1
  }
  for deb in "$FONT_CACHE"/deb/*.deb; do dpkg-deb -x "$deb" "$FONT_CACHE/files"; done
  touch "$FONT_CACHE/.complete"
fi
mkdir -p /usr/local/share/fonts/corvus-capture
find "$FONT_CACHE/files" -type f \( -name '*.ttf' -o -name '*.otf' \) -exec cp {} /usr/local/share/fonts/corvus-capture/ \;
fc-cache -f >/dev/null 2>&1

if [ -z "$DISPLAY" ]; then
  Xvfb :97 -screen 0 "$((WIDTH * SCALE))x$((HEIGHT * SCALE))x24" -nolisten tcp >/dev/null 2>&1 &
  XVFB_PID=$!
  export DISPLAY=:97
  sleep 1
fi

export CORVUS_CAPTURE=1
export CORVUS_CAPTURE_WIDTH="$WIDTH"
export CORVUS_CAPTURE_HEIGHT="$HEIGHT"
export CORVUS_USER_DATA="$(mktemp -d)"
LANG_SUFFIX=""
[ -n "$CORVUS_CAPTURE_LANG" ] && [ "$CORVUS_CAPTURE_LANG" != "en" ] && LANG_SUFFIX="-$CORVUS_CAPTURE_LANG"
export CORVUS_CAPTURE_OUT="${CORVUS_CAPTURE_OUT:-$PWD/out/marketing$LANG_SUFFIX}"
export CORVUS_CAPTURE_FIXTURES="$PWD/capture/fixtures"
rm -rf "$CORVUS_CAPTURE_OUT"
LOG="$(mktemp)"

node -e 'require("electron")' >/dev/null
ELECTRON="$(node -e 'process.stdout.write(require("electron"))')"
timeout "${CORVUS_CAPTURE_TIMEOUT:-240}" "$ELECTRON" out/main/index.js --no-sandbox --disable-dev-shm-usage \
  --force-device-scale-factor="$SCALE" --lang=en-US >"$LOG" 2>&1
status=$?

grep -E '^\[(capture|corvus)\]' "$LOG"
[ -n "$CORVUS_CAPTURE_LOG" ] && cp "$LOG" "$CORVUS_CAPTURE_LOG"
[ "$status" -ne 0 ] && tail -40 "$LOG"
[ -n "$XVFB_PID" ] && kill "$XVFB_PID" 2>/dev/null
rm -rf "$LOG" "$CORVUS_USER_DATA"
exit $status
