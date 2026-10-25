#!/usr/bin/env node
// Stand-in for `claude -p --input-format stream-json`: one process, one stream-json user message per
// turn. Turn 1 calls a tool; later turns answer with what they received, so a test can tell what each
// turn sent. Each start is counted in FAKE_CLAUDE_STARTS (a file) when set.
import { appendFileSync } from "node:fs";

if (process.env.FAKE_CLAUDE_STARTS) appendFileSync(process.env.FAKE_CLAUDE_STARTS, "start\n");
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
let turns = 0;
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buffer += d;
  let i;
  while ((i = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    const texts = msg.message.content.filter((c) => c.type === "text").map((c) => c.text);
    turns += 1;
    const reply = turns === 1 ? '```json\n{"tool": "snapshot", "input": {}}\n```' : `received ${texts.length} blocks, first: ${texts[0].split("\n")[0]}`;
    out({ type: "system", subtype: "init", model: "fake-model" });
    out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: reply } } });
    out({ type: "result", subtype: "success", result: reply, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: turns > 1 ? 100 : 0 } });
  }
});
process.stdin.on("end", () => process.exit(0));
