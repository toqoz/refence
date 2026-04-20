import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function buildFenceArgs({ command, settingsPath, template }) {
  // fd 3 is wired to a pipe by the caller; fence writes monitor/debug logs
  // there while the command's own stdout/stderr stream through fd 1/2.
  const args = ["fence", "-m", "--fence-log-file", "/dev/fd/3"];
  if (settingsPath) {
    args.push("--settings", settingsPath);
  }
  if (template) {
    args.push("--template", template);
  }
  args.push("--", ...command);
  return args;
}

// Stream fence's log fd line-by-line, delivering each line to onLine for
// caller-side bookkeeping. Optionally appends each line to logPath and/or
// mirrors it to process.stderr. Interactive mode must keep stderr off: the
// wrapped TUI would be corrupted by parent writes.
export function teeMonitorLog(stream, onLine, { logPath, stderr = false } = {}) {
  let out = null;
  if (logPath) {
    mkdirSync(dirname(logPath), { recursive: true });
    out = createWriteStream(logPath, { flags: "a" });
  }
  const rl = createInterface({ input: stream });
  rl.on("line", (line) => {
    if (stderr) process.stderr.write(line + "\n");
    if (out) out.write(line + "\n");
    onLine(line);
  });
  rl.on("close", () => {
    if (out) out.end();
  });
  return rl;
}

export function execute({ command, cwd, profile, settingsPath, template, monitor = {} }) {
  return new Promise((resolve) => {
    const args = buildFenceArgs({ command, settingsPath, template });
    const startedAt = new Date().toISOString();

    const child = spawn(args[0], args.slice(1), {
      cwd,
      stdio: ["inherit", "inherit", "inherit", "pipe"],
    });

    const monitorLines = [];
    teeMonitorLog(child.stdio[3], (line) => monitorLines.push(line), monitor);

    let spawnError = null;
    child.on("error", (err) => {
      spawnError = err;
    });

    child.on("close", (code, signal) => {
      const finishedAt = new Date().toISOString();
      if (spawnError) {
        resolve({
          command,
          cwd: cwd ?? process.cwd(),
          exitCode: 127,
          profile: profile ?? "default",
          startedAt,
          finishedAt,
          monitorLog: "",
          spawnError: spawnError.message,
        });
        return;
      }

      const exitCode = code != null ? code : signal ? 128 : 1;
      const execResult = {
        command,
        cwd: cwd ?? process.cwd(),
        exitCode,
        profile: profile ?? "default",
        startedAt,
        finishedAt,
        monitorLog: monitorLines.join("\n"),
        stdout: "",
      };
      if (signal) execResult.signal = signal;
      resolve(execResult);
    });
  });
}
