import { isDeepStrictEqual } from "node:util";
import { parse } from "smol-toml";
import { InstallError } from "./shared.js";

/**
 * TOML edits for ~/.codex/config.toml that touch only earshot's own lines. smol-toml answers what the
 * file means; the lexer here only finds which lines a statement occupies, so comments and formatting
 * survive. Every edit is checked: the output must parse to the input plus exactly earshot's keys.
 */

export type Doc = Record<string, unknown>;

export interface Stmt {
  kind: "header" | "aot" | "kv";
  path: string[];
  /** Line indexes, end exclusive. */
  start: number;
  end: number;
}

/** Lines keep their own terminator ("\n", "\r\n" or none on the last line). */
export function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

export const eolOf = (text: string) => (text.includes("\r\n") ? "\r\n" : "\n");
export const stripEol = (l: string) => l.replace(/\r?\n$/, "");
export const hasEol = (l: string) => l.endsWith("\n");

export function parseDoc(text: string, path: string): Doc {
  if (text.includes("\0")) throw new InstallError(`${path} does not look like a text file; nothing was changed`);
  try {
    return parse(text) as Doc;
  } catch (e) {
    throw new InstallError(`${path} is not valid TOML (${(e as Error).message.split("\n")[0]}); fix it first, nothing was changed`);
  }
}

/** Locate every statement (table header or key/value) with the lines it spans. */
export function scan(text: string): Stmt[] {
  const out: Stmt[] = [];
  const n = text.length;
  let i = 0;
  let ln = 0;
  const adv = () => {
    if (text[i] === "\n") ln++;
    i++;
  };
  const skipLine = () => {
    while (i < n && text[i] !== "\n") i++;
  };
  const skipBlank = () => {
    while (i < n) {
      const c = text[i]!;
      if (c === " " || c === "\t" || c === "\r") i++;
      else if (c === "\n") adv();
      else if (c === "#") skipLine();
      else break;
    }
  };
  const spaces = () => {
    while (i < n && (text[i] === " " || text[i] === "\t")) i++;
  };
  const readQuoted = (q: string): string => {
    let s = "";
    i++;
    while (i < n && text[i] !== q && text[i] !== "\n") {
      if (q === '"' && text[i] === "\\") {
        i++;
        const e = text[i] ?? "";
        s += e === "n" ? "\n" : e === "t" ? "\t" : e === "u" ? String.fromCharCode(parseInt(text.slice(i + 1, i + 5), 16)) : e;
        if (e === "u") i += 4;
      } else s += text[i];
      i++;
    }
    i++;
    return s;
  };
  const readKey = (): string[] => {
    const path: string[] = [];
    for (;;) {
      spaces();
      const c = text[i];
      if (c === '"' || c === "'") path.push(readQuoted(c));
      else {
        const m = /^[A-Za-z0-9_-]+/.exec(text.slice(i, i + 256));
        if (!m) throw new Error("bad key");
        path.push(m[0]);
        i += m[0].length;
      }
      spaces();
      if (text[i] === ".") i++;
      else return path;
    }
  };
  const multi = (q: string) => {
    i += 3;
    while (i < n) {
      if (q === '"' && text[i] === "\\") {
        adv();
        if (i < n) adv();
      } else if (text.startsWith(q.repeat(3), i)) {
        i += 3;
        while (text[i] === q) i++;
        return;
      } else adv();
    }
  };
  const readValue = () => {
    let depth = 0;
    spaces();
    while (i < n) {
      const c = text[i]!;
      if (c === '"' || c === "'") {
        if (text.startsWith(c.repeat(3), i)) multi(c);
        else {
          i++;
          while (i < n && text[i] !== c && text[i] !== "\n") {
            if (c === '"' && text[i] === "\\") i++;
            i++;
          }
          i++;
        }
      } else if (c === "#") skipLine();
      else if (c === "[" || c === "{") {
        depth++;
        i++;
      } else if (c === "]" || c === "}") {
        depth--;
        i++;
      } else if (c === "\n") {
        if (depth <= 0) break;
        adv();
      } else i++;
    }
  };
  for (;;) {
    skipBlank();
    if (i >= n) break;
    const start = ln;
    let stmt: Stmt;
    if (text[i] === "[") {
      const aot = text[i + 1] === "[";
      i += aot ? 2 : 1;
      stmt = { kind: aot ? "aot" : "header", path: readKey(), start, end: 0 };
      spaces();
      i += aot ? 2 : 1;
    } else {
      const path = readKey();
      spaces();
      i++; // =
      readValue();
      stmt = { kind: "kv", path, start, end: 0 };
    }
    skipLine();
    if (i < n) {
      i++;
      ln++;
      stmt.end = ln;
    } else stmt.end = ln + 1;
    out.push(stmt);
  }
  return out;
}

