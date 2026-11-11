import { execFileSync } from "node:child_process";
import { chmodSync, chownSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type Mode = "skill" | "hook";
export type Scope = "user" | "project";

export class InstallError extends Error {}

export interface InstallOptions {
  mode: Mode;
  scope: Scope;
  /** Project root for scope=project. Default: the current directory. */
  cwd?: string;
  /** Override the earshot invocation, e.g. "earshot". Default: earshot if on PATH, else node + absolute path. */
  bin?: string;
  log?: (line: string) => void;
}

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MARKER = "<!-- earshot-managed -->";
/** Every command earshot installs starts with this env assignment; nothing else is ever treated as ours. */
export const HOOK_TOKEN = "EARSHOT_HOOK=1";

export function claudeDir(scope: Scope, cwd: string): string {
  if (scope === "project") return join(cwd, ".claude");
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

const q = (s: string) => (/[\s"'$`\\]/.test(s) ? JSON.stringify(s) : s);

function onPath(cmd: string): boolean {
  try {
    execFileSync("which", [cmd], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function builtFile(rel: string): string {
  const p = join(PKG_ROOT, "dist", rel);
  if (!existsSync(p)) throw new InstallError(`${p} does not exist. Run: pnpm build`);
  return p;
}

/** The command a skill runs. */
export function earshotInvocation(bin?: string): string {
  if (bin) return bin;
  if (onPath("earshot")) return "earshot";
  return `node ${q(builtFile("cli.js"))}`;
}

/** The command a Stop hook runs: the lean entry point, not the full CLI. */
export function hookInvocation(bin?: string): string {
  if (bin) return `${HOOK_TOKEN} ${bin}`;
  if (onPath("earshot-hook")) return `${HOOK_TOKEN} earshot-hook`;
  return `${HOOK_TOKEN} node ${q(builtFile("hook-entry.js"))}`;
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function backup(path: string): string | null {
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
function atomicWrite(path: string, text: string): void {
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

type Json = Record<string, unknown>;

function readSettings(path: string): Json {
  if (!existsSync(path)) return {};
  let v: unknown;
  try {
    v = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new InstallError(`${path} is not valid JSON (${(e as Error).message.split("\n")[0]}); fix it first, nothing was changed`);
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new InstallError(`${path} must contain a JSON object`);
  return v as Json;
}

interface HookEntry {
  type?: string;
  command?: string;
  [k: string]: unknown;
}
interface Group {
  matcher?: string;
  hooks?: HookEntry[];
  [k: string]: unknown;
}

function stopGroups(settings: Json): Group[] {
  const hooks = settings.hooks;
  if (hooks === undefined) return [];
  if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) throw new InstallError('settings "hooks" must be an object');
  const stop = (hooks as Json).Stop;
  if (stop === undefined) return [];
  if (!Array.isArray(stop)) throw new InstallError('settings "hooks.Stop" must be an array');
  stop.forEach((g, i) => {
    const bad = (why: string) => new InstallError(`settings hooks.Stop[${i}] ${why}; fix it first, nothing was changed`);
    if (typeof g !== "object" || g === null || Array.isArray(g)) throw bad("is not an object");
    const hs = (g as Group).hooks;
    if (hs === undefined) return;
    if (!Array.isArray(hs)) throw bad('has a "hooks" that is not an array');
    hs.forEach((h, j) => {
      if (typeof h !== "object" || h === null || Array.isArray(h)) throw bad(`hooks[${j}] is not an object`);
    });
  });
  return stop as Group[];
}

const isOurs = (h: HookEntry) => typeof h.command === "string" && h.command.startsWith(`${HOOK_TOKEN} `);

export interface Result {
  changed: boolean;
  path: string;
  backup: string | null;
  note: string;
}

/** Add the Stop hook without touching anything else. Idempotent; a changed command is updated in place. */
export function installHook(settingsPath: string, command: string): Result {
  const settings = readSettings(settingsPath);
  const groups = stopGroups(settings);
  for (const g of groups) {
    for (const h of g.hooks ?? []) {
      if (!isOurs(h)) continue;
      if (h.command === command) return { changed: false, path: settingsPath, backup: null, note: "hook already installed" };
      const b = backup(settingsPath);
      h.command = command;
      atomicWrite(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
      return { changed: true, path: settingsPath, backup: b, note: "hook command updated" };
    }
  }
  const b = backup(settingsPath);
  const hooks = ((settings.hooks as Json | undefined) ?? {}) as Json;
  hooks.Stop = [...groups, { hooks: [{ type: "command", command, timeout: 10 }] }];
  settings.hooks = hooks;
  atomicWrite(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  return { changed: true, path: settingsPath, backup: b, note: "hook installed" };
}

/** Remove only earshot's hook entries; prune a group or key only if we emptied it. */
export function uninstallHook(settingsPath: string): Result {
  if (!existsSync(settingsPath)) return { changed: false, path: settingsPath, backup: null, note: "no settings file" };
  const settings = readSettings(settingsPath);
  const groups = stopGroups(settings);
  let removed = 0;
  const kept: Group[] = [];
  for (const g of groups) {
    const before = g.hooks?.length ?? 0;
    const hooks = (g.hooks ?? []).filter((h) => !isOurs(h));
    removed += before - hooks.length;
    if (before > 0 && hooks.length === 0) continue;
    kept.push(before === hooks.length ? g : { ...g, hooks });
  }
  if (!removed) return { changed: false, path: settingsPath, backup: null, note: "hook not installed" };
  const b = backup(settingsPath);
  const hooks = settings.hooks as Json;
  if (kept.length) hooks.Stop = kept;
  else delete hooks.Stop;
  if (Object.keys(hooks).length === 0) delete settings.hooks;
  atomicWrite(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  return { changed: true, path: settingsPath, backup: b, note: "hook removed" };
}

export function renderSkill(bin: string): string {
  return readFileSync(join(PKG_ROOT, "integrations", "claude-code", "skills", "earshot", "SKILL.md"), "utf8").replaceAll("{{EARSHOT}}", bin);
}

export function installSkill(skillDir: string, bin: string): Result {
  const file = join(skillDir, "SKILL.md");
  const text = renderSkill(bin);
  if (existsSync(file)) {
    const cur = readFileSync(file, "utf8");
    if (cur === text) return { changed: false, path: file, backup: null, note: "skill already installed" };
    if (!cur.includes(MARKER)) throw new InstallError(`${file} exists and was not installed by earshot; move it first, nothing was changed`);
  }
  const b = backup(file);
  atomicWrite(file, text);
  return { changed: true, path: file, backup: b, note: b ? "skill updated" : "skill installed" };
}

export function uninstallSkill(skillDir: string): Result {
  const file = join(skillDir, "SKILL.md");
  if (!existsSync(file)) return { changed: false, path: file, backup: null, note: "skill not installed" };
  if (!readFileSync(file, "utf8").includes(MARKER)) throw new InstallError(`${file} was not installed by earshot; leaving it alone`);
  rmSync(file);
  if (readdirSync(skillDir).length === 0) rmdirSync(skillDir);
  return { changed: true, path: file, backup: null, note: "skill removed" };
}

export function install(o: InstallOptions): Result[] {
  const cwd = o.cwd ?? process.cwd();
  const base = claudeDir(o.scope, cwd);
  const out: Result[] = [];
  if (o.mode === "skill") {
    out.push(installSkill(join(base, "skills", "earshot"), earshotInvocation(o.bin)));
    const hookFile = join(base, "settings.json");
    if (existsSync(hookFile) && stopGroups(readSettings(hookFile)).some((g) => (g.hooks ?? []).some(isOurs))) {
      o.log?.("warning: the Stop hook is also installed here. Both modes make one memo each; the hook skips a session the skill narrated within 30 seconds.");
    }
  } else {
    out.push(installHook(join(base, "settings.json"), hookInvocation(o.bin)));
  }
  return out;
}

export function uninstall(o: { scope: Scope; cwd?: string }): Result[] {
  const base = claudeDir(o.scope, o.cwd ?? process.cwd());
  return [uninstallSkill(join(base, "skills", "earshot")), uninstallHook(join(base, "settings.json"))];
}
