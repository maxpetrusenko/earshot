import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { briefDir, readFileInBundle, updateMeta, writeFileInBundle, type TrackName } from "./bundle.js";
import type { TtsConfig } from "./config.js";
import { mp3Duration, mp3Format, stripMp3Meta, synthesize, type TtsResult } from "./tts.js";

export type Synth = (cfg: TtsConfig, text: string, voice?: string) => Promise<TtsResult>;

/** Counting semaphore, so two tracks do not flood one TTS server. */
export class Semaphore {
  private waiting: (() => void)[] = [];
  private free: number;
  constructor(n: number) {
    this.free = n;
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.free > 0) this.free--;
    else await new Promise<void>((r) => this.waiting.push(r));
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.free++;
    }
  }
}

const HOLD_MAX_MS = 8000;
const nap = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 300);
const chunkName = (track: TrackName, i: number) => `${track}-${String(i).padStart(3, "0")}.mp3`;

export interface TrackOptions {
  id: string;
  track: TrackName;
  tts: TtsConfig;
  voice?: string;
  /** performance.now() origin: when the brief was created. */
  t0: number;
  gate: Semaphore;
  /** Chunks after the first wait for this (or a timeout): a TTS server that works one request at a time serves the other track first. */
  holdAfterFirst?: Promise<void>;
  /** Called once this track has its first chunk on disk, or has ended without one. */
  onSettled?: () => void;
  /** Start every chunk's TTS request at once (the gate still caps them) and write in order: for callers that wait for the whole track. */
  parallel?: boolean;
  synth?: Synth;
  log?: (line: string) => void;
}

/**
 * Writes one audio track as it is produced. add() queues text; chunks are synthesized in order, each one is
 * written to the bundle and added to the manifest in meta.json as soon as it is ready, which is when the
 * server can start streaming it. close() joins the chunks into <track>.mp3 and marks the track ready.
 */
export class TrackWriter {
  private queue: Promise<void> = Promise.resolve();
  private n = 0;
  private failed: string | null = null;
  private files: string[] = [];
  private format: string | null = null;
  private seconds = 0;
  private readonly synth: Synth;

  constructor(private readonly o: TrackOptions) {
    this.synth = o.synth ?? synthesize;
  }

  get error(): string | null {
    return this.failed;
  }

  add(text: string): void {
    if (this.failed || !text.trim()) return;
    const index = this.n++;
    const early = this.o.parallel ? this.speak(text) : null;
    early?.catch(() => undefined); // a failure is raised when the queue reaches this chunk
    this.queue = this.queue.then(() => this.chunk(index, text, early)).catch((e) => this.fail(errMsg(e)));
  }

  private async speak(text: string): Promise<TtsResult> {
    const { tts, voice, gate } = this.o;
    const synth = this.synth;
    try {
      return await gate.run(() => synth(tts, text, voice));
    } catch {
      return await gate.run(() => synth(tts, text, voice)); // one retry for a transient server error
    }
  }

  private async chunk(index: number, text: string, early: Promise<TtsResult> | null): Promise<void> {
    if (this.failed) return;
    if (index > 0 && this.o.holdAfterFirst && !early) await Promise.race([this.o.holdAfterFirst, nap(HOLD_MAX_MS)]);
    if (this.failed) return;
    const r = await (early ?? this.speak(text));
    if (this.failed) return;
    const audio = stripMp3Meta(r.audio);
    const fmt = mp3Format(audio);
    this.format ??= fmt;
    if (fmt !== this.format) throw new Error(`tts chunk ${index} is ${fmt}, the track is ${this.format}`);
    const file = chunkName(this.o.track, index);
    const dur = mp3Duration(audio);
    writeFileInBundle(this.o.id, file, audio);
    this.files.push(file);
    this.seconds += dur ?? 0;
    const first = performance.now() - this.o.t0;
    updateMeta(this.o.id, (m) => {
      const t = m.tracks?.[this.o.track];
      if (!t || t.status !== "pending") return;
      t.chunks.push({ file, duration_s: dur });
      t.first_audio_ms ??= Math.round(first);
    });
    if (index === 0) {
      this.o.log?.(`${this.o.track} first audio ${Math.round(first)}ms`);
      this.o.onSettled?.();
    }
  }

  /** Mark the track failed and remove its files: nothing from a failed track is served afterwards. */
  fail(reason: string): void {
    if (this.failed) return;
    this.failed = reason;
    this.o.onSettled?.();
    updateMeta(this.o.id, (m) => {
      const t = m.tracks?.[this.o.track];
      if (!t) return;
      t.status = "failed";
      t.error = reason;
      t.chunks = [];
    });
    for (const f of [...this.files, `${this.o.track}.mp3`]) {
      try {
        unlinkSync(join(briefDir(this.o.id), f));
      } catch {
        /* never written */
      }
    }
  }

  /** Wait for every queued chunk, write the joined file, then flip the track to ready. */
  async close(): Promise<void> {
    await this.queue;
    this.o.onSettled?.();
    if (this.failed) return;
    if (this.files.length === 0) return this.fail("no audio was produced");
    const parts = this.files.map((f) => readFileInBundle(this.o.id, f));
    if (parts.some((p) => p === null)) return this.fail("a chunk file is missing");
    const whole = Buffer.concat(parts as Buffer[]);
    writeFileInBundle(this.o.id, `${this.o.track}.mp3`, whole);
    const duration = mp3Duration(whole) ?? Math.round(this.seconds * 10) / 10;
    updateMeta(this.o.id, (m) => {
      const t = m.tracks?.[this.o.track];
      if (t && t.status === "pending") {
        t.status = "ready";
        t.duration_s = duration;
      }
    });
    this.o.log?.(`${this.o.track} ready ${duration}s in ${this.files.length} chunks`);
  }
}
