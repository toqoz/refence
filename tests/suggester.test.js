import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildPrompt, parseRecommendation, loadExtendsTemplate } from "../src/suggester.js";

describe("buildPrompt", () => {
  it("includes current policy JSON", () => {
    const prompt = buildPrompt({
      currentPolicy: { network: { allowedDomains: [] } },
      auditSummary: { status: "failed", deniedFiles: [], deniedNetwork: [], suspiciousActions: [], likelyFailureCauses: [] },
    });
    assert.ok(prompt.includes('"allowedDomains"'));
  });

  it("includes audit summary", () => {
    const prompt = buildPrompt({
      currentPolicy: {},
      auditSummary: {
        status: "failed",
        deniedFiles: [],
        deniedNetwork: [{ host: "registry.npmjs.org", port: 443, severity: "medium" }],
        suspiciousActions: [],
        likelyFailureCauses: ["network egress denied"],
      },
    });
    assert.ok(prompt.includes("registry.npmjs.org"));
    assert.ok(prompt.includes("network egress denied"));
  });

  it("instructs to output proposedAdditions", () => {
    const prompt = buildPrompt({
      currentPolicy: {},
      auditSummary: { status: "failed", deniedFiles: [], deniedNetwork: [], suspiciousActions: [], likelyFailureCauses: [] },
    });
    assert.ok(prompt.includes("proposedAdditions"));
    assert.ok(prompt.includes("riskLevel"));
  });

  it("includes credential path restrictions", () => {
    const prompt = buildPrompt({
      currentPolicy: {},
      auditSummary: { status: "failed", deniedFiles: [], deniedNetwork: [], suspiciousActions: [], likelyFailureCauses: [] },
    });
    assert.ok(prompt.includes("credential"));
    assert.ok(prompt.includes(".ssh"));
  });

  it("tells the LLM not to re-list existing entries", () => {
    const prompt = buildPrompt({
      currentPolicy: { extends: "code" },
      auditSummary: { status: "failed", deniedFiles: [], deniedNetwork: [], suspiciousActions: [], likelyFailureCauses: [] },
    });
    assert.ok(/do NOT need to emit the full fence\.json/.test(prompt));
    assert.ok(/re-list\s+entries/.test(prompt));
  });

  it("injects the baseline template snapshot when extends is set", () => {
    const prompt = buildPrompt({
      currentPolicy: { extends: "code" },
      auditSummary: { status: "failed", deniedFiles: [], deniedNetwork: [], suspiciousActions: [], likelyFailureCauses: [] },
    });
    // A handful of entries that should be present from src/references/fence-templates/code.json
    assert.ok(prompt.includes('"extends": "code"'));
    assert.ok(prompt.includes("registry.npmjs.org"));
    assert.ok(prompt.includes("git push"));
    assert.ok(/already granted/i.test(prompt));
  });

  it("falls back to empty-baseline note when no extends", () => {
    const prompt = buildPrompt({
      currentPolicy: {},
      auditSummary: { status: "failed", deniedFiles: [], deniedNetwork: [], suspiciousActions: [], likelyFailureCauses: [] },
    });
    assert.ok(/does not extend a template/.test(prompt));
  });

  it("tells the LLM to cover every denial", () => {
    const prompt = buildPrompt({
      currentPolicy: {},
      auditSummary: {
        status: "failed",
        deniedFiles: [{ path: "/x", action: "file-read-data", severity: "low" }],
        deniedNetwork: [{ host: "a.com", port: 443, severity: "medium" }],
        suspiciousActions: [],
        likelyFailureCauses: [],
      },
    });
    assert.ok(/Cover EVERY denial/i.test(prompt));
  });
});

