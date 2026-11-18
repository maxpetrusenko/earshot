import { existsSync, readFileSync, readdirSync, rmSync, rmdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWrite, backup, InstallError, PKG_ROOT, type Result } from "./shared.js";

/**
 * The Claude Code "Play button" mod. Claude Code 2.1.x auto-loads a plugin folder placed at
 * `<claude dir>/skills/<name>/` (`claude plugin init` scaffolds there; it loads as `<name>@skills-dir`),
 * so installing is copying four files. The buttons draw only inside Claude Code's own UI.
 */
export const MOD_NAME = "earshot-player";
export const MOD_FILES = [".claude-plugin/plugin.json", "hooks/hooks.json", "hooks/register.tsx", "types/index.d.ts"];

const srcDir = () => join(PKG_ROOT, "integrations", "claude-code", "mod", MOD_NAME);
export const modDir = (claudeDir: string) => join(claudeDir, "skills", MOD_NAME);

function foreign(dir: string): boolean {
  const manifest = join(dir, ".claude-plugin", "plugin.json");
  if (!existsSync(manifest)) return existsSync(dir) && readdirSync(dir).length > 0;
  try {
    return (JSON.parse(readFileSync(manifest, "utf8")) as { name?: string }).name !== MOD_NAME;
  } catch {
    return true;
  }
}

/** Copy the mod in. Idempotent; a changed file is backed up first. Refuses a folder that is not ours. */
export function installMod(claudeDir: string): Result[] {
  const dir = modDir(claudeDir);
  if (foreign(dir)) throw new InstallError(`${dir} exists and is not the earshot mod; move it first, nothing was changed`);
  const out: Result[] = [];
  for (const rel of MOD_FILES) {
    const src = join(srcDir(), rel);
    if (!existsSync(src)) throw new InstallError(`${src} is missing from the package`);
    const text = readFileSync(src, "utf8");
    const dest = join(dir, rel);
    if (existsSync(dest) && readFileSync(dest, "utf8") === text) {
      out.push({ changed: false, path: dest, backup: null, note: "mod file already installed" });
      continue;
    }
    const b = backup(dest);
    atomicWrite(dest, text);
    out.push({ changed: true, path: dest, backup: b, note: b ? "mod file updated" : "mod file installed" });
  }
  return out;
}

/** Remove the mod's files and the folder when nothing else is left in it. */
export function uninstallMod(claudeDir: string): Result[] {
  const dir = modDir(claudeDir);
  if (!existsSync(dir)) return [{ changed: false, path: dir, backup: null, note: "mod not installed" }];
  if (foreign(dir)) throw new InstallError(`${dir} was not installed by earshot; leaving it alone`);
  for (const rel of MOD_FILES) rmSync(join(dir, rel), { force: true });
  // Claude Code writes editor types here once it has loaded the mod; they are regenerated, not ours to keep.
  rmSync(join(dir, ".claude-plugin", "types"), { recursive: true, force: true });
  for (const rel of MOD_FILES) {
    for (let d = dirname(join(dir, rel)); d !== dirname(dir) && d.startsWith(dir); d = dirname(d)) {
      if (existsSync(d) && readdirSync(d).length === 0) rmdirSync(d);
    }
  }
  const left = existsSync(dir);
  return [{ changed: true, path: dir, backup: null, note: left ? "mod removed (folder kept, other files remain)" : "mod removed" }];
}
