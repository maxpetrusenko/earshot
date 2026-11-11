import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { cachedBaseUrl } from "../baseurl.js";
import { loadConfig, type Config } from "../config.js";
import { startDetached } from "../detach.js";
import { briefLinks, listenMarkdown } from "../links.js";
import { applyTag, extractLastMessage, lastTurn, readTail } from "../extract/claude-code.js";
import { earshotHome } from "../config.js";
import { enqueue, lockedRecently } from "./state.js";

/** The Stop payload fields earshot reads. Verified against code.claude.com/docs/en/hooks (2026-11-10). */
export interface StopPayload {
  session_id?: string;
  prompt_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  stop_hook_active?: boolean;
  last_assistant_message?: string;
}

export interface HookOutput {
  systemMessage?: string;
}

export interface HookDeps {
  loadConfig?: () => Config;
  baseUrl?: (cfg: Config) => Promise<string>;
  waitMs?: number;
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

export type Decision = { narrate: true; text: string; toolUses: number } | { narrate: false; reason: string };

/** The final message of the turn plus the trigger gate. Pure of side effects except transcript reads. */
export async function decide(p: StopPayload, cfg: Config, waitMs = 1000): Promise<Decision> {
  if (p.stop_hook_active) return { narrate: false, reason: "stop_hook_active" };
  let text = typeof p.last_assistant_message === "string" ? p.last_assistant_message.trim() : "";
  let toolUses = 0;
  const path = p.transcript_path;
  if (text) {
    // Tool calls happen before the final message, so the tail of the transcript has them even when it lags.
    const raw = path ? readTail(path) : null;
    toolUses = raw ? lastTurn(raw).toolUses : 0;
  } else if (path) {
    const turn = await extractLastMessage(path, { waitMs, promptId: p.prompt_id });
    if (!turn?.text) return { narrate: false, reason: "no assistant text for this turn in the transcript (not flushed in time)" };
    text = turn.text;
    toolUses = turn.toolUses;
  } else {
    return { narrate: false, reason: "payload has no last_assistant_message and no transcript_path" };
  }
  const tagged = applyTag(text, cfg.trigger.opt_in_tag);
  if (tagged === null) return { narrate: false, reason: "opt_in_tag is on and the message has no <narrate>" };
  if (tagged.length < cfg.trigger.min_chars) return { narrate: false, reason: `shorter than min_chars (${tagged.length} < ${cfg.trigger.min_chars})` };
  if (cfg.trigger.require_tool_use && toolUses === 0) return { narrate: false, reason: "no tool use in this turn" };
  return { narrate: true, text: tagged, toolUses };
}

/** Stop hook body. Returns the JSON for stdout; never throws, never blocks the agent. */
export async function handleStop(p: StopPayload, deps: HookDeps = {}): Promise<HookOutput> {
  const log = deps.log ?? hookLog;
  try {
    const cfg = (deps.loadConfig ?? (() => loadConfig()))();
    const d = await decide(p, cfg, deps.waitMs);
    if (!d.narrate) {
      log(`skip session=${p.session_id ?? "?"}: ${d.reason}`);
      return {};
    }
    const session = p.session_id ?? "";
    if (session && lockedRecently(session)) {
      log(`skip session=${session}: skill mode already narrated within 30s`);
      return {};
    }
    const job = startDetached(cfg, d.text, { from: "claude-code", session: session || undefined, configPath: process.env.EARSHOT_CONFIG });
    const id = job.prepared.meta.id;
    if (session) enqueue(session, { id, pid: job.pid, ts: Date.now() });
    const base = await (deps.baseUrl ?? ((c) => cachedBaseUrl(c.serve)))(cfg);
    const links = briefLinks(base, id);
    const url = links.card;
    log(`narrate session=${session || "?"} id=${id} pid=${job.pid} chars=${d.text.length} tools=${d.toolUses} hook_ms=${Math.round(performance.now())} ${url}`);
    return { systemMessage: listenMarkdown(links) };
  } catch (e) {
    log(`error: ${e instanceof Error ? e.message : String(e)}`);
    return {};
  }
}
