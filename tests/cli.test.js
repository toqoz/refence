import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, senseExecName } from "../src/cli.js";

describe("parseArgs", () => {
  it("parses bare command", () => {
    const result = parseArgs(["claude", "-p", "fix tests"]);
    assert.deepEqual(result.command, ["claude", "-p", "fix tests"]);
    assert.equal(result.suggest, "auto");
    assert.equal(result.report, "text");
    assert.equal(result.profile, "default");
    assert.equal(result.verbose, false);
  });

  it("parses command after --", () => {
    const result = parseArgs(["--", "claude", "-p", "fix tests"]);
    assert.deepEqual(result.command, ["claude", "-p", "fix tests"]);
  });

  it("parses --suggest option", () => {
    const result = parseArgs(["--suggest", "never", "--", "echo", "hi"]);
    assert.equal(result.suggest, "never");
    assert.deepEqual(result.command, ["echo", "hi"]);
  });

  it("rejects --suggest always (removed)", () => {
    const result = parseArgs(["--suggest", "always", "echo", "hi"]);
    assert.ok(result.error);
  });

  it("parses --suggest never", () => {
    const result = parseArgs(["--suggest", "never", "echo", "hi"]);
    assert.equal(result.suggest, "never");
  });

  it("parses --report json", () => {
    const result = parseArgs(["--report", "json", "echo", "hi"]);
    assert.equal(result.report, "json");
  });

  it("parses --profile option", () => {
    const result = parseArgs(["--profile", "strict", "echo", "hi"]);
    assert.equal(result.profile, "strict");
    assert.deepEqual(result.command, ["echo", "hi"]);
  });

  it("parses --verbose flag", () => {
    const result = parseArgs(["--verbose", "echo", "hi"]);
    assert.equal(result.verbose, true);
  });

  it("parses --help flag", () => {
    const result = parseArgs(["--help"]);
    assert.equal(result.help, true);
    assert.equal(result.error, null);
  });

  it("parses --version flag", () => {
    const result = parseArgs(["--version"]);
    assert.equal(result.version, true);
    assert.equal(result.error, null);
  });

  it("returns error when no command given", () => {
    const result = parseArgs([]);
    assert.ok(result.error);
  });

  it("returns error when only flags given", () => {
    const result = parseArgs(["--suggest", "auto"]);
    assert.ok(result.error);
  });

  it("stops parsing flags after first non-flag arg", () => {
    const result = parseArgs(["claude", "--suggest", "auto"]);
    assert.deepEqual(result.command, ["claude", "--suggest", "auto"]);
    assert.equal(result.suggest, "auto"); // default
  });

  it("rejects invalid --suggest value", () => {
    const result = parseArgs(["--suggest", "maybe", "echo", "hi"]);
    assert.ok(result.error);
    assert.ok(result.error.includes("maybe"));
  });

  it("rejects invalid --report value", () => {
    const result = parseArgs(["--report", "yaml", "echo", "hi"]);
    assert.ok(result.error);
    assert.ok(result.error.includes("yaml"));
  });

  it("parses --rollback without number", () => {
    const result = parseArgs(["--rollback"]);
    assert.equal(result.rollback, 1);
    assert.equal(result.error, null);
  });

  it("parses --rollback with number", () => {
    const result = parseArgs(["--rollback", "3"]);
    assert.equal(result.rollback, 3);
    assert.equal(result.error, null);
  });

  it("parses --patch option", () => {
    const result = parseArgs(["--patch", "/tmp/policy.json", "echo", "hi"]);
    assert.equal(result.patch, "/tmp/policy.json");
    assert.deepEqual(result.command, ["echo", "hi"]);
  });

  it("parses --suggest never with --interactive", () => {
    const result = parseArgs(["--suggest", "never", "--interactive", "--", "claude", "-p", "hi"]);
    assert.equal(result.suggest, "never");
    assert.equal(result.interactive, true);
    assert.equal(result.error, null);
  });

  it("rejects invalid --suggest with --interactive", () => {
    const result = parseArgs(["--suggest", "maybe", "--interactive", "--", "claude"]);
    assert.ok(result.error);
    assert.ok(result.error.includes("maybe"));
  });

  it("parses --tail with a path and ignores the absent command", () => {
    const result = parseArgs(["--tail", "/tmp/monitor.log"]);
    assert.equal(result.tail, "/tmp/monitor.log");
    assert.equal(result.error, null);
    assert.deepEqual(result.command, []);
  });

  it("returns error when --tail is missing its value", () => {
    const result = parseArgs(["--tail"]);
    assert.ok(result.error);
    assert.ok(result.error.includes("--tail"));
  });

});

