import { spawn } from "node:child_process";
import { writeFileSync, readFileSync, appendFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { buildFenceArgs, teeMonitorLog } from "../executor.js";
import { audit } from "../auditor.js";
import { callCodex, loadExtendsTemplate } from "../suggester.js";
import { ensurePolicy, writePolicy, diffPolicy, validatePolicy, mergePolicy, defaultPolicyForProfile, assertExtendsImmutable } from "../policy.js";
import { isInsideTmux, sendEscape, capturePaneContent, displayPopup, supportsPopup, currentPane, prefillInput } from "../tmux.js";
import { shellQuote } from "../cli.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHEATSHEET = readFileSync(join(__dirname, "..", "..", "docs", "fence-cheatsheet.md"), "utf-8");
const INTERACTIVE_SCHEMA = join(__dirname, "..", "..", "docs", "interactive-schema.json");

const DEBOUNCE_MS = 1500;

const ESC_WAIT_MS = 2000;
const KILL_WAIT_MS = 3000;

// Interactive mode must not write to stderr while the wrapped TUI owns the
// pane (even post-kill, residual output would clutter the pane the user
// returns to). Route sence status/error messages to the monitor log file.
function logEvent(logPath, msg) {
  if (!logPath) return;
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, msg.endsWith("\n") ? msg : msg + "\n");
  } catch {
    // best-effort
  }
}

function buildInteractivePrompt({ currentPolicy, auditSummary, screenContent, originalCommand }) {
  const tmpl = loadExtendsTemplate(currentPolicy);
  const templateSection = tmpl
    ? `## Baseline from "extends": "${tmpl.name}"

fence(1) merges this template under the current fence.json. Arrays from the
template are appended to the child's arrays at runtime. Treat every entry
below as already granted — do NOT duplicate them into the child policy.

\`\`\`json
${tmpl.json.trim()}
\`\`\`
`
    : `## Baseline

The current fence.json does not extend a template; it starts from an empty
policy.
`;

  return `## Task

Propose the minimal safe fence.json policy change, and if possible, the exact command to resume the agent session.

## Rules

- Never allow credential paths listed in the Reference below.
- Never change "extends". If the current fence.json has one, keep the exact
  same value (or omit the field). Do not propose switching templates, even
  if a different template would match better — add the missing allowances
  to the current extends instead.
- Do not duplicate entries already present in the baseline template above;
  fence appends template arrays to the child's at runtime.
- Return the complete resulting fence.json in proposedPolicy, not a partial diff.
- Make the smallest safe change from the current fence.json.
- Prefer narrow domain wildcards (e.g. "*.npmjs.org") over broad ones.
- Set resumeCommand to null if you cannot find the session ID in the screen content.

## Reference

${CHEATSHEET}

${templateSection}
## Original command

${JSON.stringify(originalCommand)}

## Current fence.json

${JSON.stringify(currentPolicy, null, 2)}

## Audit (denied events)

${JSON.stringify(auditSummary, null, 2)}

## Captured screen content

\`\`\`
${screenContent.slice(-4000)}
\`\`\`

## Output

Reply with ONLY this JSON:

{"proposedPolicy":{...},"explanation":"one short sentence","resumeCommand":"command to resume or null"}`;
}

function runInteractiveSuggester({ currentPolicy, auditSummary, screenContent, originalCommand, model }) {
  const prompt = buildInteractivePrompt({ currentPolicy, auditSummary, screenContent, originalCommand });
  return callCodex({ prompt, schemaPath: INTERACTIVE_SCHEMA, model });
}

