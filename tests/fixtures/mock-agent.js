#!/usr/bin/env node

// Mock interactive agent for testing sence --interactive
// - Reads stdin (like an interactive TUI)
// - Attempts network access after a delay (will be denied by fence)
// - Responds to ESC (0x1b) by printing a message and exiting
// - Prints a fake session ID on exit for resume testing

import { createInterface } from "node:readline";
import http from "node:http";

const sessionId = "mock-session-" + Math.random().toString(36).slice(2, 10);

process.stdout.write(`[mock-agent] session: ${sessionId}\n`);
process.stdout.write(`[mock-agent] working...\n`);

// Listen for ESC on stdin
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}
process.stdin.resume();
process.stdin.on("data", (data) => {
  if (data[0] === 0x1b) {
    process.stdout.write(`\n[mock-agent] interrupted by user\n`);
    process.stdout.write(`[mock-agent] to resume: mock-agent --resume ${sessionId}\n`);
    process.exit(0);
  }
});

// After a short delay, try network access (will be denied by fence)
setTimeout(() => {
  process.stdout.write(`[mock-agent] fetching https://example.com...\n`);
  http.get("http://example.com", () => {}).on("error", () => {});
  // Use the HTTPS proxy which fence blocks
  const req = http.request({
    hostname: "example.com",
    port: 443,
    method: "CONNECT",
  });
  req.on("error", () => {});
  req.end();
}, 500);

// Keep running (like a real agent would)
setTimeout(() => {
  process.stdout.write(`[mock-agent] still working...\n`);
}, 3000);

setTimeout(() => {
  process.stdout.write(`[mock-agent] timed out\n`);
  process.stdout.write(`[mock-agent] to resume: mock-agent --resume ${sessionId}\n`);
  process.exit(1);
}, 30000);
