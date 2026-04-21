import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isInsideTmux } from "../src/tmux.js";

describe("tmux helpers", () => {
  it("isInsideTmux returns boolean", () => {
    const result = isInsideTmux();
    assert.equal(typeof result, "boolean");
  });
});
