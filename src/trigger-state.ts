import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { earshotHome } from "./config.js";
import { sessionKey } from "./hook/state.js";
import type { TriggerState } from "./trigger.js";

/** Per-session image history for the rate limiter, in ~/.earshot/state/<session>.json. Any failure reads as "no history". */
const file = (session: string): string => join(earshotHome(), "state", `${sessionKey(session)}.json`);

export function readTriggerState(session: string | undefined): TriggerState {
  if (!session) return {};
  try {
    const v = JSON.parse(readFileSync(file(session), "utf8")) as TriggerState;
    return { lastAutoAt: typeof v.lastAutoAt === "number" ? v.lastAutoAt : undefined, lastHadImage: v.lastHadImage === true };
  } catch {
    return {};
  }
}

/** Record this reply: whether it had an image and, if automatic, when. */
export function recordTriggerState(session: string | undefined, o: { image: boolean; auto: boolean; now?: number }): void {
  if (!session) return;
  try {
    const prev = readTriggerState(session);
    const next: TriggerState = { lastAutoAt: o.auto ? (o.now ?? Date.now()) : prev.lastAutoAt, lastHadImage: o.image };
    mkdirSync(join(earshotHome(), "state"), { recursive: true, mode: 0o700 });
    const p = file(session);
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
    renameSync(tmp, p);
  } catch {
    /* the limiter then has no history; the memo is unaffected */
  }
}
