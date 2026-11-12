import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { earshotHome } from "./config.js";
import { renderCard } from "./card.js";

export type Status = "pending" | "ready" | "degraded" | "failed";

export interface Stage {
  name: string;
  ms: number;
  ok: boolean;
  model?: string;
  error?: string;
}

export type TrackName = "edited" | "original";
export const TRACKS: TrackName[] = ["edited", "original"];

export interface TrackChunk {
  file: string;
  duration_s: number | null;
}

/** One audio track. The server streams its chunk files in order while status is pending. */
export interface TrackMeta {
  status: "pending" | "ready" | "failed";
  chunks: TrackChunk[];
  /** Milliseconds from brief creation to the first chunk on disk (the first byte a stream client gets). */
  first_audio_ms: number | null;
  duration_s: number | null;
  error?: string;
}

export interface Meta {
  id: string;
  created_at: string;
  source: { from: string; chars: number; redacted: number; truncated: boolean; session?: string };
  title: string;
  status: Status;
  error: string | null;
  audio: { duration_s: number | null; voice: string; provider: string } | null;
  image: { renderer: string; mermaid: string } | null;
  /** Progressive audio manifest. Null when audio is off. */
  tracks: Record<TrackName, TrackMeta> | null;
  /** Milliseconds from brief creation: llm_first_token, first_sentence. */
  timing?: Record<string, number>;
  evidence: string | null;
  warnings?: string[];
  prompt: string;
  stages: Stage[];
  total_ms: number | null;
  /** Pid of the detached worker, recorded at spawn so a dead worker can be detected. */
  worker_pid?: number;
}

/**
 * A brief written before progressive tracks existed has no `tracks` and one `memo.mp3`. For display and serving it is
 * the edited track, already ready; there is no original. The file on disk is not changed.
 */
export function withLegacyTracks(meta: Meta): Meta {
  if (meta.tracks !== undefined) return meta;
  if (!meta.audio) return { ...meta, tracks: null };
  const gone: TrackMeta = { status: "failed", chunks: [], first_audio_ms: null, duration_s: null, error: "not available for this memo" };
  return { ...meta, tracks: { edited: { status: "ready", chunks: [], first_audio_ms: null, duration_s: meta.audio.duration_s }, original: gone } };
}

export const briefsRoot = () => join(earshotHome(), "briefs");
export const briefDir = (id: string) => join(briefsRoot(), id);

function atomicWrite(path: string, data: string | Buffer, mode = 0o600): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { mode });
  renameSync(tmp, path);
}

export const newTrack = (): TrackMeta => ({ status: "pending", chunks: [], first_audio_ms: null, duration_s: null });

export function initialMeta(id: string, source: Meta["source"], prompt: string): Meta {
  return {
    id,
    created_at: new Date().toISOString(),
    source,
    title: "Working on it",
    status: "pending",
    error: null,
    audio: null,
    image: null,
    tracks: { edited: newTrack(), original: newTrack() },
    evidence: null,
    prompt,
    stages: [],
    total_ms: null,
  };
}

/** Create the bundle directory with input.txt, a pending meta.json and a pending card. */
export function createBrief(meta: Meta, input: string): string {
  const dir = briefDir(meta.id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  atomicWrite(join(dir, "input.txt"), input);
  writeBrief(meta, null);
  return dir;
}

/** Rewrite meta.json and card.html; script.md too when a script exists. */
export function writeBrief(meta: Meta, script: string | null): void {
  const dir = briefDir(meta.id);
  if (script !== null) atomicWrite(join(dir, "script.md"), `${meta.title}\n\n${script}\n`);
  atomicWrite(join(dir, "card.html"), renderCard(meta, script));
  atomicWrite(join(dir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
}

const BUNDLE_FILE = /^(?:(?:edited|original)(?:-\d{3})?\.mp3|sketch\.svg|explain\.html)$/;

export function writeFileInBundle(id: string, name: string, data: Buffer | string): void {
  if (!BUNDLE_FILE.test(name)) throw new Error(`not a bundle file: ${name}`);
  atomicWrite(join(briefDir(id), name), data);
}

export function readFileInBundle(id: string, name: string): Buffer | null {
  if (!BUNDLE_FILE.test(name)) return null;
  try {
    return readFileSync(join(briefDir(id), name));
  } catch {
    return null;
  }
}

/** Read-modify-write meta.json under the brief lock (card.html is not touched). Returns the new meta. */
export function updateMeta(id: string, fn: (m: Meta) => void): Meta | null {
  return withBriefLock(id, () => {
    const meta = readMeta(id);
    if (!meta) return null;
    fn(meta);
    atomicWrite(join(briefDir(id), "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
    return meta;
  });
}

export const briefExists = (id: string) => existsSync(briefDir(id));

export function readMeta(id: string): Meta | null {
  try {
    return JSON.parse(readFileSync(join(briefDir(id), "meta.json"), "utf8")) as Meta;
  } catch {
    return null;
  }
}

export function readInputText(id: string): string | null {
  try {
    return readFileSync(join(briefDir(id), "input.txt"), "utf8");
  } catch {
    return null;
  }
}

const LOCK_STALE_MS = 5000;
const LOCK_WAIT_MS = 3000;

/**
 * Cross-process mutex for one brief's meta.json (mkdir is atomic). Held only around a
 * read-check-write, so the wait is a few milliseconds. A lock older than 5 s is taken over.
 */
export function withBriefLock<T>(id: string, fn: () => T): T {
  const lock = join(briefDir(id), ".lock");
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmdirSync(lock);
      } catch {
        /* released or taken over by someone else */
      }
      if (Date.now() > deadline) throw new Error(`brief ${id} is locked`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  try {
    return fn();
  } finally {
    try {
      rmdirSync(lock);
    } catch {
      /* already gone */
    }
  }
}

/** Mark a pending brief failed with a fixed reason. Returns false when it was not pending. */
export function failPending(id: string, reason: string): boolean {
  return withBriefLock(id, () => {
    const meta = readMeta(id);
    if (!meta || meta.status !== "pending") return false;
    meta.status = "failed";
    meta.error = reason;
    for (const t of Object.values(meta.tracks ?? {})) {
      if (t.status === "pending") {
        t.status = "failed";
        t.error = reason;
      }
    }
    writeBrief(meta, null);
    return true;
  });
}

export const SUPERSEDED = "superseded";
export const WORKER_DIED = "worker died";

/** Record the worker's pid in meta.json while the brief is still pending. */
export function recordWorker(id: string, pid: number): void {
  withBriefLock(id, () => {
    const meta = readMeta(id);
    if (!meta || meta.status !== "pending") return;
    meta.worker_pid = pid;
    writeBrief(meta, null);
  });
}
