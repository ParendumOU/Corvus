#!/usr/bin/env node
// Stand-in for the `claude` binary: checks the flags, echoes stdin size, replays a stream-json fixture.
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const required = ["-p", "--output-format", "stream-json", "--verbose", "--tools", "--system-prompt"];
for (const flag of required) {
  if (!args.includes(flag)) {
    process.stderr.write(`missing flag ${flag}\n`);
    process.exit(3);
  }
}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  if (!input.includes("query:")) {
    process.stderr.write("prompt not received on stdin\n");
    process.exit(4);
  }
  if (process.env.FAKE_CLAUDE_MODE === "error") {
    process.stdout.write(
      JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "Not logged in" }) + "\n",
    );
    process.exit(1);
  }
  if (process.env.FAKE_CLAUDE_MODE === "crash") {
    process.stderr.write("boom\n");
    process.exit(2);
  }
  const fixture = readFileSync(new URL("./claude-stream.jsonl", import.meta.url), "utf8");
  // Write in odd-sized chunks to exercise line reassembly.
  let i = 0;
  const step = () => {
    if (i >= fixture.length) return;
    process.stdout.write(fixture.slice(i, i + 97));
    i += 97;
    setImmediate(step);
  };
  step();
});
