import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = join(__dirname, "..", "bin", "sence");
const MOCK_AGENT = join(__dirname, "fixtures", "mock-agent.js");

const SESSION = `sence-test-${process.pid}`;

function tmux(...args) {
  const result = spawnSync("tmux", args, { encoding: "utf-8", timeout: 10_000 });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status };
}

function sleep(ms) {
  spawnSync("sleep", [String(ms / 1000)]);
}

function hasFence() {
  const r = spawnSync("fence", ["--version"], { encoding: "utf-8" });
  if (r.status !== 0) return false;
  // sence requires --fence-log-file, added in fence 0.1.48
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(r.stdout ?? "");
  if (!m) return false;
  const [major, minor, patch] = m.slice(1).map(Number);
  return major > 0 || minor > 1 || (minor === 1 && patch >= 48);
}

function hasTmux() {
  return spawnSync("tmux", ["-V"], { encoding: "utf-8" }).status === 0;
}

function createSession() {
  tmux("new-session", "-d", "-s", SESSION, "-x", "120", "-y", "40");
}

function killSession() {
  tmux("kill-session", "-t", SESSION);
}

function sendKeys(...keys) {
  tmux("send-keys", "-t", SESSION, ...keys);
}

function capturePane() {
  return tmux("capture-pane", "-t", SESSION, "-p", "-J").stdout;
}

function waitForContent(pattern, timeoutMs = 15_000) {
  const start = Date.now();
  let interval = 100;
  while (Date.now() - start < timeoutMs) {
    const content = capturePane();
    if (pattern.test(content)) return content;
    sleep(interval);
    interval = Math.min(interval * 2, 2000);
  }
  return capturePane();
}

describe("interactive: tmux helpers", { skip: !hasTmux() && "tmux not available" }, () => {
  before(() => createSession());
  after(() => killSession());

  it("capturePaneContent captures after command output", () => {
    sendKeys("echo capture-test-marker", "Enter");
    const content = waitForContent(/capture-test-marker/);
    assert.ok(content.includes("capture-test-marker"));
  });
});

describe("interactive: mock agent with ESC interrupt", { skip: !hasTmux() && "tmux not available" }, () => {
  before(() => createSession());
  after(() => killSession());

  it("mock agent responds to ESC by printing resume info", () => {
    // Run mock agent directly (no fence) to verify ESC handling works
    sendKeys(`node ${MOCK_AGENT}`, "Enter");
    sleep(1000);

    // Verify agent is running
    let content = capturePane();
    assert.ok(content.includes("[mock-agent] working"), "agent should be running");

    // Send ESC
    sendKeys("Escape");
    content = waitForContent(/interrupted by user/);
    assert.ok(content.includes("interrupted by user"), "agent should respond to ESC");
    assert.ok(content.includes("to resume: mock-agent --resume"), "should show resume command");
  });
});

function waitForShell(timeoutMs = 10_000) {
  waitForContent(/\$|%|>/, timeoutMs);
  sleep(500);
}

describe("interactive: sence observes denial, user interrupts agent", { skip: (!hasTmux() || !hasFence()) && "tmux or fence not available" }, () => {
  before(() => {
    createSession();
    waitForShell();
  });
  after(() => killSession());

  it("streams log in split pane, and user interrupt yields post-exit audit", () => {
    const cmd = `node ${BIN} --suggest never --interactive -- node ${MOCK_AGENT}`;
    sendKeys(cmd, "Enter");

    // Wait until the split pane tail is visible (streams fence denials).
    waitForContent(/monitor log:/, 15_000);

    // User (test) interrupts the agent with ESC; mock agent prints resume
    // line and exits cleanly. sence then writes audit to stderr and exits.
    sendKeys("Escape");

    const content = waitForContent(/Audit summary/, 20_000);

    assert.ok(
      content.includes("Audit summary"),
      `Expected sence audit output after agent exit, got:\n${content.slice(-500)}`,
    );
    assert.ok(
      content.includes("to resume: mock-agent --resume"),
      `Expected mock agent resume line, got:\n${content.slice(-500)}`,
    );
  });
});
