import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripEmpty } from "./policy.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHEATSHEET = readFileSync(join(__dirname, "..", "docs", "fence-cheatsheet.md"), "utf-8");
const TEMPLATE_DIR = join(__dirname, "..", "docs", "fence-templates");
const SCHEMA_PATH = join(__dirname, "..", "docs", "suggester-schema.json");

const DEFAULT_MODEL = "gpt-5.4-mini";

// Read the snapshot of the fence builtin template the current policy extends.
// Returns a string ready for prompt injection, or a short note if no extends
// is set. Snapshots live under docs/fence-templates/ and are refreshed via
// bin/refresh-fence-templates.sh.
export function loadExtendsTemplate(currentPolicy) {
  const name = currentPolicy?.extends;
  if (!name) return null;
  const path = join(TEMPLATE_DIR, `${name}.json`);
  if (!existsSync(path)) return null;
  return { name, json: readFileSync(path, "utf-8") };
}

export function buildPrompt({ currentPolicy, auditSummary }) {
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

The current fence.json does not extend a template. It starts from an empty
policy; everything must be expressed in the child.
`;

  return `Recommend a fence.json policy change based on the audit below.

${CHEATSHEET}

${templateSection}
## Current fence.json

${JSON.stringify(currentPolicy, null, 2)}

## Audit

${JSON.stringify(auditSummary, null, 2)}

## Rules

- Never allow credential paths listed in the Reference above.
- Never change "extends". If the current fence.json has one, keep the exact
  same value (or omit the field). Do not propose switching templates, even
  if a different template would match better — add the missing allowances
  to the current extends instead.
- Do not duplicate entries already present in the baseline template above;
  fence appends template arrays to the child's at runtime.
- Only include fields you are changing. Omit unchanged sections (set to null).
- When you do include an array, include the child's existing entries in it
  so they survive — sence replaces arrays on patch apply.
- Make the smallest safe change from the current fence.json.
- Prefer narrow wildcards (e.g. "*.npmjs.org") over broad ones.

## Output

Reply with ONLY this JSON, nothing else:

{"proposedPolicy":{...},"explanation":"one short sentence"}`;
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

export function parseRecommendation(output) {
  const base = { autoApplied: false };

  // Try direct JSON parse
  try {
    const parsed = JSON.parse(output.trim());
    if (parsed.proposedPolicy) return { ...parsed, proposedPolicy: stripEmpty(parsed.proposedPolicy), ...base };
  } catch {
    // fall through
  }

  // Try extracting from ```json ... ``` block
  const codeBlockMatch = output.match(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/);
  if (codeBlockMatch) {
    try {
      const parsed = JSON.parse(codeBlockMatch[1].trim());
      if (parsed.proposedPolicy) return { ...parsed, proposedPolicy: stripEmpty(parsed.proposedPolicy), ...base };
    } catch {
      // fall through
    }
  }

  // Try extracting the first complete JSON object (handles duplicated output from codex)
  const firstObj = extractFirstJson(output);
  if (firstObj && firstObj.proposedPolicy) {
    return { ...firstObj, proposedPolicy: stripEmpty(firstObj.proposedPolicy), ...base };
  }

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
