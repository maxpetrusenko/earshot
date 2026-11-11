import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWrite, backup, hookArgv, InstallError, OWN_ENV, q, type Result } from "./shared.js";
import {
  eolOf, insertLines, isHeader, parseDoc, pathEq, pathStarts, removeRange, replaceLines, rootStmts, scan, sectionEnd, splitLines, stripEol, tomlArray, tomlString, verifyEdit,
  type Doc, type Stmt,
} from "./toml.js";

/**
 * Codex CLI config (~/.codex/config.toml): the `notify` program and the `[mcp_servers.earshot]` table.
 * Ownership is exact. A notify argv is ours only when it starts with `env EARSHOT_HOOK=1`; an MCP table is
 * ours only when the line above its header is the marker comment. Everything else is left untouched, and
 * every write is verified: the result must parse to the old file plus exactly our keys, or nothing is written.
 */

export const NOTIFY_MARKER = "# earshot-managed: notify";
export const MCP_MARKER = "# earshot-managed: mcp";
const MCP_PATH = ["mcp_servers", "earshot"];

export class ForeignNotifyError extends InstallError {}

export function codexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), ".codex");
}
export const codexConfigPath = () => join(codexHome(), "config.toml");

/** The notify argv earshot installs. Codex appends the notification JSON as the last argument. */
export function notifyArgv(bin?: string): string[] {
  return ["env", OWN_ENV, ...hookArgv(bin), "codex"];
}

const isOursArr = (v: unknown): v is string[] => Array.isArray(v) && v[0] === "env" && v[1] === OWN_ENV;

interface Loaded {
  text: string;
  doc: Doc;
  lines: string[];
  stmts: Stmt[];
  eol: string;
}

function load(path: string): Loaded {
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  const doc = parseDoc(text, path);
  let stmts: Stmt[];
  try {
    stmts = scan(text);
  } catch (e) {
    throw new InstallError(`${path}: cannot locate its statements (${(e as Error).message}); nothing was changed`);
  }
  return { text, doc, lines: splitLines(text), stmts, eol: eolOf(text) };
}

/** Verify, back up, write. Returns the backup path. */
function commit(path: string, L: Loaded, lines: string[], change: (d: Doc) => void): string | null {
  const out = lines.join("");
  verifyEdit(path, L.text, out, change);
  const b = backup(path);
  atomicWrite(path, out);
  return b;
}

const markerAt = (lines: string[], idx: number, marker: string) => idx > 0 && stripEol(lines[idx - 1]!) === marker;

export function installNotify(path: string, argv: string[]): Result {
  const L = load(path);
  const hit = rootStmts(L.stmts).find((s) => s.path[0] === "notify");
  const value = `notify = ${tomlArray(argv)}`;
  const set = (d: Doc) => void (d.notify = argv);
  if (hit || L.doc.notify !== undefined) {
    if (!hit || !pathEq(hit.path, ["notify"]) || !isOursArr(L.doc.notify)) {
      const shown = hit ? L.lines.slice(hit.start, hit.end).map(stripEol).join(" ").replace(/\s+/g, " ").trim() : JSON.stringify(L.doc.notify);
      throw new ForeignNotifyError(
        `${path} already sets notify to another program: ${shown}\n` +
          `Left unchanged. To use both, make your program call earshot too, for example add this line to it:\n` +
          `  ${argv.slice(1).map(q).join(" ")} "$1"\n` +
          `(or set notify to that wrapper yourself). Codex allows only one notify program.`,
      );
    }
    const marked = markerAt(L.lines, hit.start, NOTIFY_MARKER);
    if (marked && (L.doc.notify as string[]).join("\0") === argv.join("\0")) return { changed: false, path, backup: null, note: "notify already installed" };
    const lines = [...L.lines];
    replaceLines(lines, marked ? hit.start - 1 : hit.start, hit.end, [NOTIFY_MARKER, value], L.eol);
    return { changed: true, path, backup: commit(path, L, lines, set), note: "notify updated" };
  }
  const roots = rootStmts(L.stmts);
  const lines = [...L.lines];
  insertLines(lines, roots.length ? roots[roots.length - 1]!.end : 0, [NOTIFY_MARKER, value], L.eol);
  return { changed: true, path, backup: commit(path, L, lines, set), note: "notify installed" };
}

export function uninstallNotify(path: string): Result {
  if (!existsSync(path)) return { changed: false, path, backup: null, note: "no config file" };
  const L = load(path);
  const hit = rootStmts(L.stmts).find((s) => s.path[0] === "notify");
  if (!hit && L.doc.notify === undefined) return { changed: false, path, backup: null, note: "notify not installed" };
  if (!hit || !pathEq(hit.path, ["notify"]) || !isOursArr(L.doc.notify)) return { changed: false, path, backup: null, note: "notify belongs to another program; left alone" };
  const lines = [...L.lines];
  removeRange(lines, markerAt(lines, hit.start, NOTIFY_MARKER) ? hit.start - 1 : hit.start, hit.end);
  return { changed: true, path, backup: commit(path, L, lines, (d) => void delete d.notify), note: "notify removed" };
}