export async function runInteractiveMode({ command, policyPath, snapshotDir, profile, suggest = "auto", model, logPath }) {
  if (!isInsideTmux()) {
    process.stderr.write("[sence] --interactive requires tmux.\n");
    process.exit(2);
  }

  const paneId = currentPane();
  if (!paneId) {
    process.stderr.write("[sence] Could not detect tmux pane.\n");
    process.exit(2);
  }

  let currentPolicy;
  try {
    currentPolicy = ensurePolicy(policyPath, { snapshotDir, defaultPolicy: defaultPolicyForProfile(profile) });
  } catch (err) {
    process.stderr.write(
      `[sence] Fatal: ${policyPath} is corrupt — ${err.message}\n` +
      `[sence] Fix or remove the file manually.\n`,
    );
    process.exit(2);
  }
  const fenceArgs = buildFenceArgs({ command, settingsPath: policyPath });

  const { exitCode, denials } = await runAndMonitor({ fenceArgs, paneId, logPath });

  if (denials.length === 0) {
    // No denials — normal exit
    process.exit(exitCode);
  }

  // Capture screen after kill (shows session ID / resume info)
  const screenContent = capturePaneContent(paneId);

  // Audit
  const monitorLog = denials.join("\n");
  const auditSummary = audit({ exitCode, monitorLog });

  if (suggest === "never") {
    logEvent(logPath, `[sence] ${denials.length} denial(s) detected. Skipping suggestions (--suggest never).`);
    process.exit(exitCode);
  }

  // Suggest
  logEvent(logPath, "[sence] Analyzing sandbox violations...");
  const rec = runInteractiveSuggester({
    currentPolicy,
    auditSummary,
    screenContent,
    originalCommand: command,
    model,
  });

  if (rec.error || !rec.proposedPolicy) {
    logEvent(logPath, `[sence] Suggester error: ${rec.error || "no proposal"}`);
    process.exit(exitCode);
  }

  try {
    assertExtendsImmutable(currentPolicy, rec.proposedPolicy);
  } catch (err) {
    logEvent(logPath, `[sence] Rejected suggestion: ${err.message}`);
    process.exit(exitCode);
  }

  // Merge proposal into current policy so partial responses don't lose fields
  const mergedPolicy = mergePolicy(currentPolicy, rec.proposedPolicy);

  const policyDiff = diffPolicy(currentPolicy, mergedPolicy);
  if (!policyDiff) {
    logEvent(logPath, "[sence] No policy changes suggested.");
    process.exit(exitCode);
  }

  const errors = validatePolicy(mergedPolicy);
  if (errors.length > 0) {
    logEvent(logPath, "[sence] Refusing unsafe policy:");
    for (const e of errors) logEvent(logPath, `  - ${e}`);
    process.exit(exitCode);
  }

  // Step 1: Show policy diff, ask to apply
  const policyAccepted = await askPolicyApply({
    auditSummary,
    explanation: rec.explanation,
    policyDiff,
    paneId,
    logPath,
  });

  if (policyAccepted) {
    writePolicy(policyPath, mergedPolicy, { snapshotDir });
    logEvent(logPath, `[sence] Policy updated: ${policyPath}`);
  } else {
    logEvent(logPath, "[sence] Policy not changed.");
  }

  // Step 2: Prefill resume command in the pane (user reviews before running)
  // NOTE: The resume command is LLM-generated.
  if (rec.resumeCommand) {
    const resumeCmd = `sence --interactive -- ${rec.resumeCommand}`;
    logEvent(logPath, `[sence] Suggested resume command: ${resumeCmd}`);
    prefillInput(paneId, resumeCmd);
  }

  process.exit(exitCode);
}

function runAndMonitor({ fenceArgs, paneId, logPath }) {
  return new Promise((resolve) => {
    const child = spawn(fenceArgs[0], fenceArgs.slice(1), {
      stdio: ["inherit", "inherit", "inherit", "pipe"],
    });

    const denials = [];
    let debounceTimer = null;
    let interrupted = false;
    let exited = false;

    const cleanup = () => {
      if (!exited) {
        child.kill("SIGKILL");
      }
      process.exit(130);
    };
    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);

    teeMonitorLog(child.stdio[3], (line) => {
      if (!line.includes("✗")) return;
      denials.push(line);

      if (interrupted) return;
      interrupted = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        // ESC to interrupt agent, then kill
        sendEscape(paneId);
        setTimeout(() => {
          if (exited) return;
          child.kill("SIGTERM");
          setTimeout(() => {
            if (!exited) child.kill("SIGKILL");
          }, KILL_WAIT_MS);
        }, ESC_WAIT_MS);
      }, DEBOUNCE_MS);
    }, { logPath });

    // Mark exited early so the kill-ladder above short-circuits, but wait
    // for "close" so the fd3 pipe drains and no trailing denial is lost.
    child.on("exit", () => {
      exited = true;
    });

    child.on("close", (code, signal) => {
      if (debounceTimer) clearTimeout(debounceTimer);
      process.removeListener("SIGINT", cleanup);
      process.removeListener("SIGTERM", cleanup);
      resolve({ exitCode: code ?? (signal ? 128 : 0), denials });
    });
  });
}

async function askPolicyApply({ auditSummary, explanation, policyDiff, paneId, logPath }) {
  const lines = [];
  lines.push("=== Sandbox Violation ===");
  lines.push("");
  for (const net of auditSummary.deniedNetwork) lines.push(`  denied network: ${net.host}:${net.port}`);
  for (const file of auditSummary.deniedFiles) lines.push(`  denied file: ${file.path} (${file.action})`);
  lines.push("");
  if (explanation) lines.push(`Recommendation: ${explanation}`);
  lines.push("");
  lines.push("Proposed policy diff:");
  lines.push(policyDiff);
  lines.push("");
  const content = lines.join("\n");

  if (supportsPopup()) {
    const tmpDir = mkdtempSync(join(tmpdir(), "sence-review-"));
    const reviewFile = join(tmpDir, "review.txt");
    const scriptFile = join(tmpDir, "review.sh");
    const resultFile = join(tmpDir, "result");

    writeFileSync(reviewFile, content);
    writeFileSync(scriptFile, [
      "#!/bin/sh",
      `cat ${shellQuote(reviewFile)}`,
      `printf "Apply this policy change? [y/N] "`,
      `read answer`,
      `case "$answer" in`,
      `  y|Y|yes|YES) echo "ACCEPTED" > ${shellQuote(resultFile)} ;;`,
      `  *) echo "REJECTED" > ${shellQuote(resultFile)} ;;`,
      `esac`,
    ].join("\n") + "\n");

    displayPopup({ command: `sh ${shellQuote(scriptFile)}` });

    try {
      return readFileSync(resultFile, "utf-8").trim() === "ACCEPTED";
    } catch {
      return false;
    }
  }

  // No popup (tmux < 3.2): cannot prompt without polluting the pane.
  // Log the proposal and reject so the user has a record and no silent apply.
  logEvent(logPath, "[sence] Cannot prompt for review — tmux popup unavailable. Rejecting by default.");
  logEvent(logPath, content);
  return false;
}
