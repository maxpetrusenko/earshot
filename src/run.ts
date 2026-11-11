import { checkTitle, generateEarScript, type EarScript } from "./earscript.js";
import { streamEarScript, type StreamedEar } from "./ear-stream.js";
import { readMeta, SUPERSEDED, updateMeta, withBriefLock, writeBrief, writeFileInBundle, type Meta, type Stage } from "./bundle.js";
import { chunkText, speakableOriginal } from "./speech.js";
import { Semaphore, TrackWriter } from "./track.js";
import type { Config } from "./config.js";
import { beginRun, endRun } from "./lib/llm-tracing.js";
import { buildSketch } from "./sketch.js";
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

/** At most two TTS requests in flight per process, shared by both tracks. */
const ttsGate = new Semaphore(2);

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
  return generateEarScript(llm, text, cfg.privacy.evidence_hosts, cfg.script.style);
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
      if (onDisk) meta.tracks = onDisk.tracks; // the track writers own this part of meta.json
      for (const t of Object.values(meta.tracks ?? {})) {
        if (t.status === "pending") {
          t.status = "failed";
          t.error = error ?? "stopped";
        }
      }
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
    const clean = (t: string) => (cfg.privacy.redact ? redact(t).text : t);
    const failures: string[] = [];
    const audioOn = !opts.noAudio;
    const gate = ttsGate;
    const voice = opts.voice;
    // The edited track is what the listener waits on, so the original pauses after its first chunk until the edited one has its own.
    let editedSettled!: () => void;
    const editedFirst = new Promise<void>((r) => (editedSettled = r));
    const base = { id, tts: cfg.tts, voice, t0, gate, log };
    const originalW = audioOn ? new TrackWriter({ ...base, track: "original", holdAfterFirst: editedFirst }) : null;
    const editedW = audioOn ? new TrackWriter({ ...base, track: "edited", onSettled: editedSettled }) : null;
    if (!audioOn) editedSettled();
    if (!audioOn) {
      meta.tracks = null;
      updateMeta(id, (m) => void (m.tracks = null));
    }

    // Original track: no LLM. It starts speaking while the edited track is still waiting for its first token.
    const originalDone = stage(stages, "tts-original", log, async () => {
      if (!originalW) return;
      const chunks = chunkText(speakableOriginal(text));
      if (chunks.length === 0) originalW.fail("nothing in the report can be read aloud");
      for (const c of chunks) originalW.add(c);
      await originalW.close();
      if (originalW.error) throw new Error(originalW.error);
    }).catch((e) => void failures.push(`original: ${errMsg(e)}`));

    // The sketch starts when the model finishes the diagram and never holds up audio.
    let sketchJob: Promise<void> = Promise.resolve();
    const startSketch = (mermaid: string) => {
      if (opts.noSketch || cfg.image.type === "none") return;
      sketchJob = stage(stages, "sketch", log, () => buildSketch(llm, clean(mermaid))).then(
        (r) => {
          writeFileInBundle(id, "sketch.svg", r.svg);
          meta.image = { renderer: cfg.image.renderer, mermaid: r.mermaid };
          updateMeta(id, (m) => void (m.image = meta.image));
        },
        (e) => void failures.push(`sketch: ${errMsg(e)}`),
      );
    };

    let ear: StreamedEar | null = null;
    try {
      ear = await stage(
        stages,
        "ear-script",
        log,
        () =>
          streamEarScript(
            llm,
            text,
            {
              onChunk: (c) => editedW?.add(c),
              onTitle: (t) => {
                if (opts.title?.trim() || checkTitle(t)) return;
                updateMeta(id, (m) => void (m.title = clean(t)));
              },
              onMermaid: startSketch,
            },
            { evidenceHosts: cfg.privacy.evidence_hosts, style: cfg.script.style, redact: cfg.privacy.redact, log },
          ),
        { model: llm.model },
      );
      await stage(stages, "tts-edited", log, async () => {
        await editedW?.close();
        if (editedW?.error) throw new Error(editedW.error);
      });
    } catch (e) {
      editedW?.fail(errMsg(e));
      failures.push(`edited: ${errMsg(e)}`);
    }
    await Promise.all([originalDone, sketchJob]);

    const disk = readMeta(id);
    const originalReady = !audioOn ? false : disk?.tracks?.original.status === "ready";
    // A script without audio is still a transcript and a sketch, so it counts as usable.
    if (ear === null && !originalReady) {
      const why = failures.find((f) => f.startsWith("edited:"))?.slice(8) ?? failures[0] ?? "nothing usable";
      finish("failed", why, null);
      throw new NothingUsableError(why);
    }

    if (ear) {
      const title = clean(opts.title?.trim() || ear.title || "");
      const titleLeak = title ? checkTitle(title) : null;
      if (titleLeak) log(`warning: ${titleLeak}; using a generic title`);
      meta.title = !title || titleLeak ? FALLBACK_TITLE : title;
      meta.evidence = ear.evidence ?? meta.evidence;
      meta.timing = { llm_first_token: ear.timing.first_token_ms ?? 0, first_sentence: ear.timing.first_sentence_ms ?? 0 };
      if (ear.warnings.length) meta.warnings = ear.warnings.map(clean);
    } else meta.title = clean(opts.title?.trim() || FALLBACK_TITLE);
    const edited = disk?.tracks?.edited;
    if (edited?.status === "ready") meta.audio = { duration_s: edited.duration_s, voice: voice ?? cfg.tts.voice, provider: "openai-compatible" };

    return finish(failures.length ? "degraded" : "ready", failures.length ? failures.join("; ") : null, ear?.script ?? null);
  }
}
