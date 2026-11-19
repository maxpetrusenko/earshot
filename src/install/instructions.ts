import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWrite, backup, builtFile, InstallError, onPath, PKG_ROOT, q, type Result } from "./shared.js";

/**
 * Agents with no Stop-hook output channel (Codex, Cursor) get the same required-final-step instruction
 * the Claude Code skill carries, in the file the agent always reads: a marked block in Codex's
 * AGENTS.md, a whole `alwaysApply` rule for Cursor. The agent runs `earshot run` itself and prints
 * the links, which is the only way a link reaches the chat.
 */

const START = "<!-- earshot-managed:start -->";
const END = "<!-- earshot-managed:end -->";
const RULE_MARKER = "<!-- earshot-managed -->";

export function instructionBody(bin: string): string {
  return readFileSync(join(PKG_ROOT, "integrations", "instructions", "earshot.md"), "utf8").replaceAll("{{EARSHOT}}", bin).trimEnd();
}

export function instructionBin(bin?: string): string {
  if (bin) return bin;
  if (onPath("earshot")) return "earshot";
  return `node ${q(builtFile("cli.js"))}`;
}

export function codexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), ".codex");
}

export function cursorHome(): string {
  return process.env.CURSOR_CONFIG_DIR ?? join(homedir(), ".cursor");
}

/** Other agents that read a global instruction file. The block is the same one Codex gets. */
export const FILE_AGENTS: Record<string, () => string> = {
  opencode: () => join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode", "AGENTS.md"),
  gemini: () => join(homedir(), ".gemini", "GEMINI.md"),
  droid: () => join(homedir(), ".factory", "AGENTS.md"),
};

const block = (bin: string) => `${START}\n${instructionBody(bin)}\n${END}`;

function findBlock(text: string): { start: number; end: number } | null {
  const s = text.indexOf(START);
  if (s < 0) return null;
  const e = text.indexOf(END, s);
  if (e < 0) throw new InstallError("an earshot block has a start marker and no end marker; fix the file first, nothing was changed");
  return { start: s, end: e + END.length };
}

/** Add or update the marked block in an AGENTS.md. Text outside the markers is never touched. */
export function installAgentsBlock(file: string, bin: string): Result {
  const cur = existsSync(file) ? readFileSync(file, "utf8") : "";
  const want = block(bin);
  const at = findBlock(cur);
  let next: string;
  if (at) {
    if (cur.slice(at.start, at.end) === want) return { changed: false, path: file, backup: null, note: "instructions already installed" };
    next = cur.slice(0, at.start) + want + cur.slice(at.end);
  } else {
    next = cur === "" ? `${want}\n` : `${cur.replace(/\n*$/, "")}\n\n${want}\n`;
  }
  const b = backup(file);
  atomicWrite(file, next);
  return { changed: true, path: file, backup: b, note: at ? "instructions updated" : "instructions installed" };
}

export function uninstallAgentsBlock(file: string): Result {
  if (!existsSync(file)) return { changed: false, path: file, backup: null, note: "no AGENTS.md" };
  const cur = readFileSync(file, "utf8");
  const at = findBlock(cur);
  if (!at) return { changed: false, path: file, backup: null, note: "instructions not installed" };
  const before = cur.slice(0, at.start).replace(/\n*$/, "");
  const after = cur.slice(at.end).replace(/^\n*/, "");
  const next = before && after ? `${before}\n\n${after}` : `${before}${after}`;
  const b = backup(file);
  atomicWrite(file, next === "" || next.endsWith("\n") ? next : `${next}\n`);
  return { changed: true, path: file, backup: b, note: "instructions removed" };
}

const ruleText = (bin: string) =>
  `---\ndescription: End every reply with earshot Listen and Original links\nalwaysApply: true\n---\n${RULE_MARKER}\n\n${instructionBody(bin)}\n`;

