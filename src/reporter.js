export function formatText(exec, audit, rec) {
  const lines = [];

  lines.push(`[sence] command: ${exec.command.join(" ")}`);
  lines.push(`[sence] profile: ${exec.profile}`);
  lines.push(`[sence] exit: ${exec.exitCode}`);
  lines.push("");

  if (audit.deniedNetwork.length > 0 || audit.deniedFiles.length > 0) {
    lines.push("Audit summary:");
    for (const net of audit.deniedNetwork) {
      lines.push(`  - denied network: ${net.host}:${net.port}`);
    }
    for (const file of audit.deniedFiles) {
      lines.push(`  - denied file: ${file.path} (${file.action})`);
    }
    if (audit.likelyFailureCauses.length > 0) {
      for (const cause of audit.likelyFailureCauses) {
        lines.push(`  - likely cause: ${cause}`);
      }
    }
    lines.push("");
  }

  if (rec.error) {
    lines.push(`Recommendation error: ${rec.error}`);
    if (rec.rawOutput) {
      lines.push(`  output: ${rec.rawOutput}`);
    }
    lines.push("");
  } else if (rec.explanation) {
    lines.push(`Recommendation: ${rec.explanation}`);
    lines.push("");
  }

  if (Array.isArray(rec.acceptedAdditions) && rec.acceptedAdditions.length > 0) {
    lines.push("Proposed additions:");
    for (const a of rec.acceptedAdditions) {
      const risk = a.riskLevel ?? "?";
      const rationale = a.rationale ? ` — ${a.rationale}` : "";
      lines.push(`  [${risk}] ${a.kind} ${a.value}${rationale}`);
    }
    lines.push("");
  }

  if (Array.isArray(rec.blockedAdditions) && rec.blockedAdditions.length > 0) {
    lines.push("Blocked by sence safety rules (not applied):");
    for (const b of rec.blockedAdditions) {
      lines.push(`  ! ${b.kind} ${b.value} — ${b.blockReason}`);
    }
    lines.push("");
  }

  if (rec.policyDiff) {
    lines.push("Proposed policy diff:");
    lines.push(rec.policyDiff);
    lines.push("");
  }

  lines.push("No changes were applied automatically.");

  return lines.join("\n");
}

export function formatJson(exec, audit, rec) {
  return JSON.stringify(
    {
      execution: {
        command: exec.command,
        exitCode: exec.exitCode,
        profile: exec.profile,
      },
      audit,
      recommendation: rec,
    },
    null,
    2,
  );
}
