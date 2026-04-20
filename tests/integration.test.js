import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = join(__dirname, "..", "bin", "sence");
const TEST_TMP = join(__dirname, "tmp");
mkdirSync(TEST_TMP, { recursive: true });

function hasTmux() {
  return spawnSync("tmux", ["-V"], { encoding: "utf-8" }).status === 0;
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

function hasPrereqs() {
  return hasTmux() && hasFence();
}

// Tests that don't need tmux (no fence execution)
describe("integration: CLI basics", () => {
  function sence(args) {
    return spawnSync("node", [BIN, ...args], { encoding: "utf-8", timeout: 10_000 });
  }

  it("shows help with --help", () => {
    const r = sence(["--help"]);
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes("Usage:"));
    assert.ok(r.stdout.includes("--interactive"));
  });

  it("shows error when no command given", () => {
    const r = sence([]);
    assert.equal(r.status, 2);
    assert.ok(r.stderr.includes("No command specified"));
  });

  it("shows error for invalid --suggest value", () => {
    const r = sence(["--suggest", "maybe", "echo"]);
    assert.equal(r.status, 2);
    assert.ok(r.stderr.includes("maybe"));
  });
});

// Tests that need tmux + fence
let sessionCounter = 0;
function newSession() {
  return `sence-integ-${process.pid}-${++sessionCounter}`;
}
let SESSION;

function tmux(...args) {
  return spawnSync("tmux", args, { encoding: "utf-8", timeout: 10_000 });
}

function sendKeys(...keys) {
  tmux("send-keys", "-t", SESSION, ...keys);
}

function capturePane() {
  return tmux("capture-pane", "-t", SESSION, "-p", "-J", "-S", "-100").stdout ?? "";
}

// Use async sleep so SIGTERM / node:test timeout can interrupt the polling loop
async function waitForContent(pattern, timeoutMs = 15_000) {
  const start = Date.now();
  let interval = 100;
  while (Date.now() - start < timeoutMs) {
    const content = capturePane();
    if (pattern.test(content)) return content;
    await delay(interval);
    interval = Math.min(interval * 2, 2000);
  }
  return capturePane();
}

async function waitForShell(timeoutMs = 10_000) {
  await waitForContent(/\$|%|>/, timeoutMs);
  await delay(500);
}