describe("loadExtendsTemplate", () => {
  it("returns null when currentPolicy has no extends", () => {
    assert.equal(loadExtendsTemplate({}), null);
    assert.equal(loadExtendsTemplate(null), null);
  });

  it("returns the snapshot JSON and parsed entries for known templates", () => {
    const tmpl = loadExtendsTemplate({ extends: "code" });
    assert.equal(tmpl.name, "code");
    assert.ok(tmpl.json.includes("registry.npmjs.org"));
    // Snapshot must parse as JSON so prompt injection stays valid.
    assert.doesNotThrow(() => JSON.parse(tmpl.json));
    assert.ok(tmpl.entries);
    assert.ok(tmpl.entries.network.allowedDomains.includes("registry.npmjs.org"));
  });

  it("returns null for an unknown template name", () => {
    assert.equal(loadExtendsTemplate({ extends: "does-not-exist" }), null);
  });

  it("ships a snapshot for every allowed template", () => {
    // Mirror of ALLOWED_EXTENDS in src/policy.js. If that list grows,
    // bin/refresh-fence-templates.sh must be re-run and this list updated.
    const allowed = ["code", "code-strict", "code-relaxed", "local-dev-server"];
    for (const name of allowed) {
      const tmpl = loadExtendsTemplate({ extends: name });
      assert.ok(tmpl, `missing snapshot for extends: ${name}`);
      assert.doesNotThrow(() => JSON.parse(tmpl.json));
    }
  });
});

describe("parseRecommendation", () => {
  it("parses valid JSON response with proposedAdditions", () => {
    const output = JSON.stringify({
      proposedAdditions: [
        { kind: "network.allow", value: "registry.npmjs.org", riskLevel: "low", rationale: "npm install needs it", relatedDenial: "net:registry.npmjs.org:443" },
      ],
      explanation: "Allow npm registry access for dependency installation.",
    });
    const result = parseRecommendation(output);
    assert.ok(Array.isArray(result.proposedAdditions));
    assert.equal(result.proposedAdditions.length, 1);
    assert.equal(result.proposedAdditions[0].value, "registry.npmjs.org");
    assert.equal(result.explanation, "Allow npm registry access for dependency installation.");
    assert.equal(result.autoApplied, false);
  });

  it("extracts JSON from markdown code block", () => {
    const output = `Here is the recommendation:

\`\`\`json
{
  "proposedAdditions": [
    { "kind": "network.allow", "value": "example.com", "riskLevel": "low", "rationale": "needed", "relatedDenial": null }
  ],
  "explanation": "Allow example.com"
}
\`\`\``;
    const result = parseRecommendation(output);
    assert.equal(result.proposedAdditions[0].value, "example.com");
    assert.equal(result.proposedAdditions[0].kind, "network.allow");
  });

  it("returns error result when output is not parseable", () => {
    const result = parseRecommendation("I cannot help with that.");
    assert.ok(result.error);
    assert.equal(result.autoApplied, false);
  });

  it("always sets autoApplied to false", () => {
    const output = JSON.stringify({
      proposedAdditions: [],
      explanation: "No changes needed.",
    });
    const result = parseRecommendation(output);
    assert.equal(result.autoApplied, false);
  });

  it("picks the first object when codex emits duplicated JSON", () => {
    // codex sometimes concatenates the same structured output twice.
    // extractFirstJson handles this via brace-counting.
    const first = {
      proposedAdditions: [{ kind: "network.allow", value: "first.example.com", riskLevel: "low", rationale: "a", relatedDenial: null }],
      explanation: "first",
    };
    const second = {
      proposedAdditions: [{ kind: "network.allow", value: "second.example.com", riskLevel: "low", rationale: "b", relatedDenial: null }],
      explanation: "second",
    };
    const output = JSON.stringify(first) + JSON.stringify(second);
    const result = parseRecommendation(output);
    assert.equal(result.proposedAdditions[0].value, "first.example.com");
    assert.equal(result.explanation, "first");
  });

  it("preserves resumeCommand for interactive schema responses", () => {
    const output = JSON.stringify({
      proposedAdditions: [],
      explanation: "none",
      resumeCommand: "claude -c abc",
    });
    const result = parseRecommendation(output);
    assert.equal(result.resumeCommand, "claude -c abc");
  });

  it("preserves title when present and defaults to empty string otherwise", () => {
    const withTitle = parseRecommendation(JSON.stringify({
      proposedAdditions: [],
      explanation: "none",
      title: "npm registry",
    }));
    assert.equal(withTitle.title, "npm registry");

    const without = parseRecommendation(JSON.stringify({
      proposedAdditions: [],
      explanation: "none",
    }));
    assert.equal(without.title, "");
  });
});
