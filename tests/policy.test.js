import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, existsSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  resolvePolicyPath,
  resolveSnapshotDir,
  resolvePatchDir,
  resolvePatchPath,
  slugify,
  writePatchToCache,
  readPolicy,
  ensurePolicy,
  writePolicy,
  diffPolicy,
  mergePolicy,
  stripNulls,
  listSnapshots,
  rollbackPolicy,
  validatePolicy,
  resolveProfileName,
  resolveStateKey,
  defaultPolicyForProfile,
  assertExtendsImmutable,
  additionsToPatch,
  assessAddition,
  normalizeAdditionValue,
} from "../src/policy.js";

describe("resolvePolicyPath", () => {
  it("resolves to <configDir>/sence/<profile>/fence.json for 2-component profile", () => {
    const path = resolvePolicyPath({ configDir: "/home/user/.config", profile: "default:default" });
    assert.equal(path, "/home/user/.config/sence/default:default/fence.json");
  });

  it("resolves to <config-dir>/fence.json (flat) for 3-component profile", () => {
    const path = resolvePolicyPath({ configDir: "/home/user/.config", profile: "code:foo:/tmp/ws" });
    assert.equal(path, "/tmp/ws/fence.json");
  });

  it("throws if 3-component config-dir is not absolute (caller must resolveProfileName first)", () => {
    assert.throws(
      () => resolvePolicyPath({ configDir: "/home/user/.config", profile: "code:foo:./ws" }),
      /not absolute/,
    );
  });
});

describe("resolveSnapshotDir", () => {
  it("resolves to <stateDir>/sence/<profile>/snapshots for 2-component profile", () => {
    const path = resolveSnapshotDir({ stateDir: "/home/user/.local/state", profile: "default:default" });
    assert.equal(path, "/home/user/.local/state/sence/default:default/snapshots");
  });

  it("uses the derived state key for 3-component profile", () => {
    const path = resolveSnapshotDir({ stateDir: "/home/user/.local/state", profile: "code:build:/Users/toqoz/src/foo" });
    assert.equal(path, "/home/user/.local/state/sence/code-build--Users-toqoz-src-foo/snapshots");
  });
});

describe("resolvePatchDir", () => {
  it("resolves to <cacheDir>/sence/patches regardless of profile", () => {
    const path = resolvePatchDir({ cacheDir: "/home/user/.cache" });
    assert.equal(path, "/home/user/.cache/sence/patches");
  });
});

describe("resolvePatchPath", () => {
  it("resolves a valid id to <patchDir>/<id>.json", () => {
    const path = resolvePatchPath("/cache/sence/patches", "2026-04-21-abcdef");
    assert.equal(path, "/cache/sence/patches/2026-04-21-abcdef.json");
  });

  it("rejects ids containing path separators or parent refs", () => {
    for (const bad of ["../escape", "a/b", "..", "a b", ""]) {
      assert.throws(() => resolvePatchPath("/cache/sence/patches", bad), /invalid patch id/);
    }
  });
});

describe("slugify", () => {
  it("lowercases, dash-joins, and strips leading/trailing dashes", () => {
    assert.equal(slugify("Allow npm registry"), "allow-npm-registry");
    assert.equal(slugify("  registry.npmjs.org HTTPS  "), "registry-npmjs-org-https");
    assert.equal(slugify("!!!weird!!!"), "weird");
    assert.equal(slugify(""), "");
    assert.equal(slugify(null), "");
    assert.equal(slugify(undefined), "");
  });

  it("clips long titles to 40 chars and trims a trailing partial-word dash", () => {
    const out = slugify("a very long recommendation title that keeps going and going");
    assert.ok(out.length <= 40, `got length ${out.length}: ${out}`);
    assert.doesNotMatch(out, /-$/);
  });
});