describe("integration: batch mode via tmux", { skip: !hasPrereqs() && "tmux or fence not available" }, () => {
  before(async () => {
    SESSION = newSession();
    tmux("new-session", "-d", "-s", SESSION, "-x", "120", "-y", "40");
    await waitForShell();
  });
  after(() => tmux("kill-session", "-t", SESSION));

  it("passes through stdout transparently on success", async () => {
    sendKeys(`node ${BIN} --suggest never echo hello-batch-test`, "Enter");
    const content = await waitForContent(/hello-batch-test/);
    assert.ok(content.includes("hello-batch-test"));
    // Should NOT show sence output on clean run
    assert.ok(!content.includes("[sence]"));
    await waitForShell();
  });

  it("detects network denial and shows audit", async () => {
    sendKeys(`node ${BIN} --suggest never curl -s https://example.com`, "Enter");
    const content = await waitForContent(/denied network/);
    assert.ok(content.includes("denied network: example.com:443"));
    await waitForShell();
  });

  it("propagates wrapped command exit code", async () => {
    sendKeys(`node ${BIN} --suggest never -- node -e 'process.exit(42)'; echo EXITCODE_TEST=$?`, "Enter");
    const content = await waitForContent(/EXITCODE_TEST=/);
    assert.ok(content.includes("EXITCODE_TEST=42"), `expected EXIT=42, got: ${content.slice(-200)}`);
    await waitForShell();
  });

  it("shows verbose output with --verbose", async () => {
    sendKeys(`node ${BIN} --suggest never --verbose echo hi`, "Enter");
    const content = await waitForContent(/\[sence\]/);
    assert.ok(content.includes("[sence]"));
    assert.ok(content.includes("exit: 0"));
    await waitForShell();
  });

  it("outputs valid JSON with --report json", async () => {
    sendKeys(`node ${BIN} --suggest never --report json echo hi`, "Enter");
    const content = await waitForContent(/exitCode/);
    assert.ok(content.includes('"exitCode"'));
    assert.ok(content.includes('"autoApplied"'));
    await waitForShell();
  });

  it("does not modify policy on a failed run without --patch", async () => {
    const cfgDir = join(TEST_TMP, "noapply-config");
    const dataDir = join(TEST_TMP, "noapply-data");
    // Ensure policy exists
    sendKeys(`XDG_CONFIG_HOME=${cfgDir} XDG_DATA_HOME=${dataDir} node ${BIN} --suggest never echo init; echo INIT_DONE`, "Enter");
    await waitForContent(/INIT_DONE/);
    await waitForShell();

    // Read the policy content
    const policyPath = join(cfgDir, "sence", "default:default", "fence.json");

    // Run a command that fails (denied) — policy should NOT change
    sendKeys(`XDG_CONFIG_HOME=${cfgDir} XDG_DATA_HOME=${dataDir} node ${BIN} --suggest never curl -s https://example.com; echo FAIL_DONE`, "Enter");
    await waitForContent(/FAIL_DONE/);

    // Policy should still be the default (empty object for default:default)
    const policyAfter = JSON.parse(readFileSync(policyPath, "utf-8"));
    assert.deepEqual(policyAfter, {}, "policy should not have been modified");

    // Cleanup
    rmSync(cfgDir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
    await waitForShell();
  });
});

describe("integration: monitor log channel separation", { skip: !hasPrereqs() && "tmux or fence not available" }, () => {
  before(async () => {
    SESSION = newSession();
    tmux("new-session", "-d", "-s", SESSION, "-x", "120", "-y", "40");
    await waitForShell();
  });
  after(() => tmux("kill-session", "-t", SESSION));

  it("fake fence lines from agent do not appear in audit", async () => {
    // Fence log arrives on its own fd via --fence-log-file, so a fake
    // [fence:http] line on the command's stderr reaches the terminal
    // but is never treated as a monitor event.
    const cmd = `node ${BIN} --suggest never --verbose -- node -e 'process.stderr.write("[fence:http] 00:00:00 ✗ CONNECT 403 fake.evil https://fake.evil:443 (0s)\\n")'; echo DONE`;
    sendKeys(cmd, "Enter");
    const content = await waitForContent(/DONE/);
    // The fake line should be visible in the pane (agent wrote to tty)
    // But sence audit should NOT contain fake.evil
    assert.ok(!content.includes("denied network: fake.evil"), "fake fence line should not be in audit");
    await waitForShell();
  });
});

function hasCodex() {
  return spawnSync("codex", ["--version"], { encoding: "utf-8" }).status === 0;
}

describe("integration: suggester via tmux", { skip: (!hasPrereqs() || !hasCodex()) && "tmux, fence, or codex not available", timeout: 20_000 }, () => {
  before(async () => {
    SESSION = newSession();
    tmux("new-session", "-d", "-s", SESSION, "-x", "120", "-y", "40");
    await waitForShell();
  });
  after(() => tmux("kill-session", "-t", SESSION));

  it("generates recommendation when denials occur", { timeout: 15_000 }, async () => {
    sendKeys(`node ${BIN} -- curl -s https://example.com`, "Enter");
    // Wait for suggester to finish — look for the line that always appears at the end
    const content = await waitForContent(/No changes were applied automatically/, 12_000);
    // Should NOT show schema validation error
    assert.ok(!content.includes("invalid_json_schema"), "output-schema should be accepted by the API");
    // Should show audit with the denial
    assert.ok(content.includes("denied network: example.com"), "audit should contain the denial");
    await waitForShell();
  });
});

describe("integration: patch + rollback via tmux", { skip: !hasPrereqs() && "tmux or fence not available" }, () => {
  let tmpDir;

  before(async () => {
    // Use workspace-relative tmp so fence allows writes
    tmpDir = mkdtempSync(join(TEST_TMP, "patch-"));
    SESSION = newSession();
    tmux("new-session", "-d", "-s", SESSION, "-x", "120", "-y", "40");
    await waitForShell();
  });
  after(() => {
    tmux("kill-session", "-t", SESSION);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("applies patch and writes policy", async () => {
    const configDir = join(tmpDir, "config");
    const dataDir = join(tmpDir, "data");
    const patchFile = join(tmpDir, "patch.json");

    writeFileSync(patchFile, JSON.stringify({
      extends: "code-strict",
      network: { allowedDomains: ["example.com"] },
    }, null, 2));

    const cmd = `XDG_CONFIG_HOME=${configDir} XDG_DATA_HOME=${dataDir} node ${BIN} --suggest never --patch ${patchFile} echo patched; echo PATCH_APPLIED_OK`;
    sendKeys(cmd, "Enter");
    const content = await waitForContent(/PATCH_APPLIED_OK/, 15_000);
    assert.ok(
      content.includes("Applied policy patch") || content.includes("patched"),
      `Expected patch output, got:\n${content.slice(-300)}`,
    );

    const policyPath = join(configDir, "sence", "default:default", "fence.json");
    assert.ok(existsSync(policyPath), `fence.json should exist at ${policyPath}`);
  });
});

describe("integration: suggest → patch → re-run loop", { skip: (!hasFence() || !hasCodex()) && "fence or codex not available", timeout: 60_000 }, () => {
  it("applying the generated patch file makes the retry succeed", () => {
    const tmp = mkdtempSync(join(TEST_TMP, "smoke-"));
    try {
      const configDir = join(tmp, "config");
      const dataDir = join(tmp, "data");
      const env = { ...process.env, XDG_CONFIG_HOME: configDir, XDG_DATA_HOME: dataDir };

      const r1 = spawnSync("node", [BIN, "--", "curl", "-sf", "https://example.com"], {
        encoding: "utf-8", env, timeout: 45_000,
      });
      assert.notEqual(r1.status, 0, "first run should fail due to network denial");
      const match = r1.stderr.match(/--patch (\S+\/policy\.json)/);
      assert.ok(match, `patch file hint not found in stderr:\n${r1.stderr.slice(-500)}`);
      const patchFile = match[1];

      const r2 = spawnSync("node", [BIN, "--suggest", "never", "--patch", patchFile, "--", "curl", "-sf", "https://example.com"], {
        encoding: "utf-8", env, timeout: 20_000,
      });
      assert.equal(r2.status, 0, `retry should succeed. stderr:\n${r2.stderr.slice(-500)}`);
      assert.ok(!r2.stderr.includes("denied network: example.com"), "example.com should no longer be denied");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("integration: --patch input normalization", { skip: !hasFence() && "fence not available" }, () => {
  it("strips null and empty fields before writing fence.json", () => {
    const tmp = mkdtempSync(join(TEST_TMP, "patch-null-"));
    try {
      const patchFile = join(tmp, "patch.json");
      writeFileSync(patchFile, JSON.stringify({
        network: null,
        filesystem: { allowRead: [] },
        extends: "code",
      }));
      const configDir = join(tmp, "config");
      const dataDir = join(tmp, "data");
      const r = spawnSync("node", [BIN, "--suggest", "never", "--patch", patchFile, "--", "echo", "x"], {
        encoding: "utf-8",
        env: { ...process.env, XDG_CONFIG_HOME: configDir, XDG_DATA_HOME: dataDir },
        timeout: 15_000,
      });
      assert.equal(r.status, 0, `sence failed: ${r.stderr}`);
      const policyPath = join(configDir, "sence", "default:default", "fence.json");
      const policy = JSON.parse(readFileSync(policyPath, "utf-8"));
      assert.deepEqual(policy, { extends: "code" }, `unexpected fence.json: ${JSON.stringify(policy)}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