export const isHeader = (s: Stmt) => s.kind !== "kv";
export const pathEq = (a: string[], b: string[]) => a.length === b.length && a.every((p, k) => p === b[k]);
export const pathStarts = (a: string[], prefix: string[]) => a.length >= prefix.length && prefix.every((p, k) => p === a[k]);

/** Root key/value statements (before the first table). */
export function rootStmts(stmts: Stmt[]): Stmt[] {
  const first = stmts.findIndex(isHeader);
  return first === -1 ? stmts : stmts.slice(0, first);
}

const blankOrComment = (l: string) => l.trim() === "" || l.trim().startsWith("#");

/** A table's own lines: trailing blank and comment lines belong to whatever follows. */
export function sectionEnd(lines: string[], stmts: Stmt[], idx: number): number {
  const next = stmts.findIndex((s, k) => k > idx && isHeader(s));
  const hdr = stmts[idx]!;
  let end = next === -1 ? lines.length : stmts[next]!.start;
  while (end > hdr.end && blankOrComment(lines[end - 1]!)) end--;
  return end;
}

/** Remove lines [a, b). When the removed tail had no newline, the line before loses its newline too. */
export function removeRange(lines: string[], a: number, b: number): void {
  const tailBare = b > a && !hasEol(lines[b - 1]!);
  lines.splice(a, b - a);
  if (tailBare && a > 0) lines[a - 1] = stripEol(lines[a - 1]!);
}

/** Insert lines at p. Appending to a file with no final newline keeps it without one. */
export function insertLines(lines: string[], p: number, add: string[], eol: string): void {
  const atEnd = p === lines.length;
  const bare = atEnd && lines.length > 0 && !hasEol(lines[lines.length - 1]!);
  if (bare) lines[lines.length - 1] += eol;
  const out = add.map((l, k) => (bare && k === add.length - 1 ? l : l + eol));
  lines.splice(p, 0, ...out);
}

/** Replace lines [a, b) with new text lines; the last keeps the old last line's newline state. */
export function replaceLines(lines: string[], a: number, b: number, add: string[], eol: string): void {
  const bare = !hasEol(lines[b - 1]!);
  lines.splice(a, b - a, ...add.map((l, k) => (bare && k === add.length - 1 ? l : l + eol)));
}

function prune(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(prune);
  if (v && typeof v === "object" && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)) {
    const o: Doc = {};
    for (const [k, x] of Object.entries(v as Doc)) {
      const p = prune(x);
      if (p && typeof p === "object" && !Array.isArray(p) && Object.keys(p as Doc).length === 0 && (Object.getPrototypeOf(x) === Object.prototype || Object.getPrototypeOf(x) === null)) continue;
      o[k] = p;
    }
    return o;
  }
  return v;
}

/** The output must parse to the input with exactly earshot's change applied (empty tables ignored). */
export function verifyEdit(path: string, input: string, output: string, change: (d: Doc) => void): void {
  const expected = parseDoc(input, path);
  change(expected);
  let actual: Doc;
  try {
    actual = parse(output) as Doc;
  } catch (e) {
    throw new InstallError(`refusing to write ${path}: the edit would not be valid TOML (${(e as Error).message.split("\n")[0]}); file left unchanged`);
  }
  if (!isDeepStrictEqual(prune(expected), prune(actual))) {
    throw new InstallError(`refusing to write ${path}: the edit would change more than earshot's own keys; file left unchanged`);
  }
}

export const tomlString = (s: string) => JSON.stringify(s);
export const tomlArray = (a: string[]) => `[${a.map(tomlString).join(", ")}]`;
