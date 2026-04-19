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
  return spawnSync("fence", ["--version"], { encoding: "utf-8" }).status === 0;
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

function sendLiteral(text) {
  tmux("send-keys", "-t", SESSION, "-l", text);
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

  it("prefillInput places text in pane without executing", () => {
    sendLiteral("echo should-not-run");
    sleep(300);
    const content = capturePane();
    assert.ok(content.includes("echo should-not-run"), "text should appear in pane");
    // Verify it was NOT executed (no output line with just "should-not-run")
    const lines = content.split("\n").map((l) => l.trim());
    const outputLines = lines.filter((l) => l === "should-not-run");
    assert.equal(outputLines.length, 0, "command should not have been executed");
    sendKeys("C-c");
    sleep(200);
  });

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

describe("interactive: sence monitors denial and interrupts mock agent", { skip: (!hasTmux() || !hasFence()) && "tmux or fence not available" }, () => {
  before(() => {
    createSession();
    waitForShell();
  });
  after(() => killSession());

  it("detects denial, sends ESC, kills process, shows audit", () => {
    const cmd = `node ${BIN} --suggest never --interactive -- node ${MOCK_AGENT}`;
    sendKeys(cmd, "Enter");

    // Wait for the full flow: agent starts → denial → ESC → kill → audit
    const content = waitForContent(/interrupted by user|Analyzing|Suggester/, 20_000);

    assert.ok(
      content.includes("interrupted by user") ||
        content.includes("[sence]"),
      `Expected agent interruption or sence output, got:\n${content.slice(-500)}`,
    );
  });

  it("mock agent shows resume command after ESC", () => {
    // The previous test's output should still be in the pane
    const content = capturePane();
    assert.ok(
      content.includes("to resume: mock-agent --resume"),
      `Expected resume command from mock agent, got:\n${content.slice(-500)}`,
    );
  });
});
