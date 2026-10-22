#!/usr/bin/env node
// Committed shim so pnpm can link the bin before `dist/` is built.
import("../dist/cli.js").catch((err) => {
  if (err && err.code === "ERR_MODULE_NOT_FOUND") {
    process.stderr.write("corvus-search: run `pnpm --filter @corvus/ai-engine build` first\n");
    process.exit(1);
  }
  throw err;
});
