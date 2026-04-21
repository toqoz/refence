import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import { isDenialLine } from "../auditor.js";

const RED = "\x1b[31m";
const RESET = "\x1b[0m";

// Paint every ✗ denial red so the tail pane in interactive mode makes
// blocked operations stand out against fence's informational output.
export function colorizeMonitorLine(line, { color = true } = {}) {
  if (!color) return line;
  if (!isDenialLine(line)) return line;
  return `${RED}${line}${RESET}`;
}

export function runTailMode(path) {
  const color = process.stdout.isTTY === true;
  const child = spawn("tail", ["-F", path], {
    stdio: ["ignore", "pipe", "inherit"],
  });

  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    process.stdout.write(colorizeMonitorLine(line, { color }) + "\n");
  });

  const forward = (sig) => () => {
    if (!child.killed) child.kill(sig);
  };
  process.on("SIGINT", forward("SIGINT"));
  process.on("SIGTERM", forward("SIGTERM"));
  process.on("SIGHUP", forward("SIGHUP"));

  child.on("close", (code, signal) => {
    process.exit(code ?? (signal ? 128 : 0));
  });
}
