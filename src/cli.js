import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { execute } from "./executor.js";
import { audit } from "./auditor.js";
import { runSuggester } from "./suggester.js";
import { formatText, formatJson } from "./reporter.js";
import { resolvePolicyPath, resolveSnapshotDir, ensurePolicy, writePolicy, diffPolicy, rollbackPolicy, validatePolicy, mergePolicy, stripNulls, resolveProfileName, defaultPolicyForProfile } from "./policy.js";
import { runInteractiveMode } from "./modes/interactive.js";
import { join } from "node:path";
import { tmpdir } from "node:os";

const HELP_TEXT = `Usage: sence [options] [--] <command...>
       sence --interactive -- <agent-command...>

Run a command inside a fence sandbox with monitoring, audit, and policy advice.

Options:
  --interactive                     Interactive mode (monitors denials, auto-suggests policy, works with any agent)
  --profile <name>             Policy profile (default: default)
                               Use <template>:<name> to start from a fence template
                               Run \`fence --list-templates\` for available templates
  --patch <file>               Apply a policy patch file before running the command
  --rollback [STEP]            Rollback policy (default: 1)
  --model <name>               LLM model for policy suggestions (default: gpt-5.4-mini)
  --suggest auto|never         When to generate advice (default: auto)
  --report text|json           Output format for audit report (default: text)
  --verbose                    Always show sence audit output
  --help                       Show this help message

Examples:
  sence npm install
  sence --interactive -- claude -p "fix the failing tests"
  sence --profile code:npm-i npm install
  sence --profile code:default npm install
  sence --profile strict npm install
  sence --patch /tmp/sence-abc123.json npm install
  sence --rollback
`;

const FLAG_WITH_VALUE = new Set(["--suggest", "--report", "--profile", "--patch", "--model"]);
const BOOLEAN_FLAGS = new Set(["--verbose", "--help", "--interactive"]);

export function parseArgs(argv) {
  const opts = {
    suggest: "auto",
    report: "text",
    profile: "default",
    model: undefined,
    patch: undefined,
    rollback: undefined,
    interactive: false,
    verbose: false,
    help: false,
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
  if (opts.rollback !== undefined) return opts;

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

function getDataDir() {
  if (process.env.XDG_DATA_HOME) return process.env.XDG_DATA_HOME;
  if (!process.env.HOME) {
    process.stderr.write("[sence] Fatal: HOME is not set.\n");
    process.exit(2);
  }
  return join(process.env.HOME, ".local", "share");
}

function getStateDir() {
  if (process.env.XDG_STATE_HOME) return process.env.XDG_STATE_HOME;
  if (!process.env.HOME) {
    process.stderr.write("[sence] Fatal: HOME is not set.\n");
    process.exit(2);
  }
  return join(process.env.HOME, ".local", "state");
}

function resolveMonitorLogPath({ stateDir, profile }) {
  return join(stateDir, "sence", profile, "monitor.log");
}

function shellQuote(s) {
  if (/^[a-zA-Z0-9_./:@=-]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function buildSenseCmd(opts) {
  const parts = ["sence"];
  if (opts.profile !== "default") parts.push("--profile", shellQuote(opts.profile));
  return parts;
}

export { shellQuote };

export async function run(argv) {
  const opts = parseArgs(argv);

  if (opts.help) {
    process.stdout.write(HELP_TEXT);
    process.exit(0);
  }

  if (opts.error) {
    process.stderr.write(opts.error + "\n");
    process.exit(2);
  }

  const configDir = getConfigDir();
  const dataDir = getDataDir();
  const stateDir = getStateDir();
  opts.profile = resolveProfileName(opts.profile);
  const policyPath = resolvePolicyPath({ configDir, profile: opts.profile });
  const snapshotDir = resolveSnapshotDir({ dataDir, profile: opts.profile });
  const logPath = resolveMonitorLogPath({ stateDir, profile: opts.profile });

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

  if (opts.interactive) {
    await runInteractiveMode({
      command: opts.command,
      policyPath,
      snapshotDir,
      profile: opts.profile,
      suggest: opts.suggest,
      model: opts.model,
      logPath,
    });
    return;
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

  // --patch: merge patch into current policy before running
  if (opts.patch) {
    try {
      const patchData = JSON.parse(readFileSync(opts.patch, "utf-8"));
      const normalizedPatch = stripNulls(patchData) ?? {};
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
      process.stderr.write(`[sence] Failed to apply patch: ${err.message}\n`);
      process.exit(2);
    }
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

    if (rec.proposedPolicy) {
      // Diff against the merged result so the displayed diff matches what --patch actually applies
      const merged = mergePolicy(currentPolicy, rec.proposedPolicy);
      rec.policyDiff = diffPolicy(currentPolicy, merged);

      // Write patch file (partial — will be merged on apply)
      if (rec.policyDiff) {
        const tmpDir = mkdtempSync(join(tmpdir(), "sence-"));
        const patchFile = join(tmpDir, "policy.json");
        writeFileSync(patchFile, JSON.stringify(rec.proposedPolicy, null, 2) + "\n");
        rec.patchFile = patchFile;
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
  if (rec.patchFile) {
    const cmdParts = buildSenseCmd(opts);
    cmdParts.push("--patch", shellQuote(rec.patchFile), "--", ...opts.command.map(shellQuote));
    process.stderr.write(`\nTo apply and re-run:\n  ${cmdParts.join(" ")}\n`);
  }

  process.exit(execResult.exitCode);
}
