import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHEATSHEET = readFileSync(join(__dirname, "references", "fence-cheatsheet.md"), "utf-8");
const TEMPLATE_DIR = join(__dirname, "references", "fence-templates");
const SCHEMA_PATH = join(__dirname, "schema", "suggester-schema.json");

const DEFAULT_MODEL = "gpt-5.4-mini";

// Read the snapshot of the fence builtin template the current policy extends.
// Snapshots live under src/references/fence-templates/ and are refreshed via
// bin/refresh-fence-templates.sh. Returns { name, json, entries } or null.
export function loadExtendsTemplate(currentPolicy) {
  const name = currentPolicy?.extends;
  if (!name) return null;
  const path = join(TEMPLATE_DIR, `${name}.json`);
  if (!existsSync(path)) return null;
  const json = readFileSync(path, "utf-8");
  let entries = null;
  try {
    entries = JSON.parse(json);
  } catch {
    entries = null;
  }
  return { name, json, entries };
}

export function buildPrompt({ currentPolicy, auditSummary }) {
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

The current fence.json does not extend a template. It starts from an empty
policy; every allowance must be proposed explicitly.
`;

  return `Propose a flat list of additions to the child fence.json so the audit below stops failing.

You do NOT need to emit the full fence.json, diff existing arrays, or re-list
entries that are already granted. sence will append your additions to the
existing arrays, dedupe against the current policy and the baseline template,
and reject any entry that violates the safety rules below.

${CHEATSHEET}

${templateSection}
## Current fence.json (child)

${JSON.stringify(currentPolicy, null, 2)}

## Audit (one or more denials)

${JSON.stringify(auditSummary, null, 2)}

## Rules

- Cover EVERY denial in the audit. Each \`deniedFiles\` / \`deniedNetwork\`
  entry should produce at least one addition that would unblock it, unless
  you intentionally skip it for safety (noted in rationale).
- Every addition must directly address a denial from the audit above.
  Do NOT propose tightening (extra command.deny, network.deny, etc.) for
  anything that was not denied — the user asked for the smallest change
  to unblock the current run, not a hardening pass.
- Prefer narrow wildcards ("*.npmjs.org") over broad ones ("*").
- Never propose credential paths (~/.ssh, ~/.aws, ~/.gnupg, ~/.kube,
  ~/.docker, ~/.netrc, ~/.git-credentials, etc.) under allowRead/allowWrite.
  sence will block them — don't waste a slot.
- Never propose broad home globs like ~/** or /Users/<user>/**.
- Assign riskLevel per entry: "low" (narrow, non-sensitive), "medium"
  (broader scope or side effects), "high" (near credentials / broad write).
  sence applies its own static checks on top; riskLevel is informational.
- Set relatedDenial to a short trace string identifying which denial this
  addition unblocks (e.g. "net:registry.npmjs.org:443", "file:/Users/x/project read").

## Output

Reply with ONLY this JSON, nothing else:

{"proposedAdditions":[{"kind":"...","value":"...","riskLevel":"low|medium|high","rationale":"...","relatedDenial":"..."}],"explanation":"one short sentence","title":"2-5 word headline"}

The \`title\` becomes a slug in the patch filename. Prefer concrete nouns over
verbs and filler words, e.g. "npm registry", "example.com https", "project
read". Lowercase is fine; non-alphanumeric characters will be normalized.`;
}

// Extract the first top-level JSON object from a string by brace-counting.
// Needed because codex sometimes emits the response twice, concatenated.
function extractFirstJson(str) {
  const start = str.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < str.length; i++) {
    if (str[i] === "{") depth++;
    else if (str[i] === "}") depth--;
    if (depth === 0) {
      try {
        return JSON.parse(str.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function finalizeParsed(parsed) {
  if (!parsed || !Array.isArray(parsed.proposedAdditions)) return null;
  return {
    proposedAdditions: parsed.proposedAdditions,
    explanation: typeof parsed.explanation === "string" ? parsed.explanation : "",
    title: typeof parsed.title === "string" ? parsed.title : "",
    resumeCommand: Object.hasOwn(parsed, "resumeCommand") ? parsed.resumeCommand : undefined,
    autoApplied: false,
  };
}

export function parseRecommendation(output) {
  const base = { autoApplied: false };

  // Direct JSON parse
  try {
    const finalized = finalizeParsed(JSON.parse(output.trim()));
    if (finalized) return finalized;
  } catch {
    // fall through
  }

  // ```json ... ``` block
  const codeBlockMatch = output.match(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/);
  if (codeBlockMatch) {
    try {
      const finalized = finalizeParsed(JSON.parse(codeBlockMatch[1].trim()));
      if (finalized) return finalized;
    } catch {
      // fall through
    }
  }

  // First complete JSON object (handles codex duplicated output)
  const firstObj = extractFirstJson(output);
  const finalized = finalizeParsed(firstObj);
  if (finalized) return finalized;

  return { error: "Failed to parse recommendation from output", rawOutput: output, ...base };
}

export function callCodex({ prompt, schemaPath, model }) {
  const args = [
    "codex", "exec",
    "-m", model || DEFAULT_MODEL,
    "-c", 'web_search="disabled"',
    "-c", 'model_reasoning_effort="none"',
    "--sandbox", "read-only",
    "--ephemeral",
    "--skip-git-repo-check",
    "--output-schema", schemaPath,
    "-o", "/dev/stdout",
    "-",
  ];

  const result = spawnSync(args[0], args.slice(1), {
    input: prompt,
    encoding: "utf-8",
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024,
  });

  if (result.error) {
    return { error: `Suggester failed to start: ${result.error.message}`, autoApplied: false };
  }

  if (result.status !== 0) {
    return {
      error: `Suggester exited with code ${result.status}`,
      rawOutput: (result.stderr || result.stdout || "").slice(-2000),
      autoApplied: false,
    };
  }

  return parseRecommendation(result.stdout ?? "");
}

export function runSuggester({ currentPolicy, auditSummary, model }) {
  const prompt = buildPrompt({ currentPolicy, auditSummary });
  return callCodex({ prompt, schemaPath: SCHEMA_PATH, model });
}
