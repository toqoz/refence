import { spawn } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { buildFenceArgs, teeMonitorLog } from "../executor.js";
import { audit, isSignificantDenial } from "../auditor.js";
import { callCodex, loadExtendsTemplate } from "../suggester.js";
import {
  ensurePolicy,
  diffPolicy,
  validatePolicy,
  mergePolicy,
  defaultPolicyForProfile,
  additionsToPatch,
  assessAddition,
} from "../policy.js";
import {
  isInsideTmux,
  capturePaneContent,
  currentPane,
  openSplitPane,
  killPane,
} from "../tmux.js";
import { shellQuote } from "../cli.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHEATSHEET = readFileSync(join(__dirname, "..", "..", "docs", "fence-cheatsheet.md"), "utf-8");
const INTERACTIVE_SCHEMA = join(__dirname, "..", "..", "docs", "interactive-schema.json");

function buildInteractivePrompt({ currentPolicy, auditSummary, screenContent, originalCommand }) {
  const tmpl = loadExtendsTemplate(currentPolicy);
  const templateSection = tmpl
    ? `## Baseline from "extends": "${tmpl.name}"

fence(1) merges this template under the current fence.json at runtime. Treat
every entry below as already granted — no need to propose them.

\`\`\`json
${tmpl.json.trim()}
\`\`\`
`
    : `## Baseline

The current fence.json does not extend a template; it starts from an empty
policy.
`;

  return `## Task

Propose a flat list of additions to the child fence.json so the agent can
resume, and if possible the exact command to resume the agent session.

You do NOT need to emit the full fence.json, diff existing arrays, or re-list
entries that are already granted. sence will append your additions to the
existing arrays, dedupe against current and the baseline template, and reject
any entry that violates the safety rules below.

## Rules

- Cover EVERY denial in the audit. Each \`deniedFiles\` / \`deniedNetwork\`
  entry should produce at least one addition, unless intentionally skipped
  for safety (note in rationale).
- Every addition must directly address a denial from the audit above.
  Do NOT propose tightening (extra command.deny, network.deny, etc.) for
  anything that was not denied — the goal is the smallest change to resume
  the agent, not a hardening pass.
- Prefer narrow wildcards ("*.npmjs.org") over broad ones ("*").
- Never propose credential paths under allowRead/allowWrite (sence will
  block them regardless). Never propose broad home globs.
- Assign riskLevel per entry: "low" / "medium" / "high". Informational only.
- Set relatedDenial to a short trace string identifying the unblocked denial.
- Set resumeCommand to null if the session ID is not visible in the screen.

## Reference

${CHEATSHEET}

${templateSection}
## Original command

${JSON.stringify(originalCommand)}

## Current fence.json (child)

${JSON.stringify(currentPolicy, null, 2)}

## Audit (denied events)

${JSON.stringify(auditSummary, null, 2)}

## Captured screen content

\`\`\`
${screenContent.slice(-4000)}
\`\`\`

## Output

Reply with ONLY this JSON:

{"proposedAdditions":[{"kind":"...","value":"...","riskLevel":"low|medium|high","rationale":"...","relatedDenial":"..."}],"explanation":"one short sentence","resumeCommand":"command to resume or null"}`;
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

  // Open a split pane tailing the monitor log so the user can watch fence
  // denials stream by in real time and decide when (if at all) to interrupt
  // the agent themselves. sence never intervenes mid-run.
  const logPaneId = openLogTailPane({ target: paneId, logPath });

  const { exitCode, denials } = await runAndCollect({ fenceArgs, logPath });

  if (logPaneId) killPane(logPaneId);

  if (denials.length === 0) {
    process.exit(exitCode);
  }

  // Agent has exited; it's safe to write to stderr now (no TUI to corrupt).
  const screenContent = capturePaneContent(paneId);
  const auditSummary = audit({ exitCode, monitorLog: denials.join("\n") });

  process.stderr.write(formatAuditHeader(auditSummary));

  if (suggest === "never") {
    process.exit(exitCode);
  }

  const rec = runInteractiveSuggester({
    currentPolicy,
    auditSummary,
    screenContent,
    originalCommand: command,
    model,
  });

  if (rec.error || !Array.isArray(rec.proposedAdditions)) {
    process.stderr.write(`[sence] Suggester error: ${rec.error ?? "no proposal"}\n`);
    process.exit(exitCode);
  }

  const accepted = [];
  const blocked = [];
  for (const add of rec.proposedAdditions) {
    const verdict = assessAddition(add);
    if (verdict.block) blocked.push({ ...add, blockReason: verdict.reason });
    else accepted.push(add);
  }

  const tmpl = loadExtendsTemplate(currentPolicy);
  const patch = additionsToPatch(currentPolicy, accepted, { templateEntries: tmpl?.entries ?? null });
  const merged = mergePolicy(currentPolicy, patch);
  const policyDiff = diffPolicy(currentPolicy, merged);
  const policyErrors = validatePolicy(merged);

  process.stderr.write(formatSuggestion({
    explanation: rec.explanation,
    accepted,
    blocked,
    policyDiff,
    policyErrors,
  }));

  if (policyDiff && policyErrors.length === 0) {
    const tmpDir = mkdtempSync(join(tmpdir(), "sence-"));
    const patchFile = join(tmpDir, "policy.json");
    writeFileSync(patchFile, JSON.stringify(patch, null, 2) + "\n");

    const suffix = rec.resumeCommand ? rec.resumeCommand : command.map(shellQuote).join(" ");
    const reRunCmd = buildReRunCommand({ patchFile, profile, suffix });
    const label = rec.resumeCommand ? "To apply and resume" : "To apply and re-run";
    process.stderr.write(`\n${label}:\n  ${reRunCmd}\n`);
  }

  process.exit(exitCode);
}

