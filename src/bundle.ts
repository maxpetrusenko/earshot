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

export interface Meta {
  id: string;
  created_at: string;
  source: { from: string; chars: number; redacted: number; truncated: boolean; session?: string };
  title: string;
  status: Status;
  error: string | null;
  audio: { duration_s: number | null; voice: string; provider: string } | null;
  image: { renderer: string; mermaid: string } | null;
  evidence: string | null;
  warnings?: string[];
  prompt: string;
  stages: Stage[];
  total_ms: number | null;
  /** Pid of the detached worker, recorded at spawn so a dead worker can be detected. */
  worker_pid?: number;
}

export const briefsRoot = () => join(earshotHome(), "briefs");
export const briefDir = (id: string) => join(briefsRoot(), id);

function atomicWrite(path: string, data: string | Buffer, mode = 0o600): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { mode });
  renameSync(tmp, path);
}

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

export function writeFileInBundle(id: string, name: "memo.mp3" | "sketch.svg", data: Buffer | string): void {
  atomicWrite(join(briefDir(id), name), data);
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
