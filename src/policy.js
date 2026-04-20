import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { CREDENTIAL_PATTERNS } from "./patterns.js";

// Resolve the canonical profile name.
// "<template>:<name>" → as-is
// "<name>"            → "default:<name>"
export function resolveProfileName(profile) {
  return profile.includes(":") ? profile : `default:${profile}`;
}

// Return the initial policy for a canonical profile name.
// "default:<name>"    → {} (empty policy)
// "<template>:<name>" → { extends: "<template>" }
export function defaultPolicyForProfile(profile) {
  const template = profile.split(":")[0];
  if (template === "default") return {};
  if (!ALLOWED_EXTENDS.includes(template)) {
    throw new Error(
      `unknown fence template: "${template}". Allowed: default, ${ALLOWED_EXTENDS.join(", ")}\n` +
      `Run \`fence --list-templates\` to see available templates.`,
    );
  }
  return { extends: template };
}

export function resolvePolicyPath({ configDir, profile = "default" }) {
  return join(configDir, "sence", profile, "fence.json");
}

export function resolveSnapshotDir({ dataDir, profile = "default" }) {
  return join(dataDir, "sence", profile, "snapshots");
}

export function readPolicy(path) {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf-8");
  return JSON.parse(raw);
}

export function ensurePolicy(path, { snapshotDir, defaultPolicy } = {}) {
  if (!existsSync(path)) {
    writePolicyRaw(path, defaultPolicy);
    if (snapshotDir) saveSnapshot(snapshotDir, defaultPolicy);
    return defaultPolicy;
  }
  const policy = readPolicy(path);
  // Ensure at least one snapshot exists for rollback
  if (snapshotDir && listSnapshots(snapshotDir).length === 0) {
    saveSnapshot(snapshotDir, policy);
  }
  return policy;
}

