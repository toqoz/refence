import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatText, formatJson } from "../src/reporter.js";

const baseExec = {
  command: ["claude", "-p", "fix tests"],
  exitCode: 1,
  profile: "default",
};

const baseAudit = {
  status: "failed",
  deniedFiles: [{ path: "/Users/foo/.ssh/config", action: "file-read-data", severity: "high" }],
  deniedNetwork: [{ host: "registry.npmjs.org", port: 443, severity: "medium" }],
  suspiciousActions: [{ kind: "credential_access", target: "/Users/foo/.ssh/config", severity: "high" }],
  likelyFailureCauses: ["network egress to registry.npmjs.org was denied"],
};

const baseRec = {
  explanation: "Allow npm registry access for dependency installation.",
  proposedAdditions: [
    { kind: "network.allow", value: "registry.npmjs.org", riskLevel: "low", rationale: "npm install", relatedDenial: "net:registry.npmjs.org:443" },
  ],
  acceptedAdditions: [
    { kind: "network.allow", value: "registry.npmjs.org", riskLevel: "low", rationale: "npm install", relatedDenial: "net:registry.npmjs.org:443" },
  ],
  blockedAdditions: [],
  proposedPolicy: { network: { allowedDomains: ["registry.npmjs.org"] } },
  policyDiff: "--- a/fence.json\n+++ b/fence.json\n@@ ...",
  autoApplied: false,
};

describe("formatText", () => {
  it("includes command, profile, and exit code", () => {
    const text = formatText(baseExec, baseAudit, baseRec);
    assert.ok(text.includes("claude -p fix tests"));
    assert.ok(text.includes("default"));
    assert.ok(text.includes("exit: 1"));
  });

  it("includes denied events in audit summary", () => {
    const text = formatText(baseExec, baseAudit, baseRec);
    assert.ok(text.includes("registry.npmjs.org"));
    assert.ok(text.includes(".ssh/config"));
  });

  it("includes recommendation explanation", () => {
    const text = formatText(baseExec, baseAudit, baseRec);
    assert.ok(text.includes("Allow npm registry access"));
  });

  it("includes policy diff", () => {
    const text = formatText(baseExec, baseAudit, baseRec);
    assert.ok(text.includes("Proposed policy diff:"));
    assert.ok(text.includes("--- a/fence.json"));
  });

  it("states no changes were auto-applied", () => {
    const text = formatText(baseExec, baseAudit, baseRec);
    assert.ok(text.includes("No changes were applied automatically"));
  });

  it("shows error when recommendation failed", () => {
    const errRec = { error: "Failed to parse", autoApplied: false };
    const text = formatText(baseExec, baseAudit, errRec);
    assert.ok(text.includes("Recommendation error: Failed to parse"));
  });

  it("works with clean run (no denials, no recommendation)", () => {
    const cleanAudit = {
      status: "success",
      deniedFiles: [],
      deniedNetwork: [],
      suspiciousActions: [],
      likelyFailureCauses: [],
    };
    const cleanRec = { autoApplied: false };
    const text = formatText({ ...baseExec, exitCode: 0 }, cleanAudit, cleanRec);
    assert.ok(text.includes("exit: 0"));
    assert.ok(!text.includes("Recommendation:"));
  });

  it("lists accepted additions with risk and rationale", () => {
    const text = formatText(baseExec, baseAudit, baseRec);
    assert.ok(text.includes("Proposed additions:"));
    assert.ok(text.includes("[low] network.allow registry.npmjs.org"));
    assert.ok(text.includes("npm install"));
  });

  it("surfaces blocked additions with their block reason", () => {
    const rec = {
      ...baseRec,
      acceptedAdditions: [],
      blockedAdditions: [
        { kind: "filesystem.allowRead", value: "~/.ssh", blockReason: "credential path: ~/.ssh" },
      ],
      proposedPolicy: undefined,
      policyDiff: "",
    };
    const text = formatText(baseExec, baseAudit, rec);
    assert.ok(text.includes("Blocked by sence safety rules"));
    assert.ok(text.includes("filesystem.allowRead ~/.ssh"));
    assert.ok(text.includes("credential path"));
  });
});

describe("formatJson", () => {
  it("returns valid JSON with all sections", () => {
    const json = formatJson(baseExec, baseAudit, baseRec);
    const parsed = JSON.parse(json);
    assert.deepEqual(parsed.execution.command, ["claude", "-p", "fix tests"]);
    assert.equal(parsed.execution.exitCode, 1);
    assert.equal(parsed.audit.status, "failed");
    assert.equal(parsed.recommendation.autoApplied, false);
  });
});
