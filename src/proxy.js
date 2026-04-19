// refence --proxy -- <command...>
// Runs inside fence sandbox. Opens /dev/tty for the agent so its I/O
// goes directly to the terminal, keeping fence's stderr pipe clean
// for monitor-only output.

import { spawn } from "node:child_process";

export function runProxy(command) {
  if (command.length === 0) {
    process.stderr.write("[refence proxy] No command specified.\n");
    process.exit(2);
  }

  // Redirect only stderr to /dev/tty via shell exec so the child
  // process sees a normal TTY fd on stderr (not a dup'd fd from
  // Node.js openSync, which breaks Bun's kqueue-based TTY init).
  const child = spawn("/bin/sh", ["-c", 'exec 2>/dev/tty; exec "$@"', "sh", ...command], {
    stdio: "inherit",
  });

  // Forward signals to child
  const forwardSignal = (sig) => child.kill(sig);
  process.on("SIGINT", () => forwardSignal("SIGINT"));
  process.on("SIGTERM", () => forwardSignal("SIGTERM"));
  process.on("SIGWINCH", () => forwardSignal("SIGWINCH"));

  child.on("exit", (code, signal) => {
    process.exit(code ?? (signal ? 128 : 1));
  });
}
