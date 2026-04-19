import { spawnSync } from "node:child_process";
import { openSync, closeSync } from "node:fs";

const FENCE_LINE_RE = /^\[fence[:\w]*\]/;

export function buildFenceArgs({ command, settingsPath, template, isolateStderr = false }) {
  const args = ["fence", "-m"];
  if (settingsPath) {
    args.push("--settings", settingsPath);
  }
  if (template) {
    args.push("--template", template);
  }
  if (isolateStderr) {
    // Restore child stderr from inherited fd 3 (the real tty), then
    // close fd 3 so the child doesn't leak it. Fence monitor output
    // stays on fd 2 (a pipe the caller reads).
    args.push("--", "sh", "-c", 'exec 2>&3 3>&-; exec "$@"', "sh", ...command);
  } else {
    args.push("--", ...command);
  }
  return args;
}

export function splitStderr(stderr) {
  // Split on \n and \r — programs like curl use \r for progress updates,
  // which can splice fence monitor lines mid-line (e.g. "\r  0  ...[fence:http] ...")
  const segments = stderr.split(/\r?\n|\r/);
  const monitorLines = [];
  const stderrLines = [];

  for (const seg of segments) {
    if (FENCE_LINE_RE.test(seg)) {
      monitorLines.push(seg);
    } else {
      // A segment may contain an embedded fence line after a \r-overwritten prefix
      const idx = seg.indexOf("[fence:");
      if (idx > 0 && FENCE_LINE_RE.test(seg.slice(idx))) {
        monitorLines.push(seg.slice(idx));
        stderrLines.push(seg.slice(0, idx));
      } else {
        stderrLines.push(seg);
      }
    }
  }

  return {
    monitorLog: monitorLines.join("\n"),
    commandStderr: stderrLines.join("\n").trim(),
  };
}

export function hasTty() {
  try {
    const fd = openSync("/dev/tty", "r");
    closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

export function execute({ command, cwd, profile, settingsPath, template }) {
  const ttyAvailable = hasTty();
  const args = buildFenceArgs({ command, settingsPath, template, isolateStderr: ttyAvailable });
  const startedAt = new Date().toISOString();

  // fd 3 = real tty (stderr) so the child can restore its stderr there
  const stdio = ["inherit", "inherit", "pipe"];
  if (ttyAvailable) stdio.push(process.stderr.fd);

  const result = spawnSync(args[0], args.slice(1), {
    cwd,
    stdio,
    maxBuffer: 10 * 1024 * 1024,
  });

  const finishedAt = new Date().toISOString();

  if (result.error) {
    return {
      command,
      cwd: cwd ?? process.cwd(),
      exitCode: 127,
      profile: profile ?? "default",
      startedAt,
      finishedAt,
      monitorLog: "",
      commandStderr: "",
      spawnError: result.error.message,
    };
  }

  const exitCode =
    result.status != null
      ? result.status
      : result.signal
        ? 128
        : 1;

  const stderrStr = result.stderr?.toString("utf-8") ?? "";
  const { monitorLog, commandStderr } = splitStderr(stderrStr);

  // Forward the command's stderr (non-fence lines) to the terminal
  if (commandStderr) {
    process.stderr.write(commandStderr + "\n");
  }

  const execResult = {
    command,
    cwd: cwd ?? process.cwd(),
    exitCode,
    profile: profile ?? "default",
    startedAt,
    finishedAt,
    monitorLog,
    commandStderr,
    stdout: "",
  };

  if (result.signal) {
    execResult.signal = result.signal;
  }

  return execResult;
}