describe("writePatchToCache", () => {
  let tmpDir;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), "sence-test-")); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it("creates the patch dir and returns a unique {id, path} pair", () => {
    const patchDir = join(tmpDir, "patches");
    const r1 = writePatchToCache(patchDir, { network: { allow: ["a"] } });
    const r2 = writePatchToCache(patchDir, { network: { allow: ["b"] } });
    assert.notEqual(r1.id, r2.id);
    assert.equal(r1.path, join(patchDir, `${r1.id}.json`));
    // Shape without slug: YYYY-MM-DD-<6 hex>
    assert.match(r1.id, /^\d{4}-\d{2}-\d{2}-[0-9a-f]{6}$/);
    assert.equal(JSON.parse(readFileSync(r1.path, "utf-8")).network.allow[0], "a");
    assert.equal(JSON.parse(readFileSync(r2.path, "utf-8")).network.allow[0], "b");
  });

  it("embeds a slug when one is supplied", () => {
    const patchDir = join(tmpDir, "patches");
    const { id } = writePatchToCache(patchDir, {}, { slug: "Allow npm registry" });
    assert.match(id, /^\d{4}-\d{2}-\d{2}-allow-npm-registry-[0-9a-f]{6}$/);
  });

  it("falls back to no-slug form when the slug is blank after normalization", () => {
    const patchDir = join(tmpDir, "patches");
    const { id } = writePatchToCache(patchDir, {}, { slug: "!!!" });
    assert.match(id, /^\d{4}-\d{2}-\d{2}-[0-9a-f]{6}$/);
  });

  it("never prunes the freshly-written patch even if it falls into the eviction slice", () => {
    const patchDir = join(tmpDir, "patches");
    // keep=0 is the adversarial case: without the "protect" guard, the
    // pruner would delete every file including the one just written. This
    // stands in for the mtime-tie race where readdirSync's order decides
    // whether the fresh file ends up in slice(keep).
    const { id, path } = writePatchToCache(patchDir, { i: "fresh" }, { keep: 0 });
    assert.ok(existsSync(path), `fresh patch ${id} should survive aggressive pruning`);
  });

  it("prunes old patches beyond `keep`, preserving the newest by mtime", () => {
    const patchDir = join(tmpDir, "patches");
    // Write 5 patches without pruning, forcing distinct mtimes so ordering
    // doesn't depend on filesystem timestamp granularity.
    const paths = [];
    for (let i = 0; i < 5; i++) {
      const { path } = writePatchToCache(patchDir, { i }, { keep: 100 });
      utimesSync(path, 1_700_000_000 + i, 1_700_000_000 + i);
      paths.push(path);
    }
    // Now write one more with keep=3 to trigger pruning. It becomes the newest.
    const { path: newest } = writePatchToCache(patchDir, { i: "newest" }, { keep: 3 });

    const remaining = new Set(readdirSync(patchDir));
    assert.equal(remaining.size, 3, `expected 3 files, got: ${[...remaining].join(", ")}`);
    // The newest write + the two most-recently-touched of the original 5 survive.
    for (const survivor of [newest, paths[4], paths[3]]) {
      assert.ok(remaining.has(survivor.split("/").pop()), `expected ${survivor} to survive`);
    }
    // The oldest three must be gone.
    for (const evicted of paths.slice(0, 3)) {
      assert.ok(!existsSync(evicted), `expected ${evicted} to be pruned`);
    }
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
  it("passes through 2-component profiles", () => {
    assert.equal(resolveProfileName("code:npm-i"), "code:npm-i");
    assert.equal(resolveProfileName("code-strict:build"), "code-strict:build");
    assert.equal(resolveProfileName("default:myproj"), "default:myproj");
  });

  it("prepends default: to names without colon", () => {
    assert.equal(resolveProfileName("default"), "default:default");
    assert.equal(resolveProfileName("strict"), "default:strict");
    assert.equal(resolveProfileName("my-project"), "default:my-project");
  });

  it("absolutizes config-dir in 3-component profile against cwd", () => {
    const r = resolveProfileName("code:foo:.");
    assert.equal(r, `code:foo:${process.cwd()}`);
  });

  it("keeps an absolute config-dir as-is", () => {
    assert.equal(resolveProfileName("code:foo:/tmp/ws"), "code:foo:/tmp/ws");
  });

  it("rejects an empty config-dir", () => {
    assert.throws(() => resolveProfileName("code:foo:"), /empty config-dir/);
  });

  it("stable across different cwds for an absolute config-dir", () => {
    const before = process.cwd();
    try {
      process.chdir("/");
      const fromRoot = resolveProfileName("code:foo:/tmp/ws");
      process.chdir(before);
      const fromOriginal = resolveProfileName("code:foo:/tmp/ws");
      assert.equal(fromRoot, fromOriginal);
    } finally {
      process.chdir(before);
    }
  });
});

