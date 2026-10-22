#!/bin/sh
# Headless end-to-end smoke test (Linux / Docker dev image). Run `pnpm build` first.
# Starts Electron on a virtual display, drives the BrowserController against a local page,
# renders every internal page and writes screenshots to out/smoke/.
cd "$(dirname "$0")/.." || exit 1
if [ -z "$DISPLAY" ]; then
  Xvfb :99 -screen 0 1400x900x24 >/dev/null 2>&1 &
  XVFB_PID=$!
  export DISPLAY=:99
  sleep 1
fi
export CORVUS_SMOKE_TEST=1
export CORVUS_USER_DATA="${CORVUS_USER_DATA:-$(mktemp -d)}"
OUT="${CORVUS_SMOKE_OUT:-$PWD/out/smoke}"
LOG="$(mktemp)"
# CORVUS_SMOKE_CWS=1 also installs real extensions from the Chrome Web Store (needs network).
TIMEOUT="${CORVUS_SMOKE_TIMEOUT:-240}"
[ "$CORVUS_SMOKE_CWS" = "1" ] && TIMEOUT="${CORVUS_SMOKE_TIMEOUT:-900}"
# require("electron") downloads the binary on first use and prints progress to stdout, so trigger
# the download first and only then read the path.
node -e 'require("electron")' >/dev/null
ELECTRON="$(node -e 'process.stdout.write(require("electron"))')"

# Run with the Chromium sandbox like real installs do: extension service-worker preloads
# (chrome.* APIs from electron-chrome-extensions) never run under --no-sandbox
# (electron/electron#54322). As root that means the setuid helper plus an unprivileged user, and
# the helper needs CAP_SYS_ADMIN for its namespaces: `docker compose run --cap-add SYS_ADMIN ...`.
# Without it the run falls back to --no-sandbox and those checks are reported as SKIP.
CAP_EFF="$(awk '/^CapEff/ {print $2}' /proc/self/status 2>/dev/null)"
HAS_SYS_ADMIN=0
[ -n "$CAP_EFF" ] && [ $(( 0x$CAP_EFF & 0x200000 )) -ne 0 ] && HAS_SYS_ADMIN=1
if [ "$(id -u)" = "0" ] && [ "$HAS_SYS_ADMIN" = "1" ] && id node >/dev/null 2>&1 && [ "${CORVUS_SMOKE_SANDBOX:-1}" = "1" ]; then
  SANDBOX="$(dirname "$ELECTRON")/chrome-sandbox"
  chown root:root "$SANDBOX" && chmod 4755 "$SANDBOX"
  RUN_OUT="$(mktemp -d)"
  RUN_HOME="$(mktemp -d)"
  chmod 777 "$RUN_OUT" "$RUN_HOME" "$CORVUS_USER_DATA"
  export CORVUS_SMOKE_OUT="$RUN_OUT"
  # Docker's default /dev/shm (64 MB) is too small for many renderers: use /tmp instead.
  HOME="$RUN_HOME" timeout "$TIMEOUT" runuser -u node -- "$ELECTRON" out/main/index.js --disable-dev-shm-usage >"$LOG" 2>&1
  status=$?
  mkdir -p "$OUT" && cp -r "$RUN_OUT"/. "$OUT"/ 2>/dev/null
  rm -rf "$RUN_OUT" "$RUN_HOME"
else
  export CORVUS_SMOKE_OUT="$OUT"
  export CORVUS_SMOKE_NO_SANDBOX=1
  timeout "$TIMEOUT" "$ELECTRON" out/main/index.js --no-sandbox --disable-dev-shm-usage >"$LOG" 2>&1
  status=$?
fi
grep -E '^\[(smoke|corvus)\]' "$LOG"
[ -n "$CORVUS_SMOKE_LOG" ] && cp "$LOG" "$CORVUS_SMOKE_LOG"
[ "$status" -ne 0 ] && tail -40 "$LOG"
[ -n "$XVFB_PID" ] && kill "$XVFB_PID" 2>/dev/null
rm -f "$LOG"
exit $status
