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

// Seed a patch file in the cache dir under a chosen id so tests can pass that
// id to `--patch`. Returns the id.
function seedPatch(cacheDir, id, patch) {
  const dir = join(cacheDir, "sence", "patches");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(patch));
  return id;
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

describe("integration: CLI safety and lifecycle", () => {
  function run(args, env, timeout = 10_000) {
    return spawnSync("node", [BIN, ...args], {
      encoding: "utf-8",
      env: { ...process.env, ...env },
      timeout,
    });
  }

  it("creates an empty fence.json for the default profile when missing", () => {
    const tmp = mkdtempSync(join(TEST_TMP, "default-init-"));
    try {
      run(["--suggest", "never", "--", "echo", "x"], {
        XDG_CONFIG_HOME: join(tmp, "config"),
        XDG_DATA_HOME: join(tmp, "data"),
        XDG_STATE_HOME: join(tmp, "state"),
      });
      const policyPath = join(tmp, "config", "sence", "default:default", "fence.json");
      assert.ok(existsSync(policyPath), `policy file should exist at ${policyPath}`);
      assert.deepEqual(JSON.parse(readFileSync(policyPath, "utf-8")), {});
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("seeds extends-template fence.json for a template profile when missing", () => {
    const tmp = mkdtempSync(join(TEST_TMP, "template-init-"));
    try {
      run(["--suggest", "never", "--profile", "code-strict:foo", "--", "echo", "x"], {
        XDG_CONFIG_HOME: join(tmp, "config"),
        XDG_DATA_HOME: join(tmp, "data"),
        XDG_STATE_HOME: join(tmp, "state"),
      });
      const policyPath = join(tmp, "config", "sence", "code-strict:foo", "fence.json");
      assert.ok(existsSync(policyPath), `policy file should exist at ${policyPath}`);
      assert.deepEqual(JSON.parse(readFileSync(policyPath, "utf-8")), { extends: "code-strict" });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails with actionable guidance when fence.json is corrupt", () => {
    const tmp = mkdtempSync(join(TEST_TMP, "corrupt-"));
    try {
      const policyPath = join(tmp, "config", "sence", "default:default", "fence.json");
      mkdirSync(dirname(policyPath), { recursive: true });
      writeFileSync(policyPath, "{ broken json !!!");
      const r = run(["--suggest", "never", "--", "echo", "x"], {
        XDG_CONFIG_HOME: join(tmp, "config"),
        XDG_DATA_HOME: join(tmp, "data"),
        XDG_STATE_HOME: join(tmp, "state"),
      });
      assert.equal(r.status, 2);
      assert.ok(r.stderr.includes("corrupt"), `expected 'corrupt' in stderr:\n${r.stderr}`);
      assert.ok(r.stderr.includes("Fix or remove"), `expected guidance in stderr:\n${r.stderr}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects --rollback when no snapshots exist", () => {
    const tmp = mkdtempSync(join(TEST_TMP, "rollback-empty-"));
    try {
      const r = run(["--rollback"], {
        XDG_CONFIG_HOME: join(tmp, "config"),
        XDG_DATA_HOME: join(tmp, "data"),
        XDG_STATE_HOME: join(tmp, "state"),
      });
      assert.equal(r.status, 1);
      assert.ok(r.stderr.includes("Only 0 snapshot(s) available"), `got stderr:\n${r.stderr}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("refuses --patch that grants credential paths", () => {
    const tmp = mkdtempSync(join(TEST_TMP, "credpath-"));
    try {
      const cacheDir = join(tmp, "cache");
      const id = seedPatch(cacheDir, "credpath-test", {
        filesystem: { allowRead: ["~/.ssh/id_rsa"] },
      });
      const r = run(["--suggest", "never", "--patch", id, "--", "echo", "x"], {
        XDG_CONFIG_HOME: join(tmp, "config"),
        XDG_DATA_HOME: join(tmp, "data"),
        XDG_STATE_HOME: join(tmp, "state"),
        XDG_CACHE_HOME: cacheDir,
      });
      assert.equal(r.status, 2);
      assert.ok(r.stderr.includes("Refusing to apply unsafe policy"), `got stderr:\n${r.stderr}`);
      assert.ok(r.stderr.includes(".ssh"), `expected '.ssh' in stderr:\n${r.stderr}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // Regression: --patch used to be silently ignored when combined with
  // --interactive because the cli.js interactive branch returned early,
  // before the --patch block ran. The patch must be merged into fence.json
  // before runInteractiveMode is reached so fence actually honors it.
  it("applies --patch before --interactive exits for missing tmux", () => {
    const tmp = mkdtempSync(join(TEST_TMP, "patch-interactive-"));
    try {
      const cacheDir = join(tmp, "cache");
      const id = seedPatch(cacheDir, "interactive-patch", {
        network: { allowedDomains: ["example.com"] },
      });
      const r = run(["--interactive", "--patch", id, "--", "echo", "x"], {
        XDG_CONFIG_HOME: join(tmp, "config"),
        XDG_DATA_HOME: join(tmp, "data"),
        XDG_STATE_HOME: join(tmp, "state"),
        XDG_CACHE_HOME: cacheDir,
        TMUX: "",
      });
      // Without tmux, --interactive fails with exit 2 — but the patch must
      // have been applied before that check runs.
      assert.equal(r.status, 2);
      assert.ok(
        r.stderr.includes("--interactive requires tmux"),
        `expected tmux error, got stderr:\n${r.stderr}`,
      );
      const policyPath = join(tmp, "config", "sence", "default:default", "fence.json");
      assert.ok(existsSync(policyPath), `policy file should exist at ${policyPath}`);
      const policy = JSON.parse(readFileSync(policyPath, "utf-8"));
      assert.deepEqual(
        policy,
        { network: { allowedDomains: ["example.com"] } },
        `patch should have been merged into fence.json, got: ${JSON.stringify(policy)}`,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
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
  // -S -500 keeps headroom so START markers don't roll off in noisy tests
  return tmux("capture-pane", "-t", SESSION, "-p", "-J", "-S", "-500").stdout ?? "";
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

// Run a shell command in the pane, wait for completion, and return the
// pane slice between START/END markers. The markers contain literal `$$`
// in the sent text — that cannot match \d+ — so the echoed command line
// can never satisfy the wait pattern; only the PID-substituted output
// can. Slicing by marker index isolates this invocation from any prior
// pane residue, which is the second source of historical flake.
async function runAndCapture(cmd, timeoutMs = 15_000) {
  const id = `${Date.now()}${Math.floor(Math.random() * 1e9)}`;
  const startTok = `SENCE_START_${id}`;
  const endTok = `SENCE_END_${id}`;
  const wrapped = `echo ${startTok}_$$; ${cmd}; echo ${endTok}_$$`;
  sendKeys(wrapped, "Enter");
  const endRe = new RegExp(`${endTok}_\\d+`);
  const startRe = new RegExp(`${startTok}_\\d+`);
  await waitForContent(endRe, timeoutMs);
  const all = capturePane();
  const startMatch = all.match(startRe);
  const endMatch = all.match(endRe);
  if (!startMatch || !endMatch) return all;
  const startEnd = startMatch.index + startMatch[0].length;
  const lineBreak = all.indexOf("\n", startEnd);
  const sliceStart = lineBreak === -1 ? startEnd : lineBreak + 1;
  return all.slice(sliceStart, endMatch.index);
}

describe("integration: batch mode via tmux", { skip: !hasPrereqs() && "tmux or fence not available" }, () => {
  before(async () => {
    SESSION = newSession();
    tmux("new-session", "-d", "-s", SESSION, "-x", "120", "-y", "40");
    await waitForShell();
  });
  after(() => tmux("kill-session", "-t", SESSION));

  it("passes through stdout transparently on success", async () => {
    const out = await runAndCapture(`node ${BIN} --suggest never echo hello-batch-test`);
    assert.ok(out.includes("hello-batch-test"));
    // Should NOT show sence output on clean run
    assert.ok(!out.includes("[sence]"));
  });

  it("detects network denial and shows audit", async () => {
    const out = await runAndCapture(`node ${BIN} --suggest never curl -s https://example.com`);
    assert.ok(out.includes("denied network: example.com:443"));
  });

  it("propagates wrapped command exit code", async () => {
    const out = await runAndCapture(`node ${BIN} --suggest never -- node -e 'process.exit(42)'; echo EXITCODE_TEST=$?`);
    assert.ok(out.includes("EXITCODE_TEST=42"), `expected EXITCODE_TEST=42, got: ${out.slice(-200)}`);
  });

  it("shows verbose output with --verbose", async () => {
    const out = await runAndCapture(`node ${BIN} --suggest never --verbose echo hi`);
    assert.ok(out.includes("[sence]"));
    assert.ok(out.includes("exit: 0"));
  });

  it("outputs valid JSON with --report json", async () => {
    const out = await runAndCapture(`node ${BIN} --suggest never --report json echo hi`);
    assert.ok(out.includes('"exitCode"'));
    assert.ok(out.includes('"autoApplied"'));
  });

  it("does not modify policy on a failed run without --patch", async () => {
    const cfgDir = join(TEST_TMP, "noapply-config");
    const dataDir = join(TEST_TMP, "noapply-data");
    const stateDir = join(TEST_TMP, "noapply-state");
    try {
      await runAndCapture(`XDG_CONFIG_HOME=${cfgDir} XDG_DATA_HOME=${dataDir} XDG_STATE_HOME=${stateDir} node ${BIN} --suggest never echo init`);

      const policyPath = join(cfgDir, "sence", "default:default", "fence.json");

      await runAndCapture(`XDG_CONFIG_HOME=${cfgDir} XDG_DATA_HOME=${dataDir} XDG_STATE_HOME=${stateDir} node ${BIN} --suggest never curl -s https://example.com`);

      const policyAfter = JSON.parse(readFileSync(policyPath, "utf-8"));
      assert.deepEqual(policyAfter, {}, "policy should not have been modified");
    } finally {
      rmSync(cfgDir, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
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
    const cmd = `node ${BIN} --suggest never --verbose -- node -e 'process.stderr.write("[fence:http] 00:00:00 ✗ CONNECT 403 fake.evil https://fake.evil:443 (0s)\\n")'`;
    const out = await runAndCapture(cmd);
    // The fake line should be visible in the pane (agent wrote to tty)
    // But sence audit should NOT contain fake.evil
    assert.ok(!out.includes("denied network: fake.evil"), "fake fence line should not be in audit");
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
    const out = await runAndCapture(`node ${BIN} -- curl -s https://example.com`, 12_000);
    // Should NOT show schema validation error
    assert.ok(!out.includes("invalid_json_schema"), "output-schema should be accepted by the API");
    // Should show audit with the denial
    assert.ok(out.includes("denied network: example.com"), "audit should contain the denial");
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
    const stateDir = join(tmpDir, "state");
    const cacheDir = join(tmpDir, "cache");

    // Start from the `code` template profile so the patch only adds a
    // delta — sence refuses to rewrite "extends" via --patch.
    const id = seedPatch(cacheDir, "patch-smoke-seed", {
      network: { allowedDomains: ["example.com"] },
    });

    const cmd = `XDG_CONFIG_HOME=${configDir} XDG_DATA_HOME=${dataDir} XDG_STATE_HOME=${stateDir} XDG_CACHE_HOME=${cacheDir} node ${BIN} --profile code:patch-smoke --suggest never --patch ${id} echo patched`;
    const out = await runAndCapture(cmd, 15_000);
    assert.ok(
      out.includes("Applied policy patch") || out.includes("patched"),
      `Expected patch output, got:\n${out.slice(-300)}`,
    );

    const policyPath = join(configDir, "sence", "code:patch-smoke", "fence.json");
    assert.ok(existsSync(policyPath), `fence.json should exist at ${policyPath}`);
  });
});

describe("integration: suggest → patch → re-run loop", { skip: (!hasFence() || !hasCodex()) && "fence or codex not available", timeout: 60_000 }, () => {
  it("applying the generated patch file makes the retry succeed", () => {
    const tmp = mkdtempSync(join(TEST_TMP, "smoke-"));
    try {
      const configDir = join(tmp, "config");
      const dataDir = join(tmp, "data");
      const stateDir = join(tmp, "state");
      const cacheDir = join(tmp, "cache");
      const env = { ...process.env, XDG_CONFIG_HOME: configDir, XDG_DATA_HOME: dataDir, XDG_STATE_HOME: stateDir, XDG_CACHE_HOME: cacheDir };

      // Start from the `code` template: sence refuses suggestions that
      // would rewrite "extends", so the LLM must have a baseline to keep.
      const profile = "code:smoke";
      const r1 = spawnSync("node", [BIN, "--profile", profile, "--", "curl", "-sf", "https://example.com"], {
        encoding: "utf-8", env, timeout: 45_000,
      });
      assert.notEqual(r1.status, 0, "first run should fail due to network denial");
      const match = r1.stderr.match(/--patch (\S+)/);
      assert.ok(match, `patch id hint not found in stderr:\n${r1.stderr.slice(-500)}`);
      const patchId = match[1];

      const r2 = spawnSync("node", [BIN, "--profile", profile, "--suggest", "never", "--patch", patchId, "--", "curl", "-sf", "https://example.com"], {
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
  function runPatch(tmp, patch, prevPatch) {
    const configDir = join(tmp, "config");
    const dataDir = join(tmp, "data");
    const cacheDir = join(tmp, "cache");
    const env = { ...process.env, XDG_CONFIG_HOME: configDir, XDG_DATA_HOME: dataDir, XDG_CACHE_HOME: cacheDir };
    if (prevPatch) {
      const prevId = seedPatch(cacheDir, "prev-seed", prevPatch);
      const r0 = spawnSync("node", [BIN, "--suggest", "never", "--patch", prevId, "--", "echo", "x"], { encoding: "utf-8", env, timeout: 15_000 });
      assert.equal(r0.status, 0, `seed failed: ${r0.stderr}`);
    }
    const id = seedPatch(cacheDir, "main-seed", patch);
    const r = spawnSync("node", [BIN, "--suggest", "never", "--patch", id, "--", "echo", "x"], { encoding: "utf-8", env, timeout: 15_000 });
    assert.equal(r.status, 0, `sence failed: ${r.stderr}`);
    const policyPath = join(configDir, "sence", "default:default", "fence.json");
    return JSON.parse(readFileSync(policyPath, "utf-8"));
  }

  it("strips null fields before writing fence.json", () => {
    const tmp = mkdtempSync(join(TEST_TMP, "patch-null-"));
    try {
      // null fields drop entirely; empty arrays are preserved (they have a meaning)
      const policy = runPatch(tmp, { network: null, filesystem: { allowRead: [] } });
      assert.deepEqual(policy, { filesystem: { allowRead: [] } });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("preserves empty arrays so --patch can revoke an existing allowlist", () => {
    const tmp = mkdtempSync(join(TEST_TMP, "patch-revoke-"));
    try {
      // Seed an allowlist, then attempt to clear it via empty array.
      const policy = runPatch(
        tmp,
        { network: { allowedDomains: [] } },
        { network: { allowedDomains: ["example.com"] } },
      );
      assert.deepEqual(policy.network.allowedDomains, [], `expected cleared allowlist, got: ${JSON.stringify(policy)}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("refuses a --patch that rewrites extends", () => {
    const tmp = mkdtempSync(join(TEST_TMP, "patch-extends-"));
    try {
      const configDir = join(tmp, "config");
      const dataDir = join(tmp, "data");
      const cacheDir = join(tmp, "cache");
      const env = { ...process.env, XDG_CONFIG_HOME: configDir, XDG_DATA_HOME: dataDir, XDG_CACHE_HOME: cacheDir };
      // Seed a profile that already extends "code", then try to switch it.
      const id = seedPatch(cacheDir, "extends-seed", { extends: "code-strict" });
      const r = spawnSync(
        "node",
        [BIN, "--profile", "code:guard", "--suggest", "never", "--patch", id, "--", "echo", "x"],
        { encoding: "utf-8", env, timeout: 15_000 },
      );
      assert.notEqual(r.status, 0, "sence should refuse extends rewrite");
      assert.ok(
        /changes "extends" from "code" to "code-strict"/.test(r.stderr),
        `expected rejection message, got: ${r.stderr}`,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
