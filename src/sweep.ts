import { readdirSync } from "node:fs";
import { briefsRoot, failPending, readMeta, WORKER_DIED } from "./bundle.js";
import { isWorker } from "./hook/state.js";
import { isValidId } from "./lib/id.js";

/**
 * A worker killed before it installs its signal handlers (the first second after spawn) leaves its brief
 * pending forever. The sweep marks a brief failed when it is pending, older than minAgeMs, and the pid
 * recorded at spawn is gone (or now belongs to something that is not an earshot worker).
 */
export const DEAD_AFTER_MS = 60_000;

export interface SweepOptions {
  minAgeMs?: number;
  now?: number;
  /** True when the pid is a live earshot worker. Default: ps check. */
  alive?: (pid: number) => boolean;
}

const aliveWorker = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ESRCH") return false;
  }
  return isWorker(pid);
};

/** Returns true when the brief was marked failed. */
export function sweepBrief(id: string, o: SweepOptions = {}): boolean {
  const meta = readMeta(id);
  if (!meta || meta.status !== "pending" || !meta.worker_pid) return false;
  if ((o.now ?? Date.now()) - Date.parse(meta.created_at) < (o.minAgeMs ?? DEAD_AFTER_MS)) return false;
  if ((o.alive ?? aliveWorker)(meta.worker_pid)) return false;
  return failPending(id, WORKER_DIED);
}

export function sweepDead(o: SweepOptions = {}): string[] {
  let ids: string[];
  try {
    ids = readdirSync(briefsRoot()).filter(isValidId);
  } catch {
    return [];
  }
  return ids.filter((id) => {
    try {
      return sweepBrief(id, o);
    } catch {
      return false;
    }
  });
}