export function installCursorRule(dir: string, bin: string): Result {
  const file = join(dir, "rules", "earshot.mdc");
  const text = ruleText(bin);
  if (existsSync(file)) {
    const cur = readFileSync(file, "utf8");
    if (cur === text) return { changed: false, path: file, backup: null, note: "rule already installed" };
    if (!cur.includes(RULE_MARKER)) throw new InstallError(`${file} exists and was not installed by earshot; move it first, nothing was changed`);
  }
  const b = backup(file);
  atomicWrite(file, text);
  return { changed: true, path: file, backup: b, note: b ? "rule updated" : "rule installed" };
}

export function uninstallCursorRule(dir: string): Result {
  const file = join(dir, "rules", "earshot.mdc");
  if (!existsSync(file)) return { changed: false, path: file, backup: null, note: "rule not installed" };
  if (!readFileSync(file, "utf8").includes(RULE_MARKER)) throw new InstallError(`${file} was not installed by earshot; leaving it alone`);
  rmSync(file);
  return { changed: true, path: file, backup: null, note: "rule removed" };
}

/**
 * Cursor has no global rules file the CLI reads (only project rules, AGENTS.md and user rules kept in the
 * app). A user-level `sessionStart` hook can add context to the conversation instead: it runs for the
 * IDE agent and for cursor-agent, and `additional_context` goes into the model's context.
 */
const CURSOR_HOOK_TOKEN = "EARSHOT_HOOK=1 ";
type Json = Record<string, unknown>;

function readHooksFile(file: string): Json {
  if (!existsSync(file)) return { version: 1, hooks: {} };
  let v: unknown;
  try {
    v = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new InstallError(`${file} is not valid JSON (${(e as Error).message.split("\n")[0]}); fix it first, nothing was changed`);
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new InstallError(`${file} must contain a JSON object`);
  const o = v as Json;
  if (o.hooks !== undefined && (typeof o.hooks !== "object" || o.hooks === null || Array.isArray(o.hooks))) throw new InstallError(`${file} "hooks" must be an object`);
  return o;
}

const startEntries = (o: Json): Json[] => {
  const h = ((o.hooks as Json | undefined) ?? {}).sessionStart;
  if (h === undefined) return [];
  if (!Array.isArray(h)) throw new InstallError('hooks.json "hooks.sessionStart" must be an array');
  return h as Json[];
};
const isOursEntry = (e: Json) => typeof e.command === "string" && e.command.startsWith(CURSOR_HOOK_TOKEN);

export function cursorSessionCommand(bin: string): string {
  return `${CURSOR_HOOK_TOKEN}${bin} cursor-session-start`;
}

export function installCursorHook(dir: string, bin: string): Result {
  const file = join(dir, "hooks.json");
  const doc = readHooksFile(file);
  const entries = startEntries(doc);
  const command = cursorSessionCommand(bin);
  const mine = entries.find(isOursEntry);
  if (mine && mine.command === command) return { changed: false, path: file, backup: null, note: "hook already installed" };
  const b = backup(file);
  if (mine) mine.command = command;
  else entries.push({ command, timeout: 10 });
  const hooks = ((doc.hooks as Json | undefined) ?? {}) as Json;
  hooks.sessionStart = entries;
  doc.hooks = hooks;
  if (doc.version === undefined) doc.version = 1;
  atomicWrite(file, `${JSON.stringify(doc, null, 2)}\n`);
  return { changed: true, path: file, backup: b, note: mine ? "hook updated" : "hook installed" };
}

export function uninstallCursorHook(dir: string): Result {
  const file = join(dir, "hooks.json");
  if (!existsSync(file)) return { changed: false, path: file, backup: null, note: "no hooks.json" };
  const doc = readHooksFile(file);
  const entries = startEntries(doc);
  const kept = entries.filter((e) => !isOursEntry(e));
  if (kept.length === entries.length) return { changed: false, path: file, backup: null, note: "hook not installed" };
  const b = backup(file);
  const hooks = doc.hooks as Json;
  if (kept.length) hooks.sessionStart = kept;
  else delete hooks.sessionStart;
  atomicWrite(file, `${JSON.stringify(doc, null, 2)}\n`);
  return { changed: true, path: file, backup: b, note: "hook removed" };
}

/** What the sessionStart hook prints. */
export function cursorSessionOutput(bin: string): string {
  return JSON.stringify({ additional_context: instructionBody(bin) });
}
