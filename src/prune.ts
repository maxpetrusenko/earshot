import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { briefDir, briefsRoot, type Meta } from "./bundle.js";
import { earshotHome, type Config } from "./config.js";
import { isValidId } from "./lib/id.js";

/** A brief younger than this, or touched by the server within it, is never deleted. */
export const PRUNE_MIN_AGE_MS = 60 * 60_000;
/** `earshot run` prunes at most this often. */
export const PRUNE_INTERVAL_MS = 60 * 60_000;
const SERVED_MARK = ".served";
const STAMP = ".prune-stamp";
const DAY_MS = 86_400_000;
const MARK_EVERY_MS = 10_000;
const lastMark = new Map<string, number>();

export type Retention = Config["retention"];

export interface PruneOptions extends Retention {
  /** Report what would go without deleting. */
  dryRun?: boolean;
  now?: number;
  /** For tests: decides whether a worker pid is alive. */
  alive?: (pid: number) => boolean;
}

export interface PruneResult {
  deleted: string[];
  freedBytes: number;
  keptCount: number;
  bytesBefore: number;
  bytesAfter: number;
  /** Briefs that were old enough or over the cap but kept because they are young, served or being made. */
  protectedCount: number;
}

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Recursive size in bytes; a file that vanishes while counting counts as zero. */
export function dirBytes(dir: string): number {
  let total = 0;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const n of names) {
    const p = join(dir, n);
    try {
      const st = statSync(p);
      total += st.isDirectory() ? dirBytes(p) : st.size;
    } catch {
      /* gone */
    }
  }
  return total;
}

const mtime = (p: string): number => {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
};

/**
 * The server calls this on every request for a brief, so a brief that is being played or opened has a fresh mark.
 * Playback is a stream or a series of Range requests, and the stream loop re-marks while it is open.
 */
export function markServed(id: string, now?: number): void {
  if (!isValidId(id)) return;
  // A card polls its meta.json every second: one touch per brief per 10 s is plenty against a one-hour window.
  if (now === undefined) {
    const t = Date.now();
    if (t - (lastMark.get(id) ?? 0) < MARK_EVERY_MS) return;
    lastMark.set(id, t);
    if (lastMark.size > 500) lastMark.clear();
    now = t;
  }
  const p = join(briefDir(id), SERVED_MARK);
  try {
    if (existsSync(p)) utimesSync(p, now / 1000, now / 1000);
    else if (existsSync(briefDir(id))) writeFileSync(p, "", { mode: 0o600 });
  } catch {
    /* a brief that was just removed: nothing to mark */
  }
}

interface Entry {
  id: string;
  bytes: number;
  /** The latest sign of life: creation, the last meta write, the last time the server touched it. */
  active: number;
  created: number;
  inUse: boolean;
}

function inspect(id: string, now: number, alive: (pid: number) => boolean): Entry {
  const dir = briefDir(id);
  let meta: Meta | null = null;
  try {
    meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as Meta;
  } catch {
    /* no meta: judged by file times only */
  }
  const created = meta?.created_at ? Date.parse(meta.created_at) || 0 : 0;
  const dirTime = mtime(dir);
  const active = Math.max(created, mtime(join(dir, "meta.json")), mtime(join(dir, SERVED_MARK)), dirTime);
  const making = meta?.status === "pending" && typeof meta.worker_pid === "number" && alive(meta.worker_pid);
  return { id, bytes: dirBytes(dir), active, created: created || dirTime, inUse: making || now - active < PRUNE_MIN_AGE_MS };
}

/** Rename first so the server never serves a half-deleted brief, then remove. */
function remove(id: string): void {
  const from = briefDir(id);
  const to = join(briefsRoot(), `.prune-${id}`);
  renameSync(from, to);
  rmSync(to, { recursive: true, force: true });
}

/**
 * Delete briefs older than `days`, then the oldest of the rest until the total is under `maxMb`. A brief that is
 * under an hour old, was served within the hour or has a live worker is never deleted, even over the cap, and
 * is checked again right before it is removed.
 */
export function pruneBriefs(o: PruneOptions): PruneResult {
  const now = o.now ?? Date.now();
  const alive = o.alive ?? pidAlive;
  const root = briefsRoot();
  const result: PruneResult = { deleted: [], freedBytes: 0, keptCount: 0, bytesBefore: 0, bytesAfter: 0, protectedCount: 0 };
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return result;
  }
  for (const n of names) if (n.startsWith(".prune-") && !o.dryRun) rmSync(join(root, n), { recursive: true, force: true }); // left by a crash
  const entries = names.filter(isValidId).map((id) => inspect(id, now, alive));
  result.bytesBefore = entries.reduce((a, e) => a + e.bytes, 0);
  let total = result.bytesBefore;
  const cap = o.max_mb * 1024 * 1024;
  const cutoff = now - o.days * DAY_MS;
  const gone = new Set<string>();
  const drop = (e: Entry): void => {
    // Re-read the signs of life: the server may have served it since the scan.
    if (inspect(e.id, now, alive).inUse) return void result.protectedCount++;
    if (!o.dryRun) {
      try {
        remove(e.id);
      } catch {
        return;
      }
    }
    gone.add(e.id);
    result.deleted.push(e.id);
    result.freedBytes += e.bytes;
    total -= e.bytes;
  };
  const oldestFirst = [...entries].sort((a, b) => a.created - b.created);
  for (const e of oldestFirst) {
    if (e.created >= cutoff) continue;
    if (e.inUse) result.protectedCount++;
    else drop(e);
  }
  for (const e of oldestFirst) {
    if (total <= cap) break;
    if (gone.has(e.id)) continue;
    if (e.inUse) {
      result.protectedCount++;
      continue;
    }
    drop(e);
  }
  result.keptCount = entries.length - gone.size;
  result.bytesAfter = total;
  return result;
}

const stampPath = () => join(earshotHome(), STAMP);

/**
 * Prune at most once an hour, checked with a stamp file. The stamp is written before the scan so two runs starting
 * together do one scan. Returns null when it was not due.
 */
export function pruneIfDue(r: Retention, now = Date.now()): PruneResult | null {
  const p = stampPath();
  if (now - mtime(p) < PRUNE_INTERVAL_MS) return null;
  try {
    writeFileSync(p, `${new Date(now).toISOString()}\n`, { mode: 0o600 });
  } catch {
    return null;
  }
  return pruneBriefs({ ...r, now });
}

/** `earshot prune` ran: the next run does not need to repeat it. */
export function stampPruned(now = Date.now()): void {
  try {
    writeFileSync(stampPath(), `${new Date(now).toISOString()}\n`, { mode: 0o600 });
  } catch {
    /* read-only home: the run-time check handles it */
  }
}

export const formatBytes = (b: number): string => (b >= 1 << 30 ? `${(b / (1 << 30)).toFixed(2)} GB` : `${(b / (1 << 20)).toFixed(1)} MB`);
