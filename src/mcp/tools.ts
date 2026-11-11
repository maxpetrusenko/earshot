import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cachedBaseUrl } from "../baseurl.js";
import { briefDir, readMeta, type Status } from "../bundle.js";
import { loadConfig, type Config } from "../config.js";
import { startDetached } from "../detach.js";
import { applyTag } from "../extract/claude-code.js";
import { isValidId } from "../lib/id.js";
import { redact } from "../redact.js";
import { sweepDead } from "../sweep.js";

/** Tool logic for the MCP server, free of the SDK so it can be tested directly. */

export const WAIT_TIMEOUT_MS = 120_000;
const POLL_MS = 400;
const TITLE_MAX = 120;
/** At most this many narrate calls per window per server process; a looping agent cannot flood the TTS queue. */
export const RATE_LIMIT = { calls: 6, windowMs: 10 * 60_000 };

export interface NarrateArgs {
  text: string;
  title?: string;
  evidence?: string;
  wait?: boolean;
}

export interface BriefView {
  url: string;
  id: string;
  status: Status;
  script?: string;
  audio_url?: string;
  image_url?: string;
  title?: string;
  error?: string;
}

export class ToolError extends Error {}

export interface ToolDeps {
  cfg?: () => Config;
  baseUrl?: (cfg: Config) => Promise<string>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  waitTimeoutMs?: number;
}

const nap = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const isTerminal = (s: Status) => s !== "pending";

/** Rolling window of call times. Pure bookkeeping; the clock is injected. */
export class RateLimiter {
  private times: number[] = [];
  constructor(
    private readonly calls = RATE_LIMIT.calls,
    private readonly windowMs = RATE_LIMIT.windowMs,
  ) {}
  take(now: number): boolean {
    this.times = this.times.filter((t) => now - t < this.windowMs);
    if (this.times.length >= this.calls) return false;
    this.times.push(now);
    return true;
  }
}

/** script.md is "<title>\n\n<script>\n"; the tool returns just the script. */
function readScript(id: string): string | undefined {
  try {
    const raw = readFileSync(join(briefDir(id), "script.md"), "utf8");
    const i = raw.indexOf("\n\n");
    return (i === -1 ? raw : raw.slice(i + 2)).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The tool result for one brief, from what is on disk. No local paths. */
export function viewBrief(id: string, base: string): BriefView | null {
  const meta = readMeta(id);
  if (!meta) return null;
  const url = `${base}/b/${id}`;
  const v: BriefView = { url, id, status: meta.status, title: meta.title };
  if (meta.status === "failed" && meta.error) v.error = meta.error;
  if (meta.status === "ready" || meta.status === "degraded") {
    const script = readScript(id);
    if (script) v.script = script;
    if (existsSync(join(briefDir(id), "memo.mp3"))) v.audio_url = `${url}/memo.mp3`;
    if (existsSync(join(briefDir(id), "sketch.svg"))) v.image_url = `${url}/sketch.svg`;
    if (meta.status === "degraded" && meta.error) v.error = meta.error;
  }
  return v;
}

/**
 * Create a brief and start its detached worker. The text is untrusted: it goes through the same scrub and
 * size limits as the CLI before any LLM sees it, the title is scrubbed before it reaches a process argument,
 * and the evidence link must pass the usual allowlist.
 */
export async function narrate(args: NarrateArgs, limiter: RateLimiter, deps: ToolDeps = {}): Promise<BriefView> {
  const cfg = (deps.cfg ?? (() => loadConfig()))();
  // Rate limit first: a rejected call must cost nothing, and a flood must not reach any parsing.
  if (!limiter.take((deps.now ?? Date.now)())) throw new ToolError(`rate limit: at most ${RATE_LIMIT.calls} narrations per ${RATE_LIMIT.windowMs / 60000} minutes`);
  const text = typeof args.text === "string" ? args.text : "";
  if (text.length > cfg.privacy.max_input_chars * 4) throw new ToolError(`text is over ${cfg.privacy.max_input_chars * 4} characters; send the final report, not a log`);
  // An explicit tool call is its own trigger: min_chars, tool use and opt_in_tag gate the automatic hooks, not this call.
  const body = (applyTag(text, false) ?? "").trim();
  if (!body) throw new ToolError("text is empty");
  const base = await (deps.baseUrl ?? ((c) => cachedBaseUrl(c.serve)))(cfg);
  const title = args.title ? (cfg.privacy.redact ? redact(args.title).text : args.title).replace(/[\r\n]+/g, " ").trim().slice(0, TITLE_MAX) : undefined;
  const job = startDetached(cfg, body, { from: "mcp", title: title || undefined, evidence: args.evidence, configPath: process.env.EARSHOT_CONFIG });
  const id = job.prepared.meta.id;
  if (!args.wait) return viewBrief(id, base) ?? { url: `${base}/b/${id}`, id, status: "pending" };
  return waitFor(id, base, deps);
}

/** Poll meta.json until the brief leaves pending or the timeout passes (then the pending view, not an error). */
export async function waitFor(id: string, base: string, deps: ToolDeps = {}): Promise<BriefView> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? nap;
  const deadline = now() + (deps.waitTimeoutMs ?? WAIT_TIMEOUT_MS);
  for (;;) {
    const v = viewBrief(id, base);
    if (v && isTerminal(v.status)) return v;
    if (now() >= deadline) return v ?? { url: `${base}/b/${id}`, id, status: "pending" };
    await sleep(POLL_MS);
  }
}

export async function briefStatus(id: string, deps: ToolDeps = {}): Promise<BriefView> {
  if (!isValidId(id)) throw new ToolError("id must be the 16-character id from a Listen link");
  const cfg = (deps.cfg ?? (() => loadConfig()))();
  const base = await (deps.baseUrl ?? ((c) => cachedBaseUrl(c.serve)))(cfg);
  sweepDead();
  const v = viewBrief(id, base);
  if (!v) throw new ToolError(`no brief ${id} on this host`);
  return v;
}