export function mcpBlock(argv: string[]): string[] {
  const [command, ...args] = argv;
  return [MCP_MARKER, "[mcp_servers.earshot]", `command = ${tomlString(command!)}`, `args = ${tomlArray([...args, "mcp"])}`];
}

const mcpHeader = (stmts: Stmt[]) => stmts.findIndex((s) => s.kind === "header" && pathEq(s.path, MCP_PATH));
const hasEntry = (doc: Doc) => {
  const m = doc.mcp_servers as Doc | undefined;
  return !!m && typeof m === "object" && m.earshot !== undefined;
};

/** Set one key inside our table, in place, leaving the other keys and comments alone. */
function setKey(lines: string[], eol: string, key: string, value: string): void {
  const stmts = scan(lines.join(""));
  const h = mcpHeader(stmts);
  const end = sectionEnd(lines, stmts, h);
  const body = stmts.filter((s, k) => k > h && s.start < end && s.kind === "kv");
  const own = body.find((s) => pathEq(s.path, [key]));
  const text = `${key} = ${value}`;
  if (own) replaceLines(lines, own.start, own.end, [text], eol);
  else insertLines(lines, body.length ? body[body.length - 1]!.end : stmts[h]!.end, [text], eol);
}

export function installCodexMcp(path: string, argv: string[]): Result {
  const L = load(path);
  const [command, ...args] = argv;
  const set = (d: Doc) => {
    const m = ((d.mcp_servers as Doc | undefined) ?? (d.mcp_servers = {})) as Doc;
    const e = ((m.earshot as Doc | undefined) ?? (m.earshot = {})) as Doc;
    e.command = command;
    e.args = [...args, "mcp"];
  };
  const h = mcpHeader(L.stmts);
  if (h === -1) {
    if (hasEntry(L.doc)) throw new InstallError(`${path} defines mcp_servers.earshot in a form earshot will not edit (inline table, dotted keys or a subtable only); left unchanged.`);
    const lines = [...L.lines];
    insertLines(lines, lines.length, [...(lines.length ? [""] : []), ...mcpBlock(argv)], L.eol);
    return { changed: true, path, backup: commit(path, L, lines, set), note: "MCP server installed" };
  }
  if (!markerAt(L.lines, L.stmts[h]!.start, MCP_MARKER)) {
    throw new InstallError(`${path} already has an [mcp_servers.earshot] table that earshot did not write; left unchanged. Edit or remove it first.`);
  }
  const lines = [...L.lines];
  setKey(lines, L.eol, "command", tomlString(command!));
  setKey(lines, L.eol, "args", tomlArray([...args, "mcp"]));
  if (lines.join("") === L.text) return { changed: false, path, backup: null, note: "MCP server already installed" };
  return { changed: true, path, backup: commit(path, L, lines, set), note: "MCP server updated" };
}

export function uninstallCodexMcp(path: string): Result {
  if (!existsSync(path)) return { changed: false, path, backup: null, note: "no config file" };
  const L = load(path);
  const h = mcpHeader(L.stmts);
  if (h === -1) {
    return { changed: false, path, backup: null, note: hasEntry(L.doc) ? "mcp_servers.earshot belongs to the user; left alone" : "MCP server not installed" };
  }
  if (!markerAt(L.lines, L.stmts[h]!.start, MCP_MARKER)) return { changed: false, path, backup: null, note: "mcp_servers.earshot belongs to the user; left alone" };
  // Our table and every subtable of it ([mcp_servers.earshot.env], ...), bottom first so indexes stay valid.
  const spans = L.stmts
    .map((s, k) => ({ s, k }))
    .filter(({ s }) => isHeader(s) && pathStarts(s.path, MCP_PATH))
    .map(({ s, k }) => ({ a: k === h ? s.start - 1 : s.start, b: sectionEnd(L.lines, L.stmts, k) }))
    .sort((x, y) => y.a - x.a);
  const lines = [...L.lines];
  for (const { a, b } of spans) removeRange(lines, a > 0 && lines[a - 1]!.trim() === "" ? a - 1 : a, b);
  const change = (d: Doc) => {
    const m = d.mcp_servers as Doc | undefined;
    if (m) delete m.earshot;
  };
  return { changed: true, path, backup: commit(path, L, lines, change), note: "MCP server removed" };
}

export function installCodex(o: { bin?: string; path?: string }): Result[] {
  return [installNotify(o.path ?? codexConfigPath(), notifyArgv(o.bin))];
}

export function uninstallCodex(o: { path?: string } = {}): Result[] {
  return [uninstallNotify(o.path ?? codexConfigPath())];
}
