import { spawnSync } from "node:child_process";

export function isInsideTmux() {
  return !!process.env.TMUX;
}

export function currentPane() {
  if (!isInsideTmux()) return null;
  const result = spawnSync("tmux", ["display-message", "-p", "#{pane_id}"], {
    encoding: "utf-8",
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

export function capturePaneContent(pane, { lines = 300 } = {}) {
  if (!pane) return "";
  const result = spawnSync(
    "tmux",
    ["capture-pane", "-t", pane, "-p", "-J", "-S", `-${lines}`],
    { encoding: "utf-8" },
  );
  return result.status === 0 ? result.stdout : "";
}

// Split the target pane vertically (new pane below), run `command` in it, and
// return the new pane's id. Keeps focus on the original pane (-d).
export function openSplitPane({ target, command, size = "8" }) {
  if (!isInsideTmux() || !target) return null;
  const result = spawnSync(
    "tmux",
    [
      "split-window",
      "-v",
      "-l",
      size,
      "-d",
      "-t",
      target,
      "-P",
      "-F",
      "#{pane_id}",
      command,
    ],
    { encoding: "utf-8" },
  );
  return result.status === 0 ? result.stdout.trim() : null;
}

export function killPane(paneId) {
  if (!paneId) return false;
  return spawnSync("tmux", ["kill-pane", "-t", paneId]).status === 0;
}
