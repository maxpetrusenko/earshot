import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { narrateBlocks } from "./tagged.js";

/** Claude Code writes one JSONL entry per content block, so a turn is many lines. */
interface Block {
  type?: string;
  text?: string;
}

interface Entry {
  type?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  promptId?: string;
  message?: { role?: string; content?: string | Block[] };
}

export interface Turn {
  /** The final assistant message of the turn: the text blocks after the last tool call. */
  text: string | null;
  toolUses: number;
  /** False when no real user prompt was found in the data we looked at. */
  sawUser: boolean;
  /** promptId of the user entry that started this turn, when the transcript records it. */
  promptId: string | null;
}

export function parseEntries(jsonl: string): Entry[] {
  const out: Entry[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as Entry;
      if (e && typeof e === "object") out.push(e);
    } catch {
      /* a torn last line while Claude Code is still writing */
    }
  }
  return out;
}

const blocksOf = (e: Entry): Block[] => {
  const c = e.message?.content;
  return Array.isArray(c) ? c : [];
};

/** A prompt typed by the user: not a tool result, not injected context (isMeta), not a subagent. */
function isRealUser(e: Entry): boolean {
  if (e.type !== "user" || e.isMeta || e.isSidechain) return false;
  const c = e.message?.content;
  if (typeof c === "string") return c.trim().length > 0;
  if (!Array.isArray(c) || c.length === 0) return false;
  return c.some((b) => b.type !== "tool_result");
}

/** The last turn: everything after the last real user entry. Never reaches back past it. */
export function lastTurn(jsonl: string): Turn {
  const entries = parseEntries(jsonl).filter((e) => !e.isSidechain);
  let start = -1;
  entries.forEach((e, i) => {
    if (isRealUser(e)) start = i;
  });
  let toolUses = 0;
  let run: string[] = [];
  for (const e of entries.slice(start + 1)) {
    if (e.type !== "assistant") continue;
    for (const b of blocksOf(e)) {
      if (b.type === "tool_use") {
        toolUses++;
        run = [];
      } else if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
        run.push(b.text.trim());
      }
    }
  }
  const text = run.join("\n\n").trim();
  return {
    text: text || null,
    toolUses,
    sawUser: start >= 0,
    promptId: start >= 0 ? (entries[start]?.promptId ?? null) : null,
  };
}

/** Read the last maxBytes of a file, dropping a torn first line. A missing file is null. */
export function readTail(path: string, maxBytes = 1024 * 1024): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const text = buf.toString("utf8");
    return size > len ? text.slice(text.indexOf("\n") + 1) : text;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export interface WaitOptions {
  /** Total time to wait for the turn text to be flushed. Default 1000. */
  waitMs?: number;
  intervalMs?: number;
  /** When set, the turn must have started with this promptId (so older text is never returned). */
  promptId?: string;
  sleep?: (ms: number) => Promise<void>;
}

const nap = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Final assistant text of the current turn from the transcript. Retries while the file lags,
 * then gives up with null rather than return text from an earlier turn.
 */
export async function extractLastMessage(path: string, o: WaitOptions = {}): Promise<Turn | null> {
  const { waitMs = 1000, intervalMs = 100, promptId, sleep = nap } = o;
  const deadline = Date.now() + waitMs;
  for (;;) {
    const raw = readTail(path);
    if (raw !== null) {
      const turn = lastTurn(raw);
      const fresh = !promptId || !turn.promptId || turn.promptId === promptId;
      if (turn.text && turn.sawUser && fresh) return turn;
    }
    if (Date.now() >= deadline) return null;
    await sleep(intervalMs);
  }
}

/** Claude Code names a project directory after the cwd with every non-alphanumeric turned into "-". */
export function projectDirFor(cwd: string, home = homedir()): string {
  return join(process.env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"), "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
}

/** Session ids become file names; accept only what Claude Code generates (letters, digits, - and _). */
export function isSafeSessionId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,80}$/.test(id);
}

/** The transcript of one named session for this working directory. There is no "newest file" guess. */
export function findTranscript(cwd: string, session: string): string | null {
  if (!isSafeSessionId(session)) return null;
  const p = join(projectDirFor(cwd), `${session}.jsonl`);
  return existsSync(p) ? p : null;
}

/** `<narrate>` handling. Returns the text to narrate, or null when the tag is required and absent. */
export function applyTag(text: string, optIn: boolean): string | null {
  const blocks = narrateBlocks(text);
  if (blocks.length) return blocks[0]!.trim() || null;
  const stripped = text.replace(/<\/?narrate>/gi, "").trim();
  if (stripped !== text.trim()) return stripped;
  return optIn ? null : text;
}
