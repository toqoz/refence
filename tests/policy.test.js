import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  resolvePolicyPath,
  resolveSnapshotDir,
  readPolicy,
  ensurePolicy,
  writePolicy,
  diffPolicy,
  mergePolicy,
  listSnapshots,
  rollbackPolicy,
  validatePolicy,
  resolveProfileName,
  defaultPolicyForProfile,
} from "../src/policy.js";

describe("resolvePolicyPath", () => {
  it("resolves to <configDir>/sence/<profile>/fence.json", () => {
    const path = resolvePolicyPath({ configDir: "/home/user/.config", profile: "default" });
    assert.equal(path, "/home/user/.config/sence/default/fence.json");
  });
});

describe("resolveSnapshotDir", () => {
  it("resolves to <dataDir>/sence/<profile>/snapshots", () => {
    const path = resolveSnapshotDir({ dataDir: "/home/user/.local/share", profile: "default" });
    assert.equal(path, "/home/user/.local/share/sence/default/snapshots");
  });
});

describe("readPolicy", () => {
  let tmpDir;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), "sence-test-")); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it("returns null when file does not exist", () => {
    assert.equal(readPolicy(join(tmpDir, "nonexistent.json")), null);
  });

  it("throws on corrupt JSON", () => {
    const path = join(tmpDir, "fence.json");
    writeFileSync(path, "{ broken json !!!");
    assert.throws(() => readPolicy(path));
  });

  it("reads existing fence.json", () => {
    const path = join(tmpDir, "fence.json");
    const expected = { network: { allowedDomains: ["example.com"] } };
    writeFileSync(path, JSON.stringify(expected, null, 2));
    assert.deepEqual(readPolicy(path), expected);
  });
});

describe("ensurePolicy", () => {
  let tmpDir;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), "sence-test-")); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it("creates policy with given defaultPolicy when file does not exist", () => {
    const path = join(tmpDir, "sub", "fence.json");
    const defaultPolicy = { extends: "code" };
    const policy = ensurePolicy(path, { defaultPolicy });
    assert.deepEqual(policy, defaultPolicy);
    assert.deepEqual(readPolicy(path), defaultPolicy);
  });

  it("creates empty policy when defaultPolicy is empty", () => {
    const path = join(tmpDir, "sub2", "fence.json");
    const policy = ensurePolicy(path, { defaultPolicy: {} });
    assert.deepEqual(policy, {});
  });

  it("snapshots defaultPolicy when snapshotDir provided", () => {
    const path = join(tmpDir, "sub3", "fence.json");
    const sDir = join(tmpDir, "snaps");
    ensurePolicy(path, { snapshotDir: sDir, defaultPolicy: { extends: "code-strict" } });
    assert.equal(listSnapshots(sDir).length, 1);
  });

  it("returns existing policy regardless of defaultPolicy", () => {
    const path = join(tmpDir, "fence.json");
    writeFileSync(path, JSON.stringify({ v: 1 }));
    assert.deepEqual(ensurePolicy(path, { defaultPolicy: { extends: "code" } }), { v: 1 });
  });
});

describe("writePolicy + snapshots", () => {
  let tmpDir, sDir;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sence-test-"));
    sDir = join(tmpDir, "snapshots");
  });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it("writes policy and creates a snapshot", () => {
    const path = join(tmpDir, "fence.json");
    writePolicy(path, { v: 1 }, { snapshotDir: sDir });
    assert.deepEqual(readPolicy(path), { v: 1 });
    assert.equal(listSnapshots(sDir).length, 1);
  });

  it("creates a snapshot for each write", () => {
    const path = join(tmpDir, "fence.json");
    writePolicy(path, { v: 1 }, { snapshotDir: sDir });
    writePolicy(path, { v: 2 }, { snapshotDir: sDir });
    writePolicy(path, { v: 3 }, { snapshotDir: sDir });
    assert.equal(listSnapshots(sDir).length, 3);
  });
});

