import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { cachedBaseUrl } from "../baseurl.js";
import { earshotHome, loadConfig, type Config } from "../config.js";
import { startDetached } from "../detach.js";
import { applyTag, readTail } from "../extract/claude-code.js";
import { findCodexSession, isSafeCodexId, lastCodexTurn } from "../extract/codex.js";
import { enqueue, lockedRecently } from "./state.js";

/**
 * The `notify` payload Codex passes as the last argv. Source: https://developers.openai.com/codex/config-advanced
 * (Notifications): type (currently only "agent-turn-complete"), thread-id (the session id), turn-id, cwd,
 * input-messages, last-assistant-message.
 */
export interface NotifyPayload {
  type?: string;
  "thread-id"?: string;
  "turn-id"?: string;
  cwd?: string;
  "input-messages"?: string[];
  "last-assistant-message"?: string;
}

export interface CodexHookDeps {
  loadConfig?: () => Config;
  baseUrl?: (cfg: Config) => Promise<string>;
  /** Override the rollout file lookup (tests). */
  findSession?: (id: string) => string | null;
  log?: (line: string) => void;
}

const hookLog = (line: string) => {
  try {
    const dir = join(earshotHome(), "logs");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    appendFileSync(join(dir, "hook.log"), `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
  } catch {
    /* logging must never break the hook */
  }
};

/** The notify payload is the last argv entry. Anything that is not a JSON object is no payload. */
export function parseNotifyArgv(argv: string[]): NotifyPayload | null {
  const last = argv[argv.length - 1];
  if (!last) return null;
  try {
    const v = JSON.parse(last) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as NotifyPayload) : null;
  } catch {
    return null;
  }
}

/** Largest notify message considered, in characters. */
export const MAX_MESSAGE = 1_000_000;

export type CodexDecision = { narrate: true; text: string; toolUses: number } | { narrate: false; reason: string };

/** Trigger gate. Tool use is counted from the rollout file (the payload does not carry it). */
export function decideCodex(p: NotifyPayload, cfg: Config, findSession: (id: string) => string | null = findCodexSession): CodexDecision {
  if (p.type !== "agent-turn-complete") return { narrate: false, reason: `event ${String(p.type)} is not agent-turn-complete` };
  // Cap before any parsing: keep the tail, which holds the conclusion.
  const msg = typeof p["last-assistant-message"] === "string" ? p["last-assistant-message"] : "";
  const text0 = (msg.length > MAX_MESSAGE ? msg.slice(-MAX_MESSAGE) : msg).trim();
  if (!text0) return { narrate: false, reason: "payload has no last-assistant-message" };
  const tagged = applyTag(text0, cfg.trigger.opt_in_tag);
  if (tagged === null) return { narrate: false, reason: "opt_in_tag is on and the message has no <narrate>" };
  if (tagged.length < cfg.trigger.min_chars) return { narrate: false, reason: `shorter than min_chars (${tagged.length} < ${cfg.trigger.min_chars})` };
  let toolUses = 0;
  const id = p["thread-id"];
  if (id && isSafeCodexId(id)) {
    const path = findSession(id);
    const raw = path ? readTail(path, 8 * 1024 * 1024) : null;
    if (raw) toolUses = lastCodexTurn(raw).toolUses;
  }
  if (cfg.trigger.require_tool_use && toolUses === 0) return { narrate: false, reason: "no tool use in this turn (or the session log was not found)" };
  return { narrate: true, text: tagged, toolUses };
}

export interface CodexHookOutput {
  url?: string;
  id?: string;
}

/** notify body. Returns what to print; never throws, never waits on the worker. */
export async function handleNotify(p: NotifyPayload, deps: CodexHookDeps = {}): Promise<CodexHookOutput> {
  const log = deps.log ?? hookLog;
  try {
    const cfg = (deps.loadConfig ?? (() => loadConfig()))();
    const d = decideCodex(p, cfg, deps.findSession);
    if (!d.narrate) {
      log(`skip codex session=${p["thread-id"] ?? "?"}: ${d.reason}`);
      return {};
    }
    const raw = p["thread-id"];
    const session = raw && isSafeCodexId(raw) ? raw : "";
    if (session && lockedRecently(session)) {
      log(`skip codex session=${session}: already narrated within 30s`);
      return {};
    }
    const job = startDetached(cfg, d.text, { from: "codex", session: session || undefined, configPath: process.env.EARSHOT_CONFIG });
    const id = job.prepared.meta.id;
    if (session) enqueue(session, { id, pid: job.pid, ts: Date.now() });
    const base = await (deps.baseUrl ?? ((c) => cachedBaseUrl(c.serve)))(cfg);
    const url = `${base}/b/${id}`;
    log(`narrate codex session=${session || "?"} id=${id} pid=${job.pid} chars=${d.text.length} tools=${d.toolUses} hook_ms=${Math.round(performance.now())} ${url}`);
    return { url, id };
  } catch (e) {
    log(`error: ${e instanceof Error ? e.message : String(e)}`);
    return {};
  }
}
