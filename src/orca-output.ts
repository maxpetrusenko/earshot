import { join } from "node:path";
import { briefLinks, listenMarkdown } from "./links.js";
import { readFileInBundle, readMeta } from "./bundle.js";
import { explainPng } from "./explain-png.js";
import { stackPages } from "./explain-stack.js";
import { fitOrcaPage, orcaDir, orcaLine, pageTitle, renderPendingHtml, writeOrcaPage, type Fitted, type OrcaKind } from "./orca.js";

/** Explainer v2 makes up to three pages per reply; each has its own file. */
const EXPLAIN_KINDS: readonly OrcaKind[] = ["explain", "explain2", "explain3"];

/** Replies shorter than this are not sent to the explain stage: it answers "no image" for them anyway. */
export const EXPLAIN_MIN_CHARS = 500;

export interface OrcaJob {
  dir: string;
  /** The worker should also render each explain page as a PNG next to the scratch dir. */
  png: boolean;
  /** `--visual`: the Explain line is already in the chat with a placeholder page; the worker writes the real page over it. */
  visual?: boolean;
  /** Pages already written. */
  written: Written;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The chat lines for a brief whose player is still being made: the player, then the links last. Without `visual`
 * there is never an Explain line: whether the model draws an image is only known seconds later, and a line that can
 * end up an empty card is worse than no line; the image goes on the card page (the link page) instead. With `visual`
 * the caller asked for a picture, so the Explain line comes right after the player and the worker guarantees a page
 * behind it: the model's image, or a deterministic "what changed" card. It is always one line: the model decides how
 * many visuals (one to three) only after the line is printed, so a line per visual would leave empty cards whenever it
 * draws fewer. Instead that one page stacks every visual the model made.
 */
export function orcaLines(id: string, base: string, visual = false): string {
  return [orcaLine(`earshot-${id}-player.html`), ...(visual ? [orcaLine(`earshot-${id}-explain.html`, "Explain")] : []), listenMarkdown(briefLinks(base, id))].join("\n");
}

/**
 * How long Orca keeps asking for a visual file that does not exist yet: it reads at once, then 1.5, 4 and 10 s after
 * each miss (15.5 s in all), then shows "Visualization unavailable" for good. A page written after that is only seen
 * when the chat is reopened. So the worker writes nothing until a page is real, and at this deadline writes a final
 * page (a note for the player, the deterministic card for Explain) so something always shows inside the window.
 */
export const ORCA_READ_WINDOW_MS = Number(process.env.EARSHOT_ORCA_READ_WINDOW_MS) || 12_000;

/** Which pages the worker has written, so the deadline never writes a stand-in over a real page. */
export interface Written {
  player: boolean;
  explain: boolean;
}

/** Arm the deadline. Returns the disarm function; call it when the worker ends. */
export function armOrcaDeadline(job: OrcaJob, id: string, fallbackExplain: () => string, log: (l: string) => void, ms = ORCA_READ_WINDOW_MS): () => void {
  const t = setTimeout(() => {
    try {
      if (!job.written.player) {
        writeOrcaPage(job.dir, id, renderPendingHtml("player", { reload: false, note: "Audio is still being made. Use the Listen link." }), "player");
        log(`orca: player not ready at ${ms} ms; wrote a note page`);
      }
      if (job.visual && !job.written.explain) {
        writeOrcaPage(job.dir, id, fallbackExplain(), "explain");
        log(`orca: explain not ready at ${ms} ms; wrote the fallback card`);
      }
    } catch (e) {
      log(`orca deadline write failed: ${msg(e)}`);
    }
  }, ms);
  t.unref();
  return () => clearTimeout(t);
}

/** Encode the finished tracks into one inline page. Throws with the reason when there is nothing to play. */
export async function buildPlayer(id: string, log: (l: string) => void): Promise<Fitted> {
  const meta = readMeta(id);
  const edited = meta?.tracks?.edited.status === "ready" ? readFileInBundle(id, "edited.mp3") : null;
  if (!edited) throw new Error("the edited track is not ready");
  const original = meta?.tracks?.original.status === "ready" ? readFileInBundle(id, "original.mp3") : null;
  const t = performance.now();
  const fit = await fitOrcaPage(edited, original, { editedSeconds: meta?.tracks?.edited.duration_s ?? undefined, originalSeconds: meta?.tracks?.original.duration_s ?? undefined });
  log(`orca encode ${Math.round(performance.now() - t)}ms`);
  return fit;
}

/** Replace the player placeholder: the real page, or a final note (no reload) when the audio failed. */
export async function finishPlayer(dir: string, id: string, log: (l: string) => void, written?: Written): Promise<void> {
  try {
    const fit = await buildPlayer(id, log);
    const file = writeOrcaPage(dir, id, fit.html, "player");
    if (written) written.player = true;
    log(`orca page ${file}: ${fit.bytes} bytes at ${fit.kbps}k${fit.droppedOriginal ? ", original dropped" : ""}`);
  } catch (e) {
    log(`orca: ${msg(e)}; the player page says so`);
    try {
      writeOrcaPage(dir, id, renderPendingHtml("player", { reload: false, note: "Audio could not be made. Use the Listen link." }), "player");
      if (written) written.player = true;
    } catch {
      /* the scratch dir is gone: nothing left to tell */
    }
  }
}

/** Optional PNGs of the finished explain pages (`--explain-png`), written next to the player in the scratch dir. */
export async function finishExplain(job: OrcaJob, id: string, htmls: string[], log: (l: string) => void): Promise<void> {
  if (job.visual && htmls.length > 0) {
    // One line is in the chat and the number of visuals was unknown when it was printed, so that one page shows them all, stacked.
    try {
      const page = writeOrcaPage(job.dir, id, stackPages(htmls.slice(0, EXPLAIN_KINDS.length)), "explain");
      job.written.explain = true;
      log(`orca page ${page} (${Math.min(htmls.length, EXPLAIN_KINDS.length)} visual${htmls.length > 1 ? "s" : ""})`);
    } catch (e) {
      log(`orca explain page failed: ${msg(e)}`);
    }
  }
  if (!job.png) return;
  for (const [i, html] of htmls.entries()) {
    const kind = EXPLAIN_KINDS[i];
    if (!kind) break;
    try {
      log(`explain png ${await explainPng(html, join(job.dir, `earshot-${id}-${kind}.png`))}`);
    } catch (e) {
      log(`explain png failed: ${msg(e)}`);
    }
  }
}

/**
 * `--format orca`: the blocking form. The caller already has the finished audio, so this writes the real pages and
 * returns the lines. Links only when a page cannot be made.
 */
export async function orcaOutput(orcaFlag: string | undefined, id: string, base: string, runStart: number, png: boolean, log: (l: string) => void): Promise<string> {
  const links = briefLinks(base, id);
  const fallback = (why: string) => {
    log(`orca: ${why}; printing the markdown Listen line`);
    return listenMarkdown(links);
  };
  const dir = orcaDir(orcaFlag);
  if (!dir) return fallback("ORCA_CHAT_SCRATCH_DIR is unset or not a writable directory");
  try {
    const fit = await buildPlayer(id, log);
    const file = writeOrcaPage(dir, id, fit.html, "player");
    // Each explain page is its own display-only visual with its own headline; only a change worth a picture has any.
    const explains = EXPLAIN_KINDS.flatMap((k) => {
      const html = readFileInBundle(id, k === "explain" ? "explain.html" : `${k}.html`)?.toString("utf8");
      return html ? [{ file: writeOrcaPage(dir, id, html, k), html }] : [];
    });
    log(`orca page ${file}: ${fit.bytes} bytes at ${fit.kbps}k${fit.droppedOriginal ? ", original dropped" : ""}; explain ${explains.map((x) => x.file).join(", ") || "none"}; ${Math.round(performance.now() - runStart)}ms from start to line`);
    if (png) {
      for (const x of explains) {
        try {
          log(`explain png ${await explainPng(x.html, join(dir, x.file.replace(/\.html$/, ".png")))}`);
        } catch (e) {
          log(`explain png failed: ${msg(e)}`);
        }
      }
    }
    return [orcaLine(file), ...explains.map((x) => orcaLine(x.file, pageTitle(x.html) ?? "Explain")), listenMarkdown(links)].join("\n");
  } catch (e) {
    return fallback(msg(e));
  }
}
