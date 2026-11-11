import { checkTitle, generateEarScript, type EarScript } from "./earscript.js";
import { readMeta, SUPERSEDED, withBriefLock, writeBrief, writeFileInBundle, type Meta, type Stage } from "./bundle.js";
import type { Config } from "./config.js";
import { beginRun, endRun, traceSpan } from "./lib/llm-tracing.js";
import { buildSketch } from "./sketch.js";
import { synthesize } from "./tts.js";
import type { LlmProvider } from "./llm.js";
import { redact } from "./redact.js";
import { prepareBrief, scrub, type Prepared } from "./prepare.js";

export { loadPrepared, prepareBrief, type Prepared } from "./prepare.js";

export interface RunOptions {
  from: string;
  session?: string;
  title?: string;
  voice?: string;
  noSketch?: boolean;
  noAudio?: boolean;
  log?: (line: string) => void;
}

export interface RunResult {
  meta: Meta;
  dir: string;
}

const FALLBACK_TITLE = "Task finished";

export class NothingUsableError extends Error {}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 300);

/** Time one stage, record it, and log it to stderr. A throw becomes ok:false with the error kept. */
async function stage<T>(stages: Stage[], name: string, log: (l: string) => void, fn: () => Promise<T> | T, extra: Partial<Stage> = {}): Promise<T> {
  const t0 = performance.now();
  try {
    const r = await fn();
    const ms = Math.round(performance.now() - t0);
    stages.push({ name, ms, ok: true, ...extra });
    log(`${name} ${ms}ms`);
    return r;
  } catch (e) {
    const ms = Math.round(performance.now() - t0);
    stages.push({ name, ms, ok: false, error: errMsg(e), ...extra });
    log(`${name} FAILED ${ms}ms: ${errMsg(e)}`);
    throw e;
  }
}

/** Dry run: scrub and ear-script only. Nothing is written. */
export async function dryRun(cfg: Config, llm: LlmProvider, raw: string, log: (l: string) => void): Promise<EarScript> {
  const { text } = scrub(cfg, raw);
  void log;
  return generateEarScript(llm, text, cfg.privacy.evidence_hosts);
}


export async function runPipeline(cfg: Config, llm: LlmProvider, raw: string, opts: RunOptions): Promise<RunResult> {
  return executeBrief(cfg, llm, prepareBrief(cfg, raw, opts), opts);
}

export async function executeBrief(cfg: Config, llm: LlmProvider, prep: Prepared, opts: RunOptions): Promise<RunResult> {
  const log = opts.log ?? (() => undefined);
  const { meta, t0, text } = prep;
  const id = meta.id;
  const stages = meta.stages;
  const dir = prep.dir;
  beginRun(id, { source: opts.from, chars: meta.source.chars, redacted: meta.source.redacted });

  let finished = false;
  const finish = (status: Meta["status"], error: string | null, script: string | null): RunResult => {
    finished = true;
    // Check and write under the brief lock: a newer job may supersede this one at any moment, and
    // its verdict must not be overwritten by a late "ready".
    return withBriefLock(id, () => {
      const onDisk = readMeta(id);
      if (onDisk?.status === "failed" && onDisk.error === SUPERSEDED) return { meta: onDisk, dir };
      meta.status = status;
      meta.error = error;
      meta.total_ms = Math.round(performance.now() - t0);
      writeBrief(meta, script);
      endRun({ status, error, total_ms: meta.total_ms });
      return { meta, dir };
    });
  };

  // A brief must never stay pending: signals and crashes mark it failed before the process exits.
  const abort = (why: string, code: number) => () => {
    if (!finished) {
      try {
        finish("failed", why, null);
      } catch {
        /* nothing more to do */
      }
    }
    process.exit(code);
  };
  const onInt = abort("interrupted (SIGINT)", 130);
  const onTerm = abort("terminated (SIGTERM)", 143);
  const onCrash = (e: unknown) => abort(`crashed: ${errMsg(e)}`, 1)();
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  process.on("uncaughtException", onCrash);
  process.on("unhandledRejection", onCrash);
  try {
    return await pipelineBody();
  } finally {
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
    process.off("uncaughtException", onCrash);
    process.off("unhandledRejection", onCrash);
  }

  async function pipelineBody(): Promise<RunResult> {
    let ear: EarScript;
    try {
      ear = await stage(stages, "ear-script", log, () => generateEarScript(llm, text, cfg.privacy.evidence_hosts), { model: llm.model });
    } catch (e) {
      finish("failed", errMsg(e), null);
      throw new NothingUsableError(errMsg(e));
    }
    // Generated text and --title are scrubbed too: the LLM can echo a secret, and the card renders them.
    const clean = (t: string) => (cfg.privacy.redact ? redact(t).text : t);
    const script = clean(ear.script);
    const mermaid = clean(ear.mermaid);
    const title = clean(opts.title?.trim() || ear.title);
    const titleLeak = checkTitle(title);
    if (titleLeak) log(`warning: ${titleLeak}; using a generic title`);
    meta.title = titleLeak ? FALLBACK_TITLE : title;
    meta.evidence = ear.evidence ?? meta.evidence;
    if (ear.warnings.length) meta.warnings = ear.warnings.map(clean);

    const failures: string[] = [];
    const audioJob = opts.noAudio
      ? Promise.resolve()
      : stage(stages, "tts", log, () =>
          traceSpan("tts", { input: { chars: script.length, voice: opts.voice ?? cfg.tts.voice } }, () => synthesize(cfg.tts, script, opts.voice), (r) => ({
            duration_s: r.duration_s,
            bytes: r.audio.length,
          })),
        ).then(
          (r) => {
            writeFileInBundle(id, "memo.mp3", r.audio);
            meta.audio = { duration_s: r.duration_s, voice: opts.voice ?? cfg.tts.voice, provider: "openai-compatible" };
          },
          (e) => void failures.push(`tts: ${errMsg(e)}`),
        );
    const sketchJob =
      opts.noSketch || cfg.image.type === "none" || !mermaid
        ? Promise.resolve()
        : stage(stages, "sketch", log, () => buildSketch(llm, mermaid)).then(
            (r) => {
              writeFileInBundle(id, "sketch.svg", r.svg);
              meta.image = { renderer: cfg.image.renderer, mermaid: r.mermaid };
            },
            (e) => void failures.push(`sketch: ${errMsg(e)}`),
          );
    await Promise.all([audioJob, sketchJob]);

    return finish(failures.length ? "degraded" : "ready", failures.length ? failures.join("; ") : null, script);
  }
}

