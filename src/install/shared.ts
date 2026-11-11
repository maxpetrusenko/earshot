import { execFileSync } from "node:child_process";
import { chmodSync, chownSync, copyFileSync, existsSync, mkdirSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Helpers shared by the Codex and MCP installers. They mirror the ones in claude-code.ts
 * (copied, not imported, so that file stays untouched).
 */

export class InstallError extends Error {}

export const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Every earshot-owned notify argv starts with `env EARSHOT_HOOK=1`; nothing else is treated as ours. */
export const OWN_ENV = "EARSHOT_HOOK=1";

export const q = (s: string) => (/[\s"'$`\\]/.test(s) ? JSON.stringify(s) : s);

export function onPath(cmd: string): boolean {
  try {
    execFileSync("which", [cmd], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function builtFile(rel: string): string {
  const p = join(PKG_ROOT, "dist", rel);
  if (!existsSync(p)) throw new InstallError(`${p} does not exist. Run: pnpm build`);
  return p;
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

/** Copy a file to `<path>.earshot-bak-<time>` with the same mode. Null when there is nothing to back up. */
export function backup(path: string): string | null {
  if (!existsSync(path)) return null;
  const b = `${path}.earshot-bak-${stamp()}`;
  copyFileSync(path, b);
  chmodSync(b, statSync(path).mode & 0o7777);
  return b;
}

/**
 * Write through a symlink to the real file, next to it, keeping its mode and (when allowed) owner.
 * A temp file plus rename keeps the update atomic without replacing the link or loosening 0600.
 */
export function atomicWrite(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const real = existsSync(path) ? realpathSync(path) : path;
  const tmp = `${real}.${process.pid}.tmp`;
  const old = existsSync(real) ? statSync(real) : null;
  writeFileSync(tmp, text, { mode: old ? old.mode & 0o7777 : 0o644 });
  if (old) {
    chmodSync(tmp, old.mode & 0o7777);
    try {
      chownSync(tmp, old.uid, old.gid);
    } catch {
      /* not permitted; keep our own owner */
    }
  }
  renameSync(tmp, real);
}

export interface Result {
  changed: boolean;
  path: string;
  backup: string | null;
  note: string;
}

/** argv that runs the lean hook entry: `earshot-hook` when on PATH, else node + the built file. */
export function hookArgv(bin?: string): string[] {
  if (bin) return bin.split(/\s+/).filter(Boolean);
  if (onPath("earshot-hook")) return ["earshot-hook"];
  return [process.execPath, builtFile("hook-entry.js")];
}

/** argv that runs the full CLI. */
export function cliArgv(bin?: string): string[] {
  if (bin) return bin.split(/\s+/).filter(Boolean);
  if (onPath("earshot")) return ["earshot"];
  return [process.execPath, builtFile("cli.js")];
}