describe("rollback", () => {
  let tmpDir, sDir;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sence-test-"));
    sDir = join(tmpDir, "snapshots");
  });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it("rolls back to previous snapshot", () => {
    const path = join(tmpDir, "fence.json");
    writePolicy(path, { v: 1 }, { snapshotDir: sDir });
    writePolicy(path, { v: 2 }, { snapshotDir: sDir });
    writePolicy(path, { v: 3 }, { snapshotDir: sDir });
    // snapshots: [v:3, v:2, v:1], rollback 1 → v:2
    const result = rollbackPolicy(path, { snapshotDir: sDir });
    assert.ok(!result.error);
    assert.equal(readPolicy(path).v, 2);
  });

  it("rolls back multiple steps", () => {
    const path = join(tmpDir, "fence.json");
    writePolicy(path, { v: 1 }, { snapshotDir: sDir });
    writePolicy(path, { v: 2 }, { snapshotDir: sDir });
    writePolicy(path, { v: 3 }, { snapshotDir: sDir });
    const result = rollbackPolicy(path, { snapshotDir: sDir, steps: 2 });
    assert.ok(!result.error);
    assert.equal(readPolicy(path).v, 1);
  });

  it("repeated rollback stays at the same point", () => {
    const path = join(tmpDir, "fence.json");
    writePolicy(path, { v: 1 }, { snapshotDir: sDir });
    writePolicy(path, { v: 2 }, { snapshotDir: sDir });
    writePolicy(path, { v: 3 }, { snapshotDir: sDir });
    rollbackPolicy(path, { snapshotDir: sDir }); // → v:2
    assert.equal(readPolicy(path).v, 2);
    rollbackPolicy(path, { snapshotDir: sDir }); // → v:2 (same snapshots, no new entry)
    assert.equal(readPolicy(path).v, 2);
  });

  it("returns error when not enough snapshots", () => {
    const path = join(tmpDir, "fence.json");
    writePolicy(path, { v: 1 }, { snapshotDir: sDir });
    // only 1 snapshot, can't go back
    const result = rollbackPolicy(path, { snapshotDir: sDir });
    assert.ok(result.error);
  });

  it("can rollback the first patch to initial policy", () => {
    const path = join(tmpDir, "fence.json");
    const initPolicy = { extends: "code" };
    // Simulate: ensurePolicy creates initial + snapshot, then user patches
    ensurePolicy(path, { snapshotDir: sDir, defaultPolicy: initPolicy });
    writePolicy(path, { extends: "code", network: { allowedDomains: ["example.com"] } }, { snapshotDir: sDir });
    // snapshots: [patched, initial], rollback 1 → initial
    const result = rollbackPolicy(path, { snapshotDir: sDir });
    assert.ok(!result.error);
    assert.deepEqual(readPolicy(path), initPolicy);
  });
});

describe("resolveProfileName", () => {
  it("passes through names containing colon", () => {
    assert.equal(resolveProfileName("code:npm-i"), "code:npm-i");
    assert.equal(resolveProfileName("code-strict:build"), "code-strict:build");
    assert.equal(resolveProfileName("default:myproj"), "default:myproj");
  });

  it("prepends default: to names without colon", () => {
    assert.equal(resolveProfileName("default"), "default:default");
    assert.equal(resolveProfileName("strict"), "default:strict");
    assert.equal(resolveProfileName("my-project"), "default:my-project");
  });
});

describe("defaultPolicyForProfile", () => {
  it("returns { extends: template } for <template>:<name>", () => {
    assert.deepEqual(defaultPolicyForProfile("code:npm-i"), { extends: "code" });
    assert.deepEqual(defaultPolicyForProfile("code-strict:build"), { extends: "code-strict" });
    assert.deepEqual(defaultPolicyForProfile("code-relaxed:dev"), { extends: "code-relaxed" });
    assert.deepEqual(defaultPolicyForProfile("local-dev-server:app"), { extends: "local-dev-server" });
  });

  it("returns empty policy for default:<name>", () => {
    assert.deepEqual(defaultPolicyForProfile("default:default"), {});
    assert.deepEqual(defaultPolicyForProfile("default:experiment"), {});
    assert.deepEqual(defaultPolicyForProfile("default:test"), {});
  });

  it("throws for unknown template in <template>:<name>", () => {
    assert.throws(
      () => defaultPolicyForProfile("evil-template:foo"),
      /unknown fence template/,
    );
  });

  it("throws for unknown template even with multiple colons", () => {
    assert.throws(
      () => defaultPolicyForProfile("evil:something:else"),
      /unknown fence template/,
    );
  });
});