describe("senseExecName", () => {
  let tmp;
  let origArgv1;
  let origPath;
  let origCwd;

  beforeEach(() => {
    // Resolve realpath so macOS /var → /private/var symlinks don't break the
    // cwd-relative comparison inside senseExecName.
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "sence-exec-")));
    origArgv1 = process.argv[1];
    origPath = process.env.PATH;
    origCwd = process.cwd();
  });

  afterEach(() => {
    process.argv[1] = origArgv1;
    process.env.PATH = origPath;
    process.chdir(origCwd);
    rmSync(tmp, { recursive: true, force: true });
  });

  function makeExe(dir, name) {
    mkdirSync(dir, { recursive: true });
    const p = join(dir, name);
    writeFileSync(p, "#!/bin/sh\nexit 0\n");
    chmodSync(p, 0o755);
    return p;
  }

  it("returns 'sence' when argv[1] is undefined", () => {
    process.argv[1] = undefined;
    assert.equal(senseExecName(), "sence");
  });

  it("returns argv[1] as-is when the file does not exist", () => {
    const ghost = join(tmp, "does-not-exist");
    process.argv[1] = ghost;
    process.env.PATH = "";
    assert.equal(senseExecName(), ghost);
  });

  it("collapses to basename when PATH resolves to the same file", () => {
    const exe = makeExe(join(tmp, "bin"), "sence");
    process.argv[1] = exe;
    process.env.PATH = join(tmp, "bin");
    assert.equal(senseExecName(), "sence");
  });

  it("does not collapse when the first PATH match is a different file", () => {
    const real = makeExe(join(tmp, "real"), "sence");
    makeExe(join(tmp, "fake"), "sence");
    process.argv[1] = real;
    process.env.PATH = [join(tmp, "fake"), join(tmp, "real")].join(":");
    process.chdir(tmp);
    assert.equal(senseExecName(), "real/sence");
  });

  it("skips directory PATH entries with the same basename", () => {
    const exe = makeExe(join(tmp, "bin"), "sence");
    mkdirSync(join(tmp, "dirfirst", "sence"), { recursive: true });
    process.argv[1] = exe;
    process.env.PATH = [join(tmp, "dirfirst"), join(tmp, "bin")].join(":");
    assert.equal(senseExecName(), "sence");
  });

  it("skips non-executable PATH entries with the same basename", () => {
    const exe = makeExe(join(tmp, "bin"), "sence");
    mkdirSync(join(tmp, "nonx"), { recursive: true });
    const nonx = join(tmp, "nonx", "sence");
    writeFileSync(nonx, "");
    chmodSync(nonx, 0o644);
    process.argv[1] = exe;
    process.env.PATH = [join(tmp, "nonx"), join(tmp, "bin")].join(":");
    assert.equal(senseExecName(), "sence");
  });

  it("uses cwd-relative form when argv[1] is nested under cwd", () => {
    const exe = makeExe(join(tmp, "bin"), "sence");
    process.argv[1] = exe;
    process.env.PATH = "";
    process.chdir(tmp);
    assert.equal(senseExecName(), "bin/sence");
  });

  it("prefixes ./ for a bare basename directly under cwd", () => {
    const exe = join(tmp, "sence");
    writeFileSync(exe, "#!/bin/sh\n");
    chmodSync(exe, 0o755);
    process.argv[1] = exe;
    process.env.PATH = "";
    process.chdir(tmp);
    assert.equal(senseExecName(), "./sence");
  });

  it("keeps the absolute path when argv[1] is outside cwd", () => {
    const exe = makeExe(join(tmp, "elsewhere"), "sence");
    process.argv[1] = exe;
    process.env.PATH = "";
    // cwd remains origCwd (the repo root), which is outside tmp.
    assert.equal(senseExecName(), exe);
  });
});
