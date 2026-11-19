import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tailnetIpFromInterfaces } from "../src/baseurl.js";
import { installAgentsBlock, installCursorHook, installCursorRule, uninstallAgentsBlock, uninstallCursorHook, uninstallCursorRule } from "../src/install/instructions.js";
import { InstallError } from "../src/install/shared.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "earshot-instr-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("Codex AGENTS.md block", () => {
  it("adds a block after existing text, is idempotent, and uninstall restores the bytes", () => {
    const f = join(dir, "AGENTS.md");
    const orig = "# my rules\n\nkeep this\n";
    writeFileSync(f, orig);
    const r = installAgentsBlock(f, "earshot");
    expect(r.changed).toBe(true);
    const text = readFileSync(f, "utf8");
    expect(text.startsWith(orig)).toBe(true);
    expect(text).toContain("earshot run --format auto");
    expect(installAgentsBlock(f, "earshot").changed).toBe(false);
    expect(uninstallAgentsBlock(f).changed).toBe(true);
    expect(readFileSync(f, "utf8")).toBe(orig);
  });

  it("updates the block in place when the command changes and creates a missing file", () => {
    const f = join(dir, "new", "AGENTS.md");
    installAgentsBlock(f, "earshot");
    installAgentsBlock(f, "node /x/cli.js");
    const text = readFileSync(f, "utf8");
    expect(text.match(/earshot-managed:start/g)).toHaveLength(1);
    expect(text).toContain("node /x/cli.js run --format auto");
  });

  it("refuses a block with no end marker", () => {
    const f = join(dir, "AGENTS.md");
    writeFileSync(f, "<!-- earshot-managed:start -->\nhalf\n");
    expect(() => installAgentsBlock(f, "earshot")).toThrow(InstallError);
  });
});

describe("Cursor rule", () => {
  it("writes an alwaysApply rule, is idempotent and removes only its own file", () => {
    const r = installCursorRule(dir, "earshot");
    const text = readFileSync(r.path, "utf8");
    expect(text.startsWith("---\n")).toBe(true);
    expect(text).toContain("alwaysApply: true");
    expect(installCursorRule(dir, "earshot").changed).toBe(false);
    expect(uninstallCursorRule(dir).changed).toBe(true);
    expect(uninstallCursorRule(dir).changed).toBe(false);
  });

  it("never overwrites or removes a rule it did not write", () => {
    mkdirSync(join(dir, "rules"));
    writeFileSync(join(dir, "rules", "earshot.mdc"), "mine\n");
    expect(() => installCursorRule(dir, "earshot")).toThrow(InstallError);
    expect(() => uninstallCursorRule(dir)).toThrow(InstallError);
  });
});

describe("tailnet IP from interfaces", () => {
  const a = (address: string, family: "IPv4" | "IPv6" = "IPv4") => ({ address, family });
  it("picks an address in 100.64.0.0/10 only", () => {
    expect(tailnetIpFromInterfaces({ en0: [a("192.168.1.5")], utun4: [a("100.78.92.101")] })).toBe("100.78.92.101");
    expect(tailnetIpFromInterfaces({ en0: [a("100.200.1.1"), a("100.63.1.1"), a("fd7a::1", "IPv6")] })).toBeUndefined();
  });
});

describe("Cursor sessionStart hook", () => {
  it("merges beside other hooks, is idempotent and removes only its entry", () => {
    const f = join(dir, "hooks.json");
    const orig = { version: 1, hooks: { stop: [{ command: "orca" }], sessionStart: [{ command: "other" }] } };
    writeFileSync(f, JSON.stringify(orig));
    expect(installCursorHook(dir, "earshot").changed).toBe(true);
    const doc = JSON.parse(readFileSync(f, "utf8"));
    expect(doc.hooks.sessionStart).toHaveLength(2);
    expect(doc.hooks.sessionStart[1].command).toBe("EARSHOT_HOOK=1 earshot cursor-session-start");
    expect(installCursorHook(dir, "earshot").changed).toBe(false);
    expect(uninstallCursorHook(dir).changed).toBe(true);
    expect(JSON.parse(readFileSync(f, "utf8"))).toEqual(orig);
  });

  it("creates the file and refuses invalid JSON", () => {
    installCursorHook(dir, "earshot");
    expect(JSON.parse(readFileSync(join(dir, "hooks.json"), "utf8")).hooks.sessionStart).toHaveLength(1);
    writeFileSync(join(dir, "hooks.json"), "{nope");
    expect(() => installCursorHook(dir, "earshot")).toThrow(InstallError);
  });
});
