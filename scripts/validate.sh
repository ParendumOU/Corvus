#!/bin/sh
# Full validation in the dev container: install, build, then type checks, unit tests and the
# Electron smoke test at the same time (they only read the build), with the time of each phase.
# Ends with "VALIDATION: OK" (exit 0) or "VALIDATION: FAILED" (exit 1).
#
#   docker compose run --rm dev sh scripts/validate.sh
#
# The smoke steps run in CORVUS_SMOKE_SHARDS shares side by side (default one per 4 idle CPUs, at
# most 6, each its own Electron and display; see apps/desktop/src/main/smoke-shard.ts): about
# 3 minutes instead of 14 in one run on an idle 24+ CPU machine.
# CORVUS_SMOKE_TIMEOUT (default 1500) caps each share, as for `pnpm test:smoke`: it only catches a hung run.
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
# The smoke steps are split into CORVUS_SMOKE_SHARDS shares, each its own Electron on its own display.
# More shares than the CPUs can carry make every step slow and the timed ones fail. Idle CPUs: all
# of them minus the 1-minute load average (other containers and builds on the same machine).
cpus="$(nproc 2>/dev/null || echo 4)"
busy="$(awk '{ printf "%d", $1 + 0.5 }' /proc/loadavg 2>/dev/null || echo 0)"
default_shards=$(((cpus - busy) / 4))
[ "$default_shards" -gt 6 ] && default_shards=6
[ "$default_shards" -lt 1 ] && default_shards=1
shards="${CORVUS_SMOKE_SHARDS:-$default_shards}"
echo "[validate] smoke shares: $shards ($cpus CPUs, load $busy)"
k=1
while [ "$k" -le "$shards" ]; do
  (cd apps/desktop && CORVUS_SMOKE_SHARD="$k/$shards" CORVUS_SMOKE_TIMEOUT="${CORVUS_SMOKE_TIMEOUT:-1500}" pnpm test:smoke >"$logs/smoke-$k.log" 2>&1) &
  k=$((k + 1))
done
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
# A smoke run can exit 0 after failed checks: every share's RESULT line is what counts.
cat "$logs"/smoke-*.log >"$logs/smoke.log"
if [ "$(grep -c 'RESULT: "OK"' "$logs/smoke.log")" != "$shards" ]; then
  ok=0
  echo "[validate] smoke FAILED:"
  grep -E "\[smoke\] (FAIL|RESULT)|Error" "$logs/smoke.log" | head -40
fi
grep -c "\[smoke\] PASS" "$logs/smoke.log" | sed 's/^/[validate] smoke checks passed: /'
cp "$logs/smoke.log" apps/desktop/out/smoke-last.log 2>/dev/null || true

[ "$ok" = 1 ] || { echo "VALIDATION: FAILED"; exit 1; }
echo "VALIDATION: OK"
