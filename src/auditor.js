import { CREDENTIAL_PATTERNS } from "./patterns.js";

// Path may contain spaces; capture everything up to the final " (process:pid)"
const FILE_DENIAL_RE =
  /^\[fence:logstream\]\s+\S+\s+✗\s+([\w-]+)\s+(.+)\s+\((\w+):(\d+)\)$/;

const NETWORK_DENIAL_RE =
  /^\[fence:http\]\s+\S+\s+✗\s+CONNECT\s+403\s+(\S+)\s+https?:\/\/\S+:(\d+)/;

export function isDenialLine(line) {
  return line.includes("✗");
}

function classifyFileSeverity(path) {
  for (const pattern of CREDENTIAL_PATTERNS) {
    if (pattern.test(path)) return "high";
  }
  if (path.startsWith("/etc/") || path.startsWith("/var/")) return "medium";
  if (path.startsWith("/tmp") || path.startsWith("/private/tmp")) return "medium";
  return "low";
}

function detectSuspiciousActions(deniedFiles) {
  const actions = [];
  for (const file of deniedFiles) {
    for (const pattern of CREDENTIAL_PATTERNS) {
      if (pattern.test(file.path)) {
        actions.push({
          kind: "credential_access",
          target: file.path,
          severity: "high",
        });
        break;
      }
    }
  }
  return actions;
}

function inferFailureCauses(exitCode, deniedNetwork, deniedFiles) {
  const causes = [];
  if (exitCode !== 0 && deniedNetwork.length > 0) {
    const hosts = deniedNetwork.map((d) => d.host).join(", ");
    causes.push(
      `network egress to ${hosts} was denied — command may require external access`,
    );
  }
  if (exitCode !== 0 && deniedFiles.some((f) => f.severity === "high")) {
    causes.push(
      "access to sensitive credential paths was denied",
    );
  }
  return causes;
}

export function audit({ exitCode, monitorLog }) {
  const lines = monitorLog.split("\n").filter((l) => l.length > 0);
  const deniedFiles = [];
  const deniedNetwork = [];

  for (const line of lines) {
    const fileMatch = line.match(FILE_DENIAL_RE);
    if (fileMatch) {
      const [, action, path, process] = fileMatch;
      deniedFiles.push({
        path,
        action,
        process,
        severity: classifyFileSeverity(path),
      });
      continue;
    }

    const netMatch = line.match(NETWORK_DENIAL_RE);
    if (netMatch) {
      const [, host, port] = netMatch;
      deniedNetwork.push({
        host,
        port: parseInt(port, 10),
        severity: "medium",
      });
    }
  }

  const suspiciousActions = detectSuspiciousActions(deniedFiles);
  const likelyFailureCauses = inferFailureCauses(exitCode, deniedNetwork, deniedFiles);

  return {
    status: exitCode === 0 ? "success" : "failed",
    deniedFiles,
    deniedNetwork,
    suspiciousActions,
    likelyFailureCauses,
  };
}
