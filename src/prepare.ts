import { briefDir, createBrief, initialMeta, readInputText, readMeta, type Meta, type Stage } from "./bundle.js";
import type { Config } from "./config.js";
import { newId } from "./lib/id.js";
import { PROMPTS } from "./prompt-version.js";
import { redact } from "./redact.js";
import { truncateMiddle } from "./extract/stdin.js";
import { validEvidence } from "./earscript.js";

/** The light half of a run (no LLM, TTS or renderer imports), so a Stop hook can use it. */

export function scrub(cfg: Config, raw: string) {
  const cut = truncateMiddle(raw, cfg.privacy.max_input_chars);
  const r = cfg.privacy.redact ? redact(cut.text) : { text: cut.text, count: 0 };
  return { text: r.text, redacted: r.count, truncated: cut.truncated };
}

/** A brief that exists on disk (pending) with its scrubbed input, ready for a worker to execute. */
export interface Prepared {
  meta: Meta;
  dir: string;
  text: string;
  /** performance.now() origin for total_ms. */
  t0: number;
}

/** Scrub the input and write the pending bundle. Fast, local, no network. */
export function prepareBrief(cfg: Config, raw: string, opts: { from: string; session?: string; evidence?: string; log?: (l: string) => void }): Prepared {
  const log = opts.log ?? (() => undefined);
  const t0 = performance.now();
  const stages: Stage[] = [];
  const id = newId();
  if (!cfg.privacy.redact) log("warning: privacy.redact is false; secrets are NOT scrubbed from input or output");
  const t1 = performance.now();
  const s = scrub(cfg, raw);
  const ms = Math.round(performance.now() - t1);
  stages.push({ name: "scrub", ms, ok: true });
  log(`scrub ${ms}ms`);
  const meta = initialMeta(id, { from: opts.from, chars: raw.length, redacted: s.redacted, truncated: s.truncated, ...(opts.session ? { session: opts.session } : {}) }, PROMPTS[cfg.script.style].version);
  meta.stages = stages;
  // A caller-supplied evidence link passes the same rules as an LLM-chosen one (it must appear in the scrubbed text).
  if (opts.evidence) meta.evidence = validEvidence(opts.evidence, s.text, cfg.privacy.evidence_hosts);
  const dir = createBrief(meta, s.text);
  return { meta, dir, text: s.text, t0 };
}

/** Reload a pending brief written by prepareBrief (worker side). total_ms counts from creation. */
export function loadPrepared(id: string): Prepared | null {
  const meta = readMeta(id);
  const text = readInputText(id);
  if (!meta || text === null || meta.status !== "pending") return null;
  const age = Math.max(0, Date.now() - Date.parse(meta.created_at));
  return { meta, dir: briefDir(id), text, t0: performance.now() - age };
}
