import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readTail } from "./claude-code.js";

/**
 * Codex CLI session logs: $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<local time>-<session id>.jsonl, also
 * archived_sessions/rollout-*.jsonl. One JSON object per line: {timestamp, type, payload}. Checked against
 * Codex CLI 0.145.0 logs (session_meta.payload.id is the session id) and the older April 2026 format.
 *
 * A turn starts at event_msg/task_started. Its final answer is a response_item whose payload is
 * {type: "message", role: "assistant", phase: "final_answer", content: [{type: "output_text", text}]};
 * progress chatter has phase "commentary". event_msg/task_complete carries last_agent_message for the turn.
 */

interface Block {
  type?: string;
  text?: string;
}

interface Entry {
  type?: string;
  payload?: {
    type?: string;
    role?: string;
    phase?: string;
    content?: Block[];
    last_agent_message?: string | null;
  };
}

export interface CodexTurn {
  text: string | null;
  toolUses: number;
  sawTurn: boolean;
}

const TOOL_ITEMS = new Set(["function_call", "custom_tool_call", "local_shell_call", "web_search_call", "tool_search_call", "mcp_tool_call"]);

export function parseCodexEntries(jsonl: string): Entry[] {
  const out: Entry[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as Entry;
      if (e && typeof e === "object") out.push(e);
    } catch {
      /* torn last line while Codex is still writing */
    }
  }
  return out;
}

const textOf = (blocks: Block[] | undefined): string =>
  (Array.isArray(blocks) ? blocks : [])
    .filter((b) => b?.type === "output_text" && typeof b.text === "string")
    .map((b) => b.text!.trim())
    .filter(Boolean)
    .join("\n\n");

/** The last turn only; it never reaches back to an earlier turn when this one has no answer yet. */
export function lastCodexTurn(jsonl: string): CodexTurn {
  const entries = parseCodexEntries(jsonl);
  let start = -1;
  entries.forEach((e, i) => {
    if (e.type === "event_msg" && e.payload?.type === "task_started") start = i;
  });
  let toolUses = 0;
  let final: string | null = null;
  let loose: string[] = [];
  let completeMsg: string | null = null;
  for (const e of entries.slice(start + 1)) {
    const p = e.payload;
    if (!p) continue;
    if (e.type === "response_item") {
      if (p.type && TOOL_ITEMS.has(p.type)) {
        toolUses++;
        loose = [];
      } else if (p.type === "message" && p.role === "assistant") {
        const t = textOf(p.content);
        if (!t) continue;
        if (p.phase === "final_answer") final = t;
        else if (p.phase !== "commentary") loose.push(t);
      }
    } else if (e.type === "event_msg" && p.type === "task_complete" && typeof p.last_agent_message === "string" && p.last_agent_message.trim()) {
      completeMsg = p.last_agent_message.trim();
    }
  }
  const text = final ?? (loose.join("\n\n") || completeMsg);
  return { text: text?.trim() || null, toolUses, sawTurn: start >= 0 };
}

export const codexHome = () => process.env.CODEX_HOME ?? join(homedir(), ".codex");

/** Session ids become part of a file name match; accept only UUID-like ids. */
export function isSafeCodexId(id: string): boolean {
  return /^[A-Za-z0-9-]{8,80}$/.test(id);
}

const numericDirs = (dir: string): string[] => {
  try {
    return readdirSync(dir).filter((n) => /^\d+$/.test(n)).sort().reverse();
  } catch {
    return [];
  }
};

/** The rollout file of one named session. No newest-file guessing: the id must match the file name. */
export function findCodexSession(id: string, home = codexHome()): string | null {
  if (!isSafeCodexId(id)) return null;
  const suffix = `-${id}.jsonl`;
  const pick = (dir: string): string | null => {
    try {
      const hit = readdirSync(dir).find((n) => n.startsWith("rollout-") && n.endsWith(suffix));
      return hit ? join(dir, hit) : null;
    } catch {
      return null;
    }
  };
  for (const y of numericDirs(join(home, "sessions"))) {
    for (const m of numericDirs(join(home, "sessions", y))) {
      for (const d of numericDirs(join(home, "sessions", y, m))) {
        const hit = pick(join(home, "sessions", y, m, d));
        if (hit) return hit;
      }
    }
  }
  return pick(join(home, "archived_sessions"));
}

const nap = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Final assistant message of the last turn in a rollout file. Retries briefly while Codex flushes. */
export async function extractCodexLast(path: string, o: { waitMs?: number; intervalMs?: number } = {}): Promise<CodexTurn | null> {
  const { waitMs = 1000, intervalMs = 100 } = o;
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (existsSync(path)) {
      const raw = readTail(path, 8 * 1024 * 1024);
      if (raw !== null) {
        const turn = lastCodexTurn(raw);
        if (turn.text && turn.sawTurn) return turn;
      }
    }
    if (Date.now() >= deadline) return null;
    await nap(intervalMs);
  }
}
