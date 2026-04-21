import { accessSync, constants as fsConstants, readFileSync, statSync } from "node:fs";
import { execute } from "./executor.js";
import { audit } from "./auditor.js";
import { runSuggester, loadExtendsTemplate } from "./suggester.js";
import { formatText, formatJson } from "./reporter.js";
import { resolvePolicyPath, resolveSnapshotDir, resolvePatchDir, resolvePatchPath, writePatchToCache, ensurePolicy, writePolicy, diffPolicy, rollbackPolicy, validatePolicy, mergePolicy, stripNulls, resolveProfileName, resolveStateKey, defaultPolicyForProfile, assertExtendsImmutable, additionsToPatch, assessAddition } from "./policy.js";
import { runInteractiveMode } from "./modes/interactive.js";
import { runTailMode } from "./modes/tail.js";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_JSON = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));
const VERSION = PACKAGE_JSON.version;

const HELP_TEXT = `Usage: sence [options] [--] <command...>
       sence --interactive -- <agent-command...>

Run a command inside a fence sandbox with monitoring, audit, and policy advice.

Options:
  --interactive                     Interactive mode (monitors denials, auto-suggests policy, works with any agent)
  --profile <name>             Policy profile (default: default)
                               Forms:
                                 <name>                        (→ default:<name>)
                                 <template>:<name>             (start from a fence template)
                                 <template>:<name>:<config-dir> (place fence.json at <config-dir>/fence.json)
                               Run \`fence --list-templates\` for available templates
  --patch <id>                 Apply a suggested patch (identifier printed by a
                               prior sence run) from $XDG_CACHE_HOME/sence/patches/
  --rollback [STEP]            Rollback policy (default: 1)
  --tail <path>                Follow a fence monitor log and colorize denial
                               lines (used internally by --interactive)
  --model <name>               LLM model for policy suggestions (default: gpt-5.4-mini)
  --suggest auto|never         When to generate advice (default: auto)
  --report text|json           Output format for audit report (default: text)
  --verbose                    Always show sence audit output
  --version                    Print sence version and exit
  --help                       Show this help message

Examples:
  sence npm install
  sence --interactive -- claude -p "fix the failing tests"
  sence --profile code:npm-i npm install
  sence --profile code:default npm install
  sence --profile strict npm install
  sence --profile code:local:. npm install   # fence.json in cwd
  sence --patch 2026-04-21-npm-registry-abcdef npm install
  sence --rollback
`;

const FLAG_WITH_VALUE = new Set(["--suggest", "--report", "--profile", "--patch", "--model", "--tail"]);
const BOOLEAN_FLAGS = new Set(["--verbose", "--help", "--version", "--interactive"]);

export function parseArgs(argv) {
  const opts = {
    suggest: "auto",
    report: "text",
    profile: "default",
    model: undefined,
    patch: undefined,
    rollback: undefined,
    tail: undefined,
    interactive: false,
    verbose: false,
    help: false,
    version: false,
    command: [],
    error: null,
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--") {
      i++;
      break;
    }
    if (arg === "--rollback") {
      const next = argv[i + 1];
      if (next && /^\d+$/.test(next)) {
        opts.rollback = parseInt(next, 10);
        i += 2;
      } else {
        opts.rollback = 1;
        i++;
      }
      continue;
    }
    if (BOOLEAN_FLAGS.has(arg)) {
      opts[arg.slice(2)] = true;
      i++;
      continue;
    }
    if (FLAG_WITH_VALUE.has(arg)) {
      const key = arg.slice(2);
      i++;
      if (i >= argv.length) {
        opts.error = `Missing value for ${arg}`;
        return opts;
      }
      opts[key] = argv[i];
      i++;
      continue;
    }
    if (arg.startsWith("--")) {
      opts.error = `Unknown flag: ${arg}. See: sence --help`;
      return opts;
    }
    break;
  }

  if (opts.help) return opts;
  if (opts.version) return opts;
  if (opts.rollback !== undefined) return opts;
  if (opts.tail !== undefined) return opts;

  opts.command = argv.slice(i);

  const validSuggest = ["auto", "never"];
  if (!validSuggest.includes(opts.suggest)) {
    opts.error = `Invalid --suggest value: "${opts.suggest}". Must be one of: ${validSuggest.join(", ")}`;
    return opts;
  }

  if (opts.interactive) {
    if (opts.command.length === 0) {
      opts.error = "No command specified. Usage: sence --interactive -- <agent-command...>";
    }
    return opts;
  }

  if (opts.command.length === 0) {
    opts.error = "No command specified. See: sence --help";
    return opts;
  }

  const validReport = ["text", "json"];
  if (!validReport.includes(opts.report)) {
    opts.error = `Invalid --report value: "${opts.report}". Must be one of: ${validReport.join(", ")}`;
    return opts;
  }

  return opts;
}

function getConfigDir() {
  if (process.env.XDG_CONFIG_HOME) return process.env.XDG_CONFIG_HOME;
  if (!process.env.HOME) {
    process.stderr.write("[sence] Fatal: HOME is not set.\n");
    process.exit(2);
  }
  return join(process.env.HOME, ".config");
}