describe("resolveStateKey", () => {
  it("returns the profile string for 2-component profiles", () => {
    assert.equal(resolveStateKey("default:default"), "default:default");
    assert.equal(resolveStateKey("code:foo"), "code:foo");
  });

  it("derives <template>-<name>-<abs-path-with-/-to--> for 3-component", () => {
    assert.equal(
      resolveStateKey("code:build:/Users/toqoz/src/foo"),
      "code-build--Users-toqoz-src-foo",
    );
  });

  it("two different config-dirs produce different keys", () => {
    const a = resolveStateKey("code:foo:/tmp/a");
    const b = resolveStateKey("code:foo:/tmp/b");
    assert.notEqual(a, b);
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

  it("aggregates multiple violations from one policy", () => {
    const errors = validatePolicy({
      extends: "evil-template",
      network: { allowedDomains: ["*"] },
      filesystem: { allowRead: ["~/.ssh/id_rsa", "~/**"] },
    });
    // extends + wildcard domain + credential path + broad glob = at least 4
    assert.ok(errors.length >= 4, `expected >=4 errors, got ${errors.length}: ${errors.join("; ")}`);
    assert.ok(errors.some((e) => e.includes("unknown extends")));
    assert.ok(errors.some((e) => e.includes("wildcard")));
    assert.ok(errors.some((e) => e.includes(".ssh")));
    assert.ok(errors.some((e) => e.includes("glob too broad")));
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

describe("assertExtendsImmutable", () => {
  it("passes when patch omits extends", () => {
    assert.doesNotThrow(() =>
      assertExtendsImmutable({ extends: "code" }, { network: { allowedDomains: ["a.com"] } }),
    );
  });

  it("passes when patch repeats the same extends", () => {
    assert.doesNotThrow(() =>
      assertExtendsImmutable({ extends: "code" }, { extends: "code" }),
    );
  });

  it("passes when both sides have no extends", () => {
    assert.doesNotThrow(() => assertExtendsImmutable({}, { network: {} }));
    assert.doesNotThrow(() => assertExtendsImmutable(null, {}));
  });

  it("rejects switching to a different template", () => {
    assert.throws(
      () => assertExtendsImmutable({ extends: "code" }, { extends: "code-strict" }),
      /changes "extends" from "code" to "code-strict"/,
    );
  });

  it("rejects adding extends when current has none", () => {
    assert.throws(
      () => assertExtendsImmutable({}, { extends: "code" }),
      /changes "extends" from \(none\) to "code"/,
    );
  });

  it("rejects removing extends via explicit null", () => {
    assert.throws(
      () => assertExtendsImmutable({ extends: "code" }, { extends: null }),
      /changes "extends" from "code" to \(none\)/,
    );
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

describe("stripNulls", () => {
  it("returns null/primitives unchanged", () => {
    assert.equal(stripNulls(null), null);
    assert.equal(stripNulls(42), 42);
    assert.equal(stripNulls("x"), "x");
  });

  it("returns arrays unchanged regardless of length", () => {
    assert.deepEqual(stripNulls([]), []);
    assert.deepEqual(stripNulls([1, 2, 3]), [1, 2, 3]);
  });

  it("drops null fields from an object", () => {
    assert.deepEqual(stripNulls({ a: null, b: 1 }), { b: 1 });
  });

  it("preserves empty arrays inside an object (revocation semantics)", () => {
    assert.deepEqual(
      stripNulls({ network: { allowedDomains: [] } }),
      { network: { allowedDomains: [] } },
    );
  });

  it("preserves empty objects after stripping all nulls", () => {
    assert.deepEqual(stripNulls({ a: { b: null } }), { a: {} });
  });

  it("handles the realistic fence.json mixed patch", () => {
    const patch = {
      extends: "code",
      network: null,
      filesystem: { allowRead: [], allowWrite: null },
    };
    assert.deepEqual(stripNulls(patch), {
      extends: "code",
      filesystem: { allowRead: [] },
    });
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

  // Regression: the previous implementation compared lines by index, so
  // inserting one entry into an array caused every trailing line (closing
  // brackets and braces) to render as delete+add noise. A proper LCS diff
  // should leave them as unchanged context.
  it("keeps unchanged trailing lines as context when appending an array entry", () => {
    const before = { macos: { mach: { allowLookup: ["com.apple.a", "com.apple.b"] } } };
    const after = { macos: { mach: { allowLookup: ["com.apple.a", "com.apple.b", "com.apple.c"] } } };
    const diff = diffPolicy(before, after);
    // Only the comma-added line and the new entry should be marked.
    const removed = diff.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---"));
    const added = diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));
    assert.deepEqual(removed, ['-        "com.apple.b"']);
    assert.deepEqual(added, ['+        "com.apple.b",', '+        "com.apple.c"']);
    // Closing brackets/braces must remain unchanged context, not re-added.
    assert.ok(diff.includes('       ]'));
    assert.ok(!diff.includes('+      ]'));
    assert.ok(!diff.includes('-      ]'));
  });
});

describe("normalizeAdditionValue", () => {
  it("lowercases domains and strips protocol + trailing dot", () => {
    assert.equal(normalizeAdditionValue("network.allow", "Registry.NPMJS.org."), "registry.npmjs.org");
    assert.equal(normalizeAdditionValue("network.allow", "https://example.com"), "example.com");
    assert.equal(normalizeAdditionValue("network.deny", "  169.254.169.254  "), "169.254.169.254");
  });

  it("trims paths without changing case", () => {
    assert.equal(normalizeAdditionValue("filesystem.allowRead", "  ./SRC  "), "./SRC");
  });

  it("trims commands without changing case", () => {
    assert.equal(normalizeAdditionValue("command.deny", "  Git Push  "), "Git Push");
  });
});

describe("assessAddition", () => {
  it("blocks network wildcard *", () => {
    const v = assessAddition({ kind: "network.allow", value: "*" });
    assert.equal(v.block, true);
    assert.ok(/wildcard/.test(v.reason));
  });

  it("allows narrow network additions", () => {
    assert.equal(assessAddition({ kind: "network.allow", value: "*.npmjs.org" }).block, false);
    assert.equal(assessAddition({ kind: "network.allow", value: "example.com" }).block, false);
  });

  it("blocks credential path reads and writes", () => {
    assert.equal(assessAddition({ kind: "filesystem.allowRead", value: "~/.ssh/id_rsa" }).block, true);
    assert.equal(assessAddition({ kind: "filesystem.allowWrite", value: "~/.aws/credentials" }).block, true);
    assert.equal(assessAddition({ kind: "filesystem.allowRead", value: "~/.netrc" }).block, true);
  });

  it("blocks broad home globs", () => {
    assert.equal(assessAddition({ kind: "filesystem.allowRead", value: "~/**" }).block, true);
    assert.equal(assessAddition({ kind: "filesystem.allowWrite", value: "/Users/alice/*" }).block, true);
  });

  it("allows narrow workspace paths", () => {
    assert.equal(assessAddition({ kind: "filesystem.allowRead", value: "./src" }).block, false);
    assert.equal(assessAddition({ kind: "filesystem.allowWrite", value: "/tmp" }).block, false);
  });

  it("never blocks deny-side additions (they only tighten)", () => {
    assert.equal(assessAddition({ kind: "filesystem.denyRead", value: "~/.ssh" }).block, false);
    assert.equal(assessAddition({ kind: "network.deny", value: "evil.com" }).block, false);
    assert.equal(assessAddition({ kind: "command.deny", value: "rm -rf" }).block, false);
  });

  it("rejects unknown kind, empty value, or non-string", () => {
    assert.equal(assessAddition({ kind: "not.a.kind", value: "x" }).block, true);
    assert.equal(assessAddition({ kind: "network.allow", value: "" }).block, true);
    assert.equal(assessAddition({ kind: "network.allow", value: "   " }).block, true);
    assert.equal(assessAddition(null).block, true);
  });

  it("blocks macOS mach wildcard *", () => {
    assert.equal(assessAddition({ kind: "macos.mach.lookup", value: "*" }).block, true);
    assert.equal(assessAddition({ kind: "macos.mach.register", value: "*" }).block, true);
  });

  it("allows narrow macOS mach additions", () => {
    assert.equal(assessAddition({ kind: "macos.mach.lookup", value: "com.apple.pasteboard.1" }).block, false);
    assert.equal(assessAddition({ kind: "macos.mach.lookup", value: "org.chromium.*" }).block, false);
  });
});

describe("additionsToPatch", () => {
  it("returns empty patch when no additions", () => {
    assert.deepEqual(additionsToPatch({}, []), {});
  });

  it("creates a section with a single addition when current has none", () => {
    const patch = additionsToPatch({}, [
      { kind: "network.allow", value: "example.com" },
    ]);
    assert.deepEqual(patch, { network: { allowedDomains: ["example.com"] } });
  });

  it("unions with current array so mergePolicy's array-replace preserves existing entries", () => {
    const current = { network: { allowedDomains: ["a.com"] } };
    const patch = additionsToPatch(current, [
      { kind: "network.allow", value: "b.com" },
    ]);
    assert.deepEqual(patch.network.allowedDomains, ["a.com", "b.com"]);
    // And mergePolicy applied on top must preserve everything.
    const merged = mergePolicy(current, patch);
    assert.deepEqual(merged.network.allowedDomains, ["a.com", "b.com"]);
  });

  it("dedupes against current entries (case/protocol/trailing-dot insensitive)", () => {
    const current = { network: { allowedDomains: ["Registry.NPMJS.org"] } };
    const patch = additionsToPatch(current, [
      { kind: "network.allow", value: "https://registry.npmjs.org." },
    ]);
    assert.deepEqual(patch, {});
  });

  it("dedupes against the extends template entries", () => {
    const templateEntries = { network: { allowedDomains: ["registry.npmjs.org"] } };
    const patch = additionsToPatch({}, [
      { kind: "network.allow", value: "registry.npmjs.org" },
      { kind: "network.allow", value: "pypi.org" },
    ], { templateEntries });
    assert.deepEqual(patch, { network: { allowedDomains: ["pypi.org"] } });
  });

  it("dedupes duplicate additions within a single batch", () => {
    const patch = additionsToPatch({}, [
      { kind: "network.allow", value: "a.com" },
      { kind: "network.allow", value: "a.com" },
      { kind: "network.allow", value: "A.com" },
    ]);
    assert.deepEqual(patch.network.allowedDomains, ["a.com"]);
  });

  it("handles multiple kinds in a single call", () => {
    const patch = additionsToPatch({}, [
      { kind: "network.allow", value: "a.com" },
      { kind: "filesystem.allowRead", value: "./src" },
      { kind: "command.deny", value: "rm -rf" },
    ]);
    assert.deepEqual(patch, {
      network: { allowedDomains: ["a.com"] },
      filesystem: { allowRead: ["./src"] },
      command: { deny: ["rm -rf"] },
    });
  });

  it("skips unknown kinds silently", () => {
    const patch = additionsToPatch({}, [
      { kind: "not.a.kind", value: "x" },
      { kind: "network.allow", value: "a.com" },
    ]);
    assert.deepEqual(patch, { network: { allowedDomains: ["a.com"] } });
  });

  it("produces an empty patch when all additions are already granted", () => {
    const current = { filesystem: { allowRead: ["./src"] } };
    const templateEntries = { network: { allowedDomains: ["a.com"] } };
    const patch = additionsToPatch(current, [
      { kind: "network.allow", value: "a.com" },
      { kind: "filesystem.allowRead", value: "./src" },
    ], { templateEntries });
    assert.deepEqual(patch, {});
  });

  it("writes 3-level paths for macOS mach additions", () => {
    const patch = additionsToPatch({}, [
      { kind: "macos.mach.lookup", value: "com.apple.pasteboard.1" },
      { kind: "macos.mach.register", value: "com.apple.example" },
    ]);
    assert.deepEqual(patch, {
      macos: {
        mach: {
          lookup: ["com.apple.pasteboard.1"],
          register: ["com.apple.example"],
        },
      },
    });
  });

  it("unions macOS mach additions with existing entries", () => {
    const current = {
      macos: { mach: { lookup: ["com.apple.diagnosticd"] } },
    };
    const patch = additionsToPatch(current, [
      { kind: "macos.mach.lookup", value: "com.apple.pasteboard.1" },
    ]);
    assert.deepEqual(patch.macos.mach.lookup, [
      "com.apple.diagnosticd",
      "com.apple.pasteboard.1",
    ]);
    const merged = mergePolicy(current, patch);
    assert.deepEqual(merged.macos.mach.lookup, [
      "com.apple.diagnosticd",
      "com.apple.pasteboard.1",
    ]);
  });

  it("dedupes macOS mach additions against existing entries", () => {
    const current = {
      macos: { mach: { lookup: ["com.apple.diagnosticd"] } },
    };
    const patch = additionsToPatch(current, [
      { kind: "macos.mach.lookup", value: "com.apple.diagnosticd" },
    ]);
    assert.deepEqual(patch, {});
  });
});
