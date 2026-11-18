import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InstallError } from "../src/install/shared.js";
import { installMod, MOD_FILES, modDir, uninstallMod } from "../src/install/claude-mod.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "earshot-mod-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("claude-code --mode mod", () => {
  it("installs the four mod files under skills/earshot-player, idempotently", () => {
    const r = installMod(home);
    expect(r.every((x) => x.changed)).toBe(true);
    for (const f of MOD_FILES) expect(existsSync(join(modDir(home), f))).toBe(true);
    expect(JSON.parse(readFileSync(join(modDir(home), ".claude-plugin", "plugin.json"), "utf8")).name).toBe("earshot-player");
    expect(existsSync(join(modDir(home), "hooks", "register.test.tsx"))).toBe(false);
    expect(installMod(home).every((x) => !x.changed)).toBe(true);
  });

  it("backs up a modified file before restoring it", () => {
    installMod(home);
    const reg = join(modDir(home), "hooks", "register.tsx");
    writeFileSync(reg, "// local edit\n");
    const r = installMod(home).find((x) => x.path === reg)!;
    expect(r.changed).toBe(true);
    expect(readFileSync(r.backup!, "utf8")).toBe("// local edit\n");
  });

  it("refuses a folder it does not own", () => {
    mkdirSync(modDir(home), { recursive: true });
    writeFileSync(join(modDir(home), "mine.txt"), "x");
    expect(() => installMod(home)).toThrow(InstallError);
    expect(() => uninstallMod(home)).toThrow(InstallError);
    expect(readdirSync(modDir(home))).toEqual(["mine.txt"]);
  });

  it("uninstalls cleanly and tolerates a second run", () => {
    installMod(home);
    mkdirSync(join(modDir(home), ".claude-plugin", "types"), { recursive: true });
    expect(uninstallMod(home)[0]?.changed).toBe(true);
    expect(existsSync(modDir(home))).toBe(false);
    expect(uninstallMod(home)[0]?.changed).toBe(false);
  });

  it("CLI: --mode mod install and uninstall honour CLAUDE_CONFIG_DIR and leave the default mode alone", () => {
    const root = join(import.meta.dirname, "..");
    execFileSync("pnpm", ["build"], { cwd: root, stdio: "ignore" });
    const env = { ...process.env, CLAUDE_CONFIG_DIR: home, EARSHOT_HOME: join(home, "e") };
    const run = (...a: string[]) => execFileSync("node", [join(root, "dist", "cli.js"), ...a], { env, encoding: "utf8" });
    run("install", "claude-code", "--mode", "mod");
    expect(existsSync(join(home, "skills", "earshot-player", "hooks", "register.tsx"))).toBe(true);
    expect(existsSync(join(home, "skills", "earshot", "SKILL.md"))).toBe(false);
    run("uninstall", "claude-code", "--mode", "mod");
    expect(existsSync(join(home, "skills", "earshot-player"))).toBe(false);
  }, 60_000);
});
