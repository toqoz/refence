import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { audit, isSignificantDenial } from "../src/auditor.js";

describe("audit", () => {
  it("returns clean summary when no monitor output", () => {
    const result = audit({ exitCode: 0, monitorLog: "" });
    assert.equal(result.status, "success");
    assert.deepEqual(result.deniedFiles, []);
    assert.deepEqual(result.deniedNetwork, []);
    assert.deepEqual(result.suspiciousActions, []);
    assert.deepEqual(result.likelyFailureCauses, []);
  });

  it("parses file-write-create denial from logstream", () => {
    const log =
      "[fence:logstream] 20:22:50 ✗ file-write-create /private/tmp/fence-write-test (touch:21965)";
    const result = audit({ exitCode: 1, monitorLog: log });
    assert.equal(result.deniedFiles.length, 1);
    assert.equal(result.deniedFiles[0].path, "/private/tmp/fence-write-test");
    assert.equal(result.deniedFiles[0].action, "file-write-create");
    assert.equal(result.deniedFiles[0].process, "touch");
  });

  it("parses file path with spaces", () => {
    const log =
      "[fence:logstream] 20:22:50 ✗ file-write-create /Users/alice/My Project/.env (node:12345)";
    const result = audit({ exitCode: 1, monitorLog: log });
    assert.equal(result.deniedFiles.length, 1);
    assert.equal(result.deniedFiles[0].path, "/Users/alice/My Project/.env");
    assert.equal(result.deniedFiles[0].process, "node");
  });

  it("parses network CONNECT denial from http proxy", () => {
    const log =
      "[fence:http] 20:19:39 ✗ CONNECT 403 example.com https://example.com:443 (0s)";
    const result = audit({ exitCode: 56, monitorLog: log });
    assert.equal(result.deniedNetwork.length, 1);
    assert.equal(result.deniedNetwork[0].host, "example.com");
    assert.equal(result.deniedNetwork[0].port, 443);
  });

  it("parses multiple denials", () => {
    const log = [
      "[fence:http] 10:00:00 ✗ CONNECT 403 registry.npmjs.org https://registry.npmjs.org:443 (0s)",
      "[fence:logstream] 10:00:01 ✗ file-read-data /Users/foo/.ssh/config (node:1234)",
      "[fence:http] 10:00:02 ✗ CONNECT 403 api.github.com https://api.github.com:443 (0s)",
    ].join("\n");
    const result = audit({ exitCode: 1, monitorLog: log });
    assert.equal(result.deniedNetwork.length, 2);
    assert.equal(result.deniedFiles.length, 1);
  });

  it("classifies credential paths as high severity", () => {
    const log =
      "[fence:logstream] 10:00:01 ✗ file-read-data /Users/foo/.ssh/config (node:1234)";
    const result = audit({ exitCode: 1, monitorLog: log });
    assert.equal(result.deniedFiles[0].severity, "high");
    assert.equal(result.suspiciousActions.length, 1);
    assert.equal(result.suspiciousActions[0].kind, "credential_access");
  });

  it("classifies .aws paths as high severity", () => {
    const log =
      "[fence:logstream] 10:00:01 ✗ file-read-data /Users/foo/.aws/credentials (node:1234)";
    const result = audit({ exitCode: 1, monitorLog: log });
    assert.equal(result.deniedFiles[0].severity, "high");
    assert.equal(result.suspiciousActions[0].kind, "credential_access");
  });

  it("classifies workspace-adjacent paths as medium severity", () => {
    const log =
      "[fence:logstream] 10:00:01 ✗ file-write-create /tmp/some-file (node:1234)";
    const result = audit({ exitCode: 1, monitorLog: log });
    assert.equal(result.deniedFiles[0].severity, "medium");
  });

  it("sets status to failed when exit code is non-zero", () => {
    const result = audit({ exitCode: 1, monitorLog: "" });
    assert.equal(result.status, "failed");
  });

  it("infers likely failure cause when network denied and exit non-zero", () => {
    const log =
      "[fence:http] 10:00:00 ✗ CONNECT 403 registry.npmjs.org https://registry.npmjs.org:443 (0s)";
    const result = audit({ exitCode: 1, monitorLog: log });
    assert.ok(result.likelyFailureCauses.length > 0);
    assert.ok(
      result.likelyFailureCauses[0].includes("network") ||
        result.likelyFailureCauses[0].includes("egress"),
    );
  });

  it("ignores non-denial lines", () => {
    const log = [
      "[fence] Command: npm install",
      "[fence] Sandbox manager initialized",
      "[fence:http] 10:00:00 ✗ CONNECT 403 example.com https://example.com:443 (0s)",
    ].join("\n");
    const result = audit({ exitCode: 1, monitorLog: log });
    assert.equal(result.deniedNetwork.length, 1);
    assert.equal(result.deniedFiles.length, 0);
  });
});

describe("isSignificantDenial", () => {
  it("returns false for non-denial lines", () => {
    assert.equal(isSignificantDenial("[fence] Command: npm install"), false);
    assert.equal(isSignificantDenial(""), false);
  });

  it("returns true for network CONNECT denials", () => {
    const line =
      "[fence:http] 10:00:00 ✗ CONNECT 403 example.com https://example.com:443 (0s)";
    assert.equal(isSignificantDenial(line), true);
  });

  it("returns true for file read/write denials", () => {
    assert.equal(
      isSignificantDenial(
        "[fence:logstream] 10:00:01 ✗ file-read-data /Users/foo/.ssh/config (node:1234)",
      ),
      true,
    );
    assert.equal(
      isSignificantDenial(
        "[fence:logstream] 10:00:01 ✗ file-write-create /tmp/out (touch:1)",
      ),
      true,
    );
  });

  it("skips network-bind — editors like nvim open a local control socket on startup", () => {
    // Ctrl-G in claude → nvim binds /private/tmp/fence/nvim.<user>/.../nvim.<pid>.0.
    // Without this filter, sence would ESC+kill the agent (and nvim) the moment
    // the editor is launched, leaving the user with a blank/unresponsive TUI.
    const line =
      "[fence:logstream] 22:37:31 ✗ network-bind /private/tmp/fence/nvim.toqoz/eHOjue/nvim.93905.0 (nvim:93905)";
    assert.equal(isSignificantDenial(line), false);
  });
});