describe("validatePolicy", () => {
  it("accepts safe policy", () => {
    const errors = validatePolicy({ network: { allowedDomains: ["example.com"] } });
    assert.equal(errors.length, 0);
  });

  it("rejects policy allowing .ssh read", () => {
    const errors = validatePolicy({ filesystem: { allowRead: ["~/.ssh"] } });
    assert.ok(errors.length > 0);
    assert.ok(errors[0].includes(".ssh"));
  });

  it("rejects policy allowing .aws write", () => {
    const errors = validatePolicy({ filesystem: { allowWrite: ["~/.aws"] } });
    assert.ok(errors.length > 0);
  });

  it("rejects broad home glob ~/**", () => {
    const errors = validatePolicy({ filesystem: { allowRead: ["~/**"] } });
    assert.ok(errors.length > 0);
    assert.ok(errors[0].includes("glob too broad"));
  });

  it("rejects broad home glob ~/*", () => {
    const errors = validatePolicy({ filesystem: { allowWrite: ["~/*"] } });
    assert.ok(errors.length > 0);
  });

  it("rejects ~/.config/** glob", () => {
    const errors = validatePolicy({ filesystem: { allowRead: ["~/.config/**"] } });
    assert.ok(errors.length > 0);
  });

  it("accepts narrow workspace paths", () => {
    const errors = validatePolicy({ filesystem: { allowRead: [".", "./src"], allowWrite: [".", "/tmp"] } });
    assert.equal(errors.length, 0);
  });

  it("rejects .docker path", () => {
    const errors = validatePolicy({ filesystem: { allowRead: ["~/.docker"] } });
    assert.ok(errors.length > 0);
  });

  it("rejects .netrc path", () => {
    const errors = validatePolicy({ filesystem: { allowWrite: ["~/.netrc"] } });
    assert.ok(errors.length > 0);
  });

  it("rejects absolute single-level home glob /Users/alice/*", () => {
    const errors = validatePolicy({ filesystem: { allowRead: ["/Users/alice/*"] } });
    assert.ok(errors.length > 0);
    assert.ok(errors[0].includes("glob too broad"));
  });

  it("rejects absolute single-level home glob /home/user/*", () => {
    const errors = validatePolicy({ filesystem: { allowRead: ["/home/user/*"] } });
    assert.ok(errors.length > 0);
  });

  it("rejects unknown extends template", () => {
    const errors = validatePolicy({ extends: "my-permissive-template" });
    assert.ok(errors.length > 0);
    assert.ok(errors[0].includes("unknown extends"));
  });

  it("accepts known extends templates", () => {
    for (const t of ["code", "code-strict", "code-relaxed", "local-dev-server"]) {
      const errors = validatePolicy({ extends: t });
      assert.equal(errors.length, 0, `${t} should be allowed`);
    }
  });

  it("rejects network wildcard *", () => {
    const errors = validatePolicy({ network: { allowedDomains: ["*"] } });
    assert.ok(errors.length > 0);
    assert.ok(errors[0].includes("wildcard"));
  });

  it("accepts specific network domains", () => {
    const errors = validatePolicy({ network: { allowedDomains: ["registry.npmjs.org", "*.npmjs.org"] } });
    assert.equal(errors.length, 0);
  });

  it("rejects every credential path in CREDENTIAL_PATTERNS", () => {
    const paths = [
      "~/.ssh/id_rsa", "~/.aws/credentials", "~/.gnupg/secring.gpg",
      "~/.config/gcloud/credentials.json", "~/.kube/config",
      "~/.docker/config.json", "~/.config/gh/hosts.yml",
      "~/.netrc", "~/.git-credentials", "~/.pypirc",
      "~/.cargo/credentials", "~/.cargo/credentials.toml",
      "/Users/test/Library/Keychains/login.keychain",
    ];
    for (const p of paths) {
      const errors = validatePolicy({ filesystem: { allowRead: [p] } });
      assert.ok(errors.length > 0, `should reject: ${p}`);
    }
  });
});

describe("mergePolicy", () => {
  it("merges patch fields into base", () => {
    const base = { extends: "code-strict", network: { allowedDomains: ["a.com"] } };
    const patch = { network: { allowedDomains: ["a.com", "b.com"] } };
    const result = mergePolicy(base, patch);
    assert.deepEqual(result, { extends: "code-strict", network: { allowedDomains: ["a.com", "b.com"] } });
  });

  it("preserves base fields not in patch", () => {
    const base = { extends: "code-strict", filesystem: { allowRead: ["."] }, network: { allowedDomains: ["a.com"] } };
    const patch = { network: { allowedDomains: ["a.com", "b.com"] } };
    const result = mergePolicy(base, patch);
    assert.deepEqual(result.filesystem, { allowRead: ["."] });
    assert.equal(result.extends, "code-strict");
  });

  it("replaces arrays instead of concatenating", () => {
    const base = { filesystem: { allowRead: [".", "./src"] } };
    const patch = { filesystem: { allowRead: [".", "./src", "./lib"] } };
    const result = mergePolicy(base, patch);
    assert.deepEqual(result.filesystem.allowRead, [".", "./src", "./lib"]);
  });

  it("adds new nested fields", () => {
    const base = { extends: "code-strict" };
    const patch = { network: { allowedDomains: ["example.com"] } };
    const result = mergePolicy(base, patch);
    assert.deepEqual(result, { extends: "code-strict", network: { allowedDomains: ["example.com"] } });
  });

  it("replaces primitives", () => {
    const base = { extends: "code-strict" };
    const patch = { extends: "code-relaxed" };
    const result = mergePolicy(base, patch);
    assert.equal(result.extends, "code-relaxed");
  });
});

describe("diffPolicy", () => {
  it("returns empty string when policies are identical", () => {
    const policy = { network: { allowedDomains: ["example.com"] } };
    assert.equal(diffPolicy(policy, policy), "");
  });

  it("returns unified diff when policies differ", () => {
    const before = { network: { allowedDomains: [] } };
    const after = { network: { allowedDomains: ["registry.npmjs.org"] } };
    const diff = diffPolicy(before, after);
    assert.ok(diff.includes("registry.npmjs.org"));
  });
});
