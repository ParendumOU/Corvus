#!/bin/sh
# Full validation in the dev container: install, build, then type checks, unit tests and the
# Electron smoke test at the same time (they only read the build), with the time of each phase.
# Ends with "VALIDATION: OK" (exit 0) or "VALIDATION: FAILED" (exit 1).
#
#   docker compose run --rm dev sh scripts/validate.sh
#
# CORVUS_SMOKE_TIMEOUT (default 600) caps the smoke run, as for `pnpm test:smoke`.
set -u
cd "$(dirname "$0")/.." || exit 1
t0=$(date +%s)
stamp() { echo "[validate] $1 ($(($(date +%s) - t0)) s)"; }
fail() {
  echo "[validate] $1"
  echo "VALIDATION: FAILED"
  exit 1
}

pnpm install --frozen-lockfile || fail "install failed"
# A fresh node_modules volume has no Electron binary until its install script runs.
for script in node_modules/.pnpm/electron@*/node_modules/electron/install.js; do
  [ -f "$script" ] && node "$script" >/dev/null 2>&1
done
stamp "installed"

pnpm -r build || fail "build failed"
pnpm --filter @corvus/mcp-server bundle:bridge >/dev/null || fail "bridge bundle failed"
stamp "built"

logs=$(mktemp -d)
(pnpm -r typecheck >"$logs/typecheck.log" 2>&1; echo $? >"$logs/typecheck.rc") &
(pnpm -r test >"$logs/test.log" 2>&1; echo $? >"$logs/test.rc") &
(cd apps/desktop && CORVUS_SMOKE_TIMEOUT="${CORVUS_SMOKE_TIMEOUT:-600}" pnpm test:smoke >"$logs/smoke.log" 2>&1; echo $? >"$logs/smoke.rc") &
wait
stamp "checks done"

ok=1
if [ "$(cat "$logs/typecheck.rc")" != "0" ]; then
  ok=0
  echo "[validate] typecheck FAILED:"
  grep -E "error TS|ERR_PNPM" "$logs/typecheck.log" | head -40
fi
if [ "$(cat "$logs/test.rc")" != "0" ]; then
  ok=0
  echo "[validate] unit tests FAILED:"
  grep -E "FAIL|×|AssertionError|Error:|ERR_PNPM" "$logs/test.log" | head -60
fi
# vitest colours its summary, so strip the colour codes before looking for it.
sed 's/\x1b\[[0-9;]*m//g' "$logs/test.log" | grep -E "Tests +[0-9]" | sed 's/^ */[validate] /'
# The smoke run can exit 0 after failed checks: its RESULT line is what counts.
if ! grep -q 'RESULT: "OK"' "$logs/smoke.log"; then
  ok=0
  echo "[validate] smoke FAILED:"
  grep -E "\[smoke\] (FAIL|RESULT)|Error" "$logs/smoke.log" | head -40
fi
grep -c "\[smoke\] PASS" "$logs/smoke.log" | sed 's/^/[validate] smoke checks passed: /'
cp "$logs/smoke.log" apps/desktop/out/smoke-last.log 2>/dev/null || true

[ "$ok" = 1 ] || { echo "VALIDATION: FAILED"; exit 1; }
echo "VALIDATION: OK"