function getStateDir() {
  if (process.env.XDG_STATE_HOME) return process.env.XDG_STATE_HOME;
  if (!process.env.HOME) {
    process.stderr.write("[sence] Fatal: HOME is not set.\n");
    process.exit(2);
  }
  return join(process.env.HOME, ".local", "state");
}

function getCacheDir() {
  if (process.env.XDG_CACHE_HOME) return process.env.XDG_CACHE_HOME;
  if (!process.env.HOME) {
    process.stderr.write("[sence] Fatal: HOME is not set.\n");
    process.exit(2);
  }
  return join(process.env.HOME, ".cache");
}

function resolveMonitorLogPath({ stateDir, profile }) {
  return join(stateDir, "sence", resolveStateKey(profile), "monitor.log");
}

function shellQuote(s) {
  if (/^[a-zA-Z0-9_./:@=-]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// Return the shell-safe string the user should type to invoke this sence
// binary again. `process.argv[1]` is always absolute (the kernel rewrites
// relative shebang paths before the interpreter runs), so we can't recover
// the exact string the user typed. We approximate it in two steps:
//   1. If `basename(argv[1])` is found on PATH — skipping non-file and
//      non-executable entries the way a real shell search does — and the
//      first executable match is the same file (dev+ino), collapse to the
//      basename (so `sence` round-trips as `sence`, not the install path).
//   2. Otherwise, if argv[1] is inside cwd, display it relative to cwd
//      (so `bin/sence` round-trips as `bin/sence`). Fall back to the
//      absolute path for anything outside cwd.
// Shell aliases and functions that override the name are unobservable from
// inside the process and are deliberately ignored.
function senseExecName() {
  const argv1 = process.argv[1];
  if (!argv1) return "sence";
  let argv1Stat;
  try {
    argv1Stat = statSync(argv1);
  } catch {
    return shellQuote(argv1);
  }
  const base = basename(argv1);
  const pathDirs = (process.env.PATH || "").split(delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    const candidate = resolvePath(dir, base);
    let s;
    try {
      s = statSync(candidate);
    } catch {
      continue;
    }
    if (!s.isFile()) continue;
    try {
      accessSync(candidate, fsConstants.X_OK);
    } catch {
      continue;
    }
    // First executable PATH match: collapse only if it's the same file.
    if (s.ino === argv1Stat.ino && s.dev === argv1Stat.dev) {
      return shellQuote(base);
    }
    break;
  }
  return shellQuote(displayPath(argv1));
}

// Pick the shorter of cwd-relative vs absolute, preserving shell-executable
// semantics. A bare basename like `sence` gets a `./` prefix so the shell
// doesn't treat it as a PATH lookup.
function displayPath(absPath) {
  const rel = relative(process.cwd(), absPath);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return absPath;
  return rel.includes("/") ? rel : `./${rel}`;
}

function buildSenseCmd(opts) {
  const parts = [senseExecName()];
  if (opts.profile !== "default") parts.push("--profile", shellQuote(opts.profile));
  return parts;
}

export { shellQuote, senseExecName };

export async function run(argv) {
  const opts = parseArgs(argv);

  if (opts.help) {
    process.stdout.write(HELP_TEXT);
    process.exit(0);
  }

  if (opts.version) {
    process.stdout.write(`${VERSION}\n`);
    process.exit(0);
  }

  if (opts.error) {
    process.stderr.write(opts.error + "\n");
    process.exit(2);
  }

  if (opts.tail !== undefined) {
    runTailMode(opts.tail);
    return;
  }

  const configDir = getConfigDir();
  const stateDir = getStateDir();
  try {
    opts.profile = resolveProfileName(opts.profile);
  } catch (err) {
    process.stderr.write(`[sence] ${err.message}\n`);
    process.exit(2);
  }
  const policyPath = resolvePolicyPath({ configDir, profile: opts.profile });
  const snapshotDir = resolveSnapshotDir({ stateDir, profile: opts.profile });
  const logPath = resolveMonitorLogPath({ stateDir, profile: opts.profile });
  // Patch cache is resolved lazily: paths that never touch suggested patches
  // (e.g. --rollback, --suggest never with no patch generated) shouldn't
  // require XDG_CACHE_HOME / HOME.
  const getPatchDir = () => resolvePatchDir({ cacheDir: getCacheDir() });

  if (opts.rollback !== undefined) {
    let result;
    try {
      result = rollbackPolicy(policyPath, { snapshotDir, steps: opts.rollback });
    } catch (err) {
      process.stderr.write(`[sence] Rollback failed: ${err.message}\n`);
      process.exit(1);
    }
    if (result.error) {
      process.stderr.write(`[sence] ${result.error}\n`);
      process.exit(1);
    }
    process.stderr.write(`[sence] Rolled back policy to ${result.from}\n`);
    process.stderr.write(`[sence] Policy written to ${policyPath}\n`);
    process.exit(0);
  }

  let initPolicy;
  try {
    initPolicy = defaultPolicyForProfile(opts.profile);
  } catch (err) {
    process.stderr.write(`[sence] ${err.message}\n`);
    process.exit(2);
  }

  let currentPolicy;
  try {
    currentPolicy = ensurePolicy(policyPath, { snapshotDir, defaultPolicy: initPolicy });
  } catch (err) {
    process.stderr.write(
      `[sence] Fatal: ${policyPath} is corrupt — ${err.message}\n` +
      `[sence] Fix or remove the file manually.\n`,
    );
    process.exit(2);
  }

  // --patch: merge patch into current policy before running. The argument is
  // an identifier produced by a previous sence run; the actual JSON lives in
  // the cache dir. To hand-edit, modify the file under ~/.cache/sence/patches/
  // directly rather than threading a new path through the CLI.
  if (opts.patch) {
    let patchPath;
    try {
      patchPath = resolvePatchPath(getPatchDir(), opts.patch);
    } catch (err) {
      process.stderr.write(`[sence] ${err.message}\n`);
      process.exit(2);
    }
    try {
      const patchData = JSON.parse(readFileSync(patchPath, "utf-8"));
      const normalizedPatch = stripNulls(patchData) ?? {};
      assertExtendsImmutable(currentPolicy, normalizedPatch);
      const merged = mergePolicy(currentPolicy, normalizedPatch);
      const policyErrors = validatePolicy(merged);
      if (policyErrors.length > 0) {
        process.stderr.write(`[sence] Refusing to apply unsafe policy:\n`);
        for (const e of policyErrors) {
          process.stderr.write(`  - ${e}\n`);
        }
        process.exit(2);
      }
      writePolicy(policyPath, merged, { snapshotDir });
      currentPolicy = merged;
      process.stderr.write(`[sence] Applied policy patch to ${policyPath}\n`);
    } catch (err) {
      process.stderr.write(`[sence] Failed to apply patch ${opts.patch} (${patchPath}): ${err.message}\n`);
      process.exit(2);
    }
  }

  if (opts.interactive) {
    await runInteractiveMode({
      command: opts.command,
      policyPath,
      snapshotDir,
      getPatchDir,
      profile: opts.profile,
      suggest: opts.suggest,
      model: opts.model,
      logPath,
    });
    return;
  }

  const execResult = await execute({
    command: opts.command,
    profile: opts.profile,
    settingsPath: policyPath,
    monitor: { stderr: true },
  });

  if (execResult.spawnError) {
    process.stderr.write(
      `[sence] Fatal: failed to launch sandbox — ${execResult.spawnError}\n`,
    );
    process.exit(127);
  }

  const auditSummary = audit({
    exitCode: execResult.exitCode,
    monitorLog: execResult.monitorLog,
  });

  const hasDenials =
    auditSummary.deniedFiles.length > 0 ||
    auditSummary.deniedNetwork.length > 0 ||
    auditSummary.suspiciousActions.length > 0;

  let rec = { autoApplied: false };
  const wantSuggest = opts.suggest === "auto" && hasDenials;

  if (wantSuggest) {
    rec = runSuggester({ currentPolicy, auditSummary, model: opts.model });

    if (Array.isArray(rec.proposedAdditions)) {
      const accepted = [];
      const blocked = [];
      for (const add of rec.proposedAdditions) {
        const verdict = assessAddition(add);
        if (verdict.block) blocked.push({ ...add, blockReason: verdict.reason });
        else accepted.push(add);
      }
      rec.acceptedAdditions = accepted;
      rec.blockedAdditions = blocked;

      const tmpl = loadExtendsTemplate(currentPolicy);
      const patch = additionsToPatch(currentPolicy, accepted, { templateEntries: tmpl?.entries ?? null });
      // Merge into current to compute the final state and a stable diff.
      const merged = mergePolicy(currentPolicy, patch);
      const policyErrors = validatePolicy(merged);
      if (policyErrors.length > 0) {
        rec.error = `Rejected suggestion: ${policyErrors.join("; ")}`;
      } else {
        rec.proposedPolicy = patch;
        rec.policyDiff = diffPolicy(currentPolicy, merged);

        if (rec.policyDiff) {
          rec.patchId = writePatchToCache(getPatchDir(), patch, { slug: rec.title }).id;
        }
      }
    }
  }

  // Show report
  const showReport =
    opts.verbose ||
    opts.report === "json" ||
    hasDenials ||
    rec.explanation ||
    rec.error;

  if (showReport) {
    const output =
      opts.report === "json"
        ? formatJson(execResult, auditSummary, rec)
        : formatText(execResult, auditSummary, rec);

    const dest = opts.report === "json" ? process.stdout : process.stderr;
    dest.write(output + "\n");
  }

  // Show apply command if patch was generated
  if (rec.patchId) {
    const cmdParts = buildSenseCmd(opts);
    cmdParts.push("--patch", rec.patchId, "--", ...opts.command.map(shellQuote));
    process.stderr.write(`\nTo apply and re-run:\n  ${cmdParts.join(" ")}\n`);
  }

  process.exit(execResult.exitCode);
}