function openLogTailPane({ target, logPath }) {
  if (!logPath) return null;
  const q = shellQuote(logPath);
  // Truncate the log so each run starts fresh, then `tail -F` so the pane
  // keeps following even if the file is (re)created.
  const inner = `: > ${q}; printf "[sence] monitor log: %s\\n" ${q}; exec tail -F ${q}`;
  const cmd = `sh -c ${shellQuote(inner)}`;
  return openSplitPane({ target, command: cmd, size: "8" });
}

function runAndCollect({ fenceArgs, logPath }) {
  return new Promise((resolve) => {
    const child = spawn(fenceArgs[0], fenceArgs.slice(1), {
      stdio: ["inherit", "inherit", "inherit", "pipe"],
    });

    const denials = [];

    // Keep sence alive while the child handles SIGINT — the TTY delivered it
    // to both processes, and exiting sence first would tear down fd3 and the
    // split pane mid-write.
    const onSignal = () => {};
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);

    teeMonitorLog(child.stdio[3], (line) => {
      if (isSignificantDenial(line)) denials.push(line);
    }, { logPath });

    child.on("close", (code, signal) => {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
      resolve({
        exitCode: code ?? (signal ? 128 : 0),
        denials,
      });
    });
  });
}

function formatAuditHeader(auditSummary) {
  const lines = ["[sence] Audit summary:"];
  for (const net of auditSummary.deniedNetwork) {
    lines.push(`  - denied network: ${net.host}:${net.port}`);
  }
  for (const file of auditSummary.deniedFiles) {
    lines.push(`  - denied file: ${file.path} (${file.action})`);
  }
  lines.push("");
  return lines.join("\n");
}

function formatSuggestion({ explanation, accepted, blocked, policyDiff, policyErrors }) {
  const lines = [];
  if (explanation) {
    lines.push(`Recommendation: ${explanation}`);
    lines.push("");
  }
  if (accepted.length > 0) {
    lines.push("Proposed additions:");
    for (const a of accepted) {
      const risk = a.riskLevel ?? "?";
      const rationale = a.rationale ? ` — ${a.rationale}` : "";
      lines.push(`  [${risk}] ${a.kind} ${a.value}${rationale}`);
    }
    lines.push("");
  }
  if (blocked.length > 0) {
    lines.push("Blocked by sence safety rules (not applied):");
    for (const b of blocked) {
      lines.push(`  ! ${b.kind} ${b.value} — ${b.blockReason}`);
    }
    lines.push("");
  }
  if (policyErrors.length > 0) {
    lines.push("Refusing unsafe policy:");
    for (const e of policyErrors) lines.push(`  - ${e}`);
    lines.push("");
  } else if (policyDiff) {
    lines.push("Proposed policy diff:");
    lines.push(policyDiff);
    lines.push("");
  } else {
    lines.push("No policy changes suggested.");
    lines.push("");
  }
  return lines.join("\n");
}

function buildReRunCommand({ patchFile, profile, suffix }) {
  const parts = ["sence", "--patch", shellQuote(patchFile)];
  if (profile !== "default") parts.push("--profile", shellQuote(profile));
  parts.push("--interactive", "--", suffix);
  return parts.join(" ");
}
