import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { buildFenceArgs } from "../executor.js";
import { audit } from "../auditor.js";
import { callCodex } from "../suggester.js";
import { ensurePolicy, writePolicy, diffPolicy, validatePolicy, mergePolicy, defaultPolicyForProfile } from "../policy.js";
import { isInsideTmux, sendEscape, capturePaneContent, displayPopup, supportsPopup, currentPane, prefillInput } from "../tmux.js";
import { shellQuote } from "../cli.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHEATSHEET = readFileSync(join(__dirname, "..", "..", "docs", "fence-cheatsheet.md"), "utf-8");
const INTERACTIVE_SCHEMA = join(__dirname, "..", "..", "docs", "interactive-schema.json");

const DEBOUNCE_MS = 1500;

const ESC_WAIT_MS = 2000;
const KILL_WAIT_MS = 3000;

function buildInteractivePrompt({ currentPolicy, auditSummary, screenContent, originalCommand }) {
  return `## Task

Propose the minimal safe fence.json policy change, and if possible, the exact command to resume the agent session.

## Rules

- Never allow credential paths listed in the Reference below.
- Return the complete resulting fence.json in proposedPolicy, not a partial diff.
- Make the smallest safe change from the current fence.json.
- Keep "extends" if present.
- Prefer narrow domain wildcards (e.g. "*.npmjs.org") over broad ones.
- Set resumeCommand to null if you cannot find the session ID in the screen content.

## Reference

${CHEATSHEET}

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

export async function runInteractiveMode({ command, policyPath, snapshotDir, profile, suggest = "auto", model }) {
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
  const fenceArgs = buildFenceArgs({ command, settingsPath: policyPath, isolateStderr: true });

  const { exitCode, denials } = await runAndMonitor({ fenceArgs, paneId });

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
    process.stderr.write(`[sence] ${denials.length} denial(s) detected. Skipping suggestions (--suggest never).\n`);
    process.exit(exitCode);
  }

  // Suggest
  process.stderr.write("[sence] Analyzing sandbox violations...\n");
  const rec = runInteractiveSuggester({
    currentPolicy,
    auditSummary,
    screenContent,
    originalCommand: command,
    model,
  });

  if (rec.error || !rec.proposedPolicy) {
    process.stderr.write(`[sence] Suggester error: ${rec.error || "no proposal"}\n`);
    process.exit(exitCode);
  }

  // Merge proposal into current policy so partial responses don't lose fields
  const mergedPolicy = mergePolicy(currentPolicy, rec.proposedPolicy);

  const policyDiff = diffPolicy(currentPolicy, mergedPolicy);
  if (!policyDiff) {
    process.stderr.write("[sence] No policy changes suggested.\n");
    process.exit(exitCode);
  }

  const errors = validatePolicy(mergedPolicy);
  if (errors.length > 0) {
    process.stderr.write("[sence] Refusing unsafe policy:\n");
    for (const e of errors) process.stderr.write(`  - ${e}\n`);
    process.exit(exitCode);
  }

  // Step 1: Show policy diff, ask to apply
  const policyAccepted = await askPolicyApply({
    auditSummary,
    explanation: rec.explanation,
    policyDiff,
    paneId,
  });

  if (policyAccepted) {
    writePolicy(policyPath, mergedPolicy, { snapshotDir });
    process.stderr.write(`[sence] Policy updated: ${policyPath}\n`);
  } else {
    process.stderr.write("[sence] Policy not changed.\n");
  }

  // Step 2: Show resume command and prefill in the pane
  // NOTE: The resume command is LLM-generated. Review before executing.
  if (rec.resumeCommand) {
    const resumeCmd = `sence --interactive -- ${rec.resumeCommand}`;
    process.stderr.write(`\nSuggested resume command (review before running):\n  ${resumeCmd}\n`);
    prefillInput(paneId, resumeCmd);
  }

  process.exit(exitCode);
}

function runAndMonitor({ fenceArgs, paneId }) {
  return new Promise((resolve) => {
    const child = spawn(fenceArgs[0], fenceArgs.slice(1), {
      stdio: ["inherit", "inherit", "pipe", process.stderr.fd],
    });

    const denials = [];
    let debounceTimer = null;

    // Clean up child on Ctrl-C
    const cleanup = () => {
      if (!exited) {
        child.kill("SIGKILL");
      }
      process.exit(130);
    };
    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);
    let interrupted = false;
    let exited = false;

    const stderrRl = createInterface({ input: child.stderr });

    stderrRl.on("line", (line) => {
      if (!line.startsWith("[fence:")) {
        if (!line.startsWith("[fence]")) process.stderr.write(line + "\n");
        return;
      }
      if (!line.includes("✗")) return;

      denials.push(line);

      if (!interrupted) {
        interrupted = true;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          // ESC to interrupt agent, then kill
          sendEscape(paneId);
          setTimeout(() => {
            if (exited) return;
            child.kill("SIGTERM");
            // SIGKILL fallback: check if process actually exited, not just child.killed
            setTimeout(() => {
              if (!exited) child.kill("SIGKILL");
            }, KILL_WAIT_MS);
          }, ESC_WAIT_MS);
        }, DEBOUNCE_MS);
      }
    });

    child.on("exit", (code, signal) => {
      exited = true;
      stderrRl.close();
      if (debounceTimer) clearTimeout(debounceTimer);
      process.removeListener("SIGINT", cleanup);
      process.removeListener("SIGTERM", cleanup);
      resolve({ exitCode: code ?? (signal ? 128 : 0), denials });
    });
  });
}

async function askPolicyApply({ auditSummary, explanation, policyDiff, paneId }) {
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

  // Fallback: stderr
  process.stderr.write(content);
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question("Apply this policy change? [y/N] ", (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes");
    });
  });
}
