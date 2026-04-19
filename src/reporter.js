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