function writePolicyRaw(path, policy) {
  mkdirSync(dirname(path), { recursive: true });
  // Atomic write: write to temp file then rename to avoid torn reads
  const tmp = path + `.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(policy, null, 2) + "\n");
  renameSync(tmp, path);
}

let snapshotCounter = 0;

function saveSnapshot(snapshotDir, policy) {
  mkdirSync(snapshotDir, { recursive: true });
  // Monotonic counter ensures ordering even within the same millisecond
  const seq = String(++snapshotCounter).padStart(6, "0");
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const name = `${ts}-${seq}.json`;
  writeFileSync(join(snapshotDir, name), JSON.stringify(policy, null, 2) + "\n");
}

export function writePolicy(policyPath, policy, { snapshotDir }) {
  // Snapshot the NEW state (not the old one) — snapshots are restore points
  writePolicyRaw(policyPath, policy);
  saveSnapshot(snapshotDir, policy);
}

export function listSnapshots(snapshotDir) {
  try {
    return readdirSync(snapshotDir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .reverse(); // newest first
  } catch {
    return [];
  }
}

export function rollbackPolicy(policyPath, { snapshotDir, steps = 1 }) {
  const entries = listSnapshots(snapshotDir);
  // entries[0] is current, entries[1] is previous, etc.
  if (entries.length <= steps) {
    return { error: `Only ${entries.length} snapshot(s) available, cannot rollback ${steps} step(s)` };
  }
  const target = entries[steps];
  const restored = JSON.parse(readFileSync(join(snapshotDir, target), "utf-8"));
  writePolicyRaw(policyPath, restored);
  return { restored, from: target };
}

// Broad globs that would grant access to credential directories
const DANGEROUS_GLOB_PATTERNS = [
  /^~\/\*\*?$/,            // ~/** or ~/*
  /^~\/\.[^/]*\/\*\*?$/,   // ~/.anything/** or ~/.anything/*
  /^~\/\.config\/\*\*?$/,  // ~/.config/** or ~/.config/*
  /^\/\*\*?$/,             // /** or /*
  /^\/home\/[^/]+\/\*\*?$/,  // /home/user/** or /home/user/*
  /^\/Users\/[^/]+\/\*\*?$/, // /Users/user/** or /Users/user/*
];

const ALLOWED_EXTENDS = ["code", "code-strict", "code-relaxed", "local-dev-server"];

// Reject a patch that would change the current policy's `extends`.
// Callers must strip leftover `extends: current.extends` from the patch
// before merging — a no-op extends is not an error, but a *different*
// extends is a structural rewrite we never allow the LLM (or a user
// --patch) to perform implicitly. Rationale: changing extends silently
// swaps the entire baseline of allowed domains / denied paths / commands
// and inverts the "smallest safe change" invariant.
export function assertExtendsImmutable(current, patch) {
  if (!patch || typeof patch !== "object" || !Object.hasOwn(patch, "extends")) return;
  const proposed = patch.extends;
  const currentExtends = current?.extends ?? null;
  if (proposed === currentExtends) return;
  const from = currentExtends === null ? "(none)" : JSON.stringify(currentExtends);
  const to = proposed === null ? "(none)" : JSON.stringify(proposed);
  throw new Error(
    `patch changes "extends" from ${from} to ${to}; sence never rewrites the template baseline — ` +
    `add specific allowances to the current extends instead.`,
  );
}

export function validatePolicy(policy) {
  const errors = [];

  // Validate extends
  if (policy.extends && !ALLOWED_EXTENDS.includes(policy.extends)) {
    errors.push(`unknown extends template: "${policy.extends}". Allowed: ${ALLOWED_EXTENDS.join(", ")}`);
  }

  // Validate network scope
  const domains = policy.network?.allowedDomains ?? [];
  for (const d of domains) {
    if (d === "*") {
      errors.push(`network.allowedDomains contains wildcard "*" — allows all egress`);
    }
  }

  const allPaths = [
    ...(policy.filesystem?.allowRead ?? []),
    ...(policy.filesystem?.allowWrite ?? []),
  ];
  for (const p of allPaths) {
    for (const pattern of CREDENTIAL_PATTERNS) {
      if (pattern.test(p)) {
        errors.push(`allows access to credential path: ${p}`);
      }
    }
    for (const glob of DANGEROUS_GLOB_PATTERNS) {
      if (glob.test(p)) {
        errors.push(`glob too broad, would expose credential paths: ${p}`);
      }
    }
  }
  return errors;
}

// Recursively drop null values, empty arrays, and resulting empty objects.
// Used by the LLM suggester path: the structured-output schema forces
// every property to be present, so the model fills unchanged sections
// with null/[] per the prompt contract, and we want a minimal diff.
//
// Do NOT use this for user-authored --patch files: it would silently
// turn `{network:{allowedDomains:[]}}` (revoke allowlist) into a no-op.
// Use stripNulls() for that path.
export function stripEmpty(obj) {
  if (obj == null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.length === 0 ? undefined : obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const stripped = stripEmpty(v);
    if (stripped !== undefined && stripped !== null) out[k] = stripped;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

// Recursively drop null values only. Null has no representation in
// fence.json, so stripping it prevents accidental leaks. Empty arrays
// are preserved because mergePolicy treats arrays as wholesale
// replacements, so `{network:{allowedDomains:[]}}` revokes an existing
// allowlist. Empty objects are preserved as a side-effect and currently
// have no special meaning under mergePolicy (they recurse into a no-op);
// to clear an entire section, revoke its individual array fields.
export function stripNulls(obj) {
  if (obj == null || typeof obj !== "object" || Array.isArray(obj)) return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null) continue;
    out[k] = stripNulls(v);
  }
  return out;
}

// Deep-merge a partial patch into a base policy.
// Arrays and primitives are replaced; plain objects are recursed.
export function mergePolicy(base, patch) {
  const result = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value != null && typeof value === "object" && !Array.isArray(value) &&
        result[key] != null && typeof result[key] === "object" && !Array.isArray(result[key])) {
      result[key] = mergePolicy(result[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

export function diffPolicy(before, after) {
  const a = JSON.stringify(before, null, 2);
  const b = JSON.stringify(after, null, 2);
  if (a === b) return "";

  const aLines = a.split("\n");
  const bLines = b.split("\n");

  const lines = [];
  lines.push("--- a/fence.json");
  lines.push("+++ b/fence.json");

  const maxLen = Math.max(aLines.length, bLines.length);
  let chunkStart = -1;
  let chunkA = [];
  let chunkB = [];

  const flushChunk = () => {
    if (chunkA.length === 0 && chunkB.length === 0) return;
    lines.push(`@@ -${chunkStart + 1},${chunkA.length} +${chunkStart + 1},${chunkB.length} @@`);
    for (const l of chunkA) lines.push(`-${l}`);
    for (const l of chunkB) lines.push(`+${l}`);
    chunkA = [];
    chunkB = [];
    chunkStart = -1;
  };

  for (let i = 0; i < maxLen; i++) {
    const al = i < aLines.length ? aLines[i] : undefined;
    const bl = i < bLines.length ? bLines[i] : undefined;
    if (al === bl) {
      flushChunk();
    } else {
      if (chunkStart === -1) chunkStart = i;
      if (al !== undefined) chunkA.push(al);
      if (bl !== undefined) chunkB.push(bl);
    }
  }
  flushChunk();

  return lines.join("\n");
}
