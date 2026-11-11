import type { Meta } from "./bundle.js";

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function mmss(s: number): string {
  const t = Math.round(s);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

const AGENTS: Record<string, string> = { stdin: "Agent report", "claude-code": "Claude Code", codex: "Codex" };

/**
 * The card page. Every dynamic string is escaped here; the page has no inline script or style,
 * so the strict CSP holds. `script` is embedded as the transcript (script.md is never served).
 */
export function renderCard(meta: Meta, script: string | null): string {
  const id = meta.id;
  const e = escapeHtml;
  const base = `/b/${id}`;
  const hasAudio = meta.audio !== null;
  const heading =
    meta.status === "pending" ? "Working on it" : meta.status === "failed" ? "Could not make this memo" : meta.title;
  const byline = `${AGENTS[meta.source.from] ?? "Agent report"}, ${clock(meta.created_at)}`;
  const length = meta.audio?.duration_s != null ? mmss(meta.audio.duration_s) : "";

  const player = hasAudio
    ? `<section class="player" aria-label="Player">
      <audio id="audio" src="${base}/memo.mp3" preload="metadata"></audio>
      <button id="play" class="play" type="button" aria-label="Play"><span class="icon"></span></button>
      <div class="timeline"><input id="seek" type="range" min="0" max="1000" value="0" aria-label="Seek"><span id="time" class="time">0:00 / ${e(length)}</span></div>
      <div class="extras"><button id="back" type="button" aria-label="Back 10 seconds">Back 10</button><button id="speed" type="button" aria-label="Speed">1x</button></div>
    </section>`
    : `<section class="player"><button class="play" type="button" aria-label="Play" disabled><span class="icon"></span></button></section>`;

  const sketch = meta.image
    ? `<section class="sketch"><img src="${base}/sketch.svg" alt="${e(`Sketch: ${meta.title}`)}"></section>`
    : "";

  const evidence = meta.evidence
    ? `<p class="evidence"><a href="${e(meta.evidence)}" rel="noopener noreferrer" target="_blank">Evidence</a></p>`
    : "";

  const transcript =
    script && meta.status !== "failed"
      ? `<details class="transcript"><summary>Transcript</summary>${script
          .split(/\n{2,}/)
          .map((p) => `<p>${e(p.trim())}</p>`)
          .join("")}</details>`
      : "";

  const error =
    meta.status === "failed" ? `<p class="error">${e(meta.error ?? "Unknown error")}</p>` : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${e(heading)}</title>
<link rel="stylesheet" href="/assets/card.css">
</head>
<body data-status="${e(meta.status)}" data-id="${e(id)}" data-title="${e(meta.title)}">
<main>
<header><h1>${e(heading)}</h1><p class="byline">${e(byline)}</p></header>
${meta.status === "failed" ? error : player}
${sketch}
${evidence}
${transcript}
</main>
<script src="/assets/card.js" defer></script>
</body>
</html>
`;
}
