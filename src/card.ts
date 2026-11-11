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

const AGENTS: Record<string, string> = { stdin: "Agent report", "claude-code": "Claude Code", codex: "Codex" };

/**
 * The card page. Every dynamic string is escaped here; the page has no inline script or style,
 * so the strict CSP holds. `script` is embedded as the transcript (script.md is never served).
 */
export function renderCard(meta: Meta, script: string | null): string {
  const id = meta.id;
  const e = escapeHtml;
  const base = `/b/${id}`;
  const heading =
    meta.status === "pending" ? "Working on it" : meta.status === "failed" ? "Could not make this memo" : meta.title;
  const byline = `${AGENTS[meta.source.from] ?? "Agent report"}, ${clock(meta.created_at)}`;
  const tracks = meta.tracks;
  const off = (t: "edited" | "original") => (tracks?.[t]?.status === "failed" ? " disabled" : "");

  const player = tracks
    ? `<section class="player" aria-label="Player">
      <div class="choices">
        <button id="play-edited" class="choice primary" type="button" data-track="edited"${off("edited")}>Play edited</button>
        <button id="play-original" class="choice" type="button" data-track="original"${off("original")}>Play original</button>
      </div>
      <div class="timeline"><input id="seek" type="range" min="0" max="1000" value="0" aria-label="Seek"><span id="time" class="time">0:00</span></div>
      <div class="extras"><button id="back" type="button" aria-label="Back 10 seconds">Back 10</button><button id="speed" type="button" aria-label="Speed">1x</button></div>
      <audio id="audio" preload="none"></audio>
    </section>`
    : "";

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
