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

  it("instructs to output JSON fence.json", () => {
    const prompt = buildPrompt({
      currentPolicy: {},
      auditSummary: { status: "failed", deniedFiles: [], deniedNetwork: [], suspiciousActions: [], likelyFailureCauses: [] },
    });
    assert.ok(prompt.includes("fence.json"));
    assert.ok(prompt.includes("proposedPolicy"));
  });

  it("includes credential path restrictions", () => {
    const prompt = buildPrompt({
      currentPolicy: {},
      auditSummary: { status: "failed", deniedFiles: [], deniedNetwork: [], suspiciousActions: [], likelyFailureCauses: [] },
    });
    assert.ok(prompt.includes("credential"));
    assert.ok(prompt.includes(".ssh"));
  });

  it("forbids changing extends and template switching", () => {
    const prompt = buildPrompt({
      currentPolicy: { extends: "code" },
      auditSummary: { status: "failed", deniedFiles: [], deniedNetwork: [], suspiciousActions: [], likelyFailureCauses: [] },
    });
    assert.ok(/Never change "extends"/.test(prompt));
    assert.ok(/Do not propose switching templates/.test(prompt));
  });

  it("injects the baseline template snapshot when extends is set", () => {
    const prompt = buildPrompt({
      currentPolicy: { extends: "code" },
      auditSummary: { status: "failed", deniedFiles: [], deniedNetwork: [], suspiciousActions: [], likelyFailureCauses: [] },
    });
    // A handful of entries that should be present from docs/fence-templates/code.json
    assert.ok(prompt.includes('"extends": "code"'));
    assert.ok(prompt.includes("registry.npmjs.org"));
    assert.ok(prompt.includes("git push"));
    assert.ok(/do NOT duplicate them into the child policy/.test(prompt));
  });

  it("falls back to empty-baseline note when no extends", () => {
    const prompt = buildPrompt({
      currentPolicy: {},
      auditSummary: { status: "failed", deniedFiles: [], deniedNetwork: [], suspiciousActions: [], likelyFailureCauses: [] },
    });
    assert.ok(/does not extend a template/.test(prompt));
  });
});

describe("loadExtendsTemplate", () => {
  it("returns null when currentPolicy has no extends", () => {
    assert.equal(loadExtendsTemplate({}), null);
    assert.equal(loadExtendsTemplate(null), null);
  });

  it("returns the snapshot JSON for known templates", () => {
    const tmpl = loadExtendsTemplate({ extends: "code" });
    assert.equal(tmpl.name, "code");
    assert.ok(tmpl.json.includes("registry.npmjs.org"));
    // Snapshot must parse as JSON so prompt injection stays valid.
    assert.doesNotThrow(() => JSON.parse(tmpl.json));
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
  it("parses valid JSON response with proposed policy", () => {
    const output = JSON.stringify({
      proposedPolicy: { network: { allowedDomains: ["registry.npmjs.org"] } },
      explanation: "Allow npm registry access for dependency installation.",
    });
    const result = parseRecommendation(output);
    assert.ok(result.proposedPolicy);
    assert.deepEqual(result.proposedPolicy.network.allowedDomains, ["registry.npmjs.org"]);
    assert.ok(result.explanation);
    assert.equal(result.autoApplied, false);
  });

  it("extracts JSON from markdown code block", () => {
    const output = `Here is the recommendation:

\`\`\`json
{
  "proposedPolicy": { "network": { "allowedDomains": ["example.com"] } },
  "explanation": "Allow example.com"
}
\`\`\``;
    const result = parseRecommendation(output);
    assert.deepEqual(result.proposedPolicy.network.allowedDomains, ["example.com"]);
  });

  it("returns error result when output is not parseable", () => {
    const result = parseRecommendation("I cannot help with that.");
    assert.ok(result.error);
    assert.equal(result.autoApplied, false);
  });

  it("always sets autoApplied to false", () => {
    const output = JSON.stringify({
      proposedPolicy: {},
      explanation: "No changes needed.",
    });
    const result = parseRecommendation(output);
    assert.equal(result.autoApplied, false);
  });

  it("picks the first object when codex emits duplicated JSON", () => {
    // codex sometimes concatenates the same structured output twice.
    // extractFirstJson handles this via brace-counting.
    const first = {
      proposedPolicy: { network: { allowedDomains: ["first.example.com"] } },
      explanation: "first",
    };
    const second = {
      proposedPolicy: { network: { allowedDomains: ["second.example.com"] } },
      explanation: "second",
    };
    const output = JSON.stringify(first) + JSON.stringify(second);
    const result = parseRecommendation(output);
    assert.deepEqual(result.proposedPolicy.network.allowedDomains, ["first.example.com"]);
    assert.equal(result.explanation, "first");
  });
});
