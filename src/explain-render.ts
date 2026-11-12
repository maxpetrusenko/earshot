import { EXPLAIN_CSS } from "./explain-css.js";
import { architectureSvg, sequenceSvg, timelineMax, timelineSvg } from "./explain-svg.js";
import type { ExplainSpec, JourneyPanel, Metric, Panel, TimelinePanel, UiEl, UiPanel } from "./explain-schema.js";
import { escapeHtml as e } from "./orca.js";

/**
 * Deterministic templates: one per spec type. The model returns data only; every value is escaped here and
 * the SVG parts also pass the allowlist sanitizer. The page is display-only: no script, no audio, and no
 * iOS collapse (only the player hides there).
 */

const ARROW_R = `<svg width="22" height="14" viewBox="0 0 22 14" aria-hidden="true"><path d="M1 7h18M13 1l7 6-7 6" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const NOTE_ARROW = `<svg width="16" height="16" viewBox="0 0 18 18" aria-hidden="true"><path d="M9 17V3M3 8l6-6 6 6" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

/** A deterministic waveform: no randomness, so the same spec always draws the same bars. */
const WAVE = [30, 55, 80, 45, 90, 60, 35, 70, 95, 50, 40, 75, 85, 45, 60, 30, 65, 90, 55, 35, 70, 50, 80, 40];

/** The raw mockup of one element kind, without highlight or note. */
function mock(kind: UiEl["kind"], text: string, value: number, side: "left" | "right", st: string): string {
  switch (kind) {
    case "bar": {
      const track = `<div class="trk"><b style="width:${value >= 0 ? Math.round(value) : 35}%"></b></div>`;
      return `<div class="el bar ${st}"><span>${e(text)}</span>${track}</div>`;
    }
    case "controls":
      return `<div class="el ctl ${st}">${text.split("|").map((t) => t.trim()).filter(Boolean).slice(0, 6).map((t) => `<span>${e(t)}</span>`).join("")}</div>`;
    case "button":
      return `<div class="el btn ${st}">${e(text)}</div>`;
    case "link":
      return `<div class="el lnk ${st}">${e(text)}</div>`;
    case "bubble":
      return `<div class="el bub ${side === "right" ? "r" : ""} ${st}">${e(text)}</div>`;
    case "wave": {
      const played = value >= 0 ? value : 35;
      const bars = WAVE.map((h, i) => `<i class="${(i / WAVE.length) * 100 < played ? "on" : ""}" style="height:${h}%"></i>`).join("");
      return `<div class="el wv ${st}"><div class="wb" aria-hidden="true">${bars}</div><span>${e(text)}</span></div>`;
    }
    case "row":
      return `<div class="el row ${st}">${e(text)}</div>`;
    case "text":
      return `<div class="el tx ${st}">${e(text)}</div>`;
  }
}

function element(el: UiEl): string {
  const m = mock(el.kind, el.text, el.value, el.side, `s-${el.state}`);
  const note = el.note ? `<div class="an">${NOTE_ARROW}<span>${e(el.note)}</span></div>` : "";
  return `<div class="ew${el.hl ? " hl" : ""}">${m}${note}</div>`;
}

function journeyBody(p: JourneyPanel): string {
  const steps = p.steps
    .map(
      (s, i) =>
        `<li class="st${s.optional ? " op" : ""} s-${s.state}"><b class="sn">${i + 1}</b><small>${e(s.label)}</small>${mock(s.el.kind, s.el.text, s.el.value, "left", `s-${s.state}`)}</li>`,
    )
    .join(`<li class="sa" aria-hidden="true">${ARROW_R}</li>`);
  return `<ol class="jy">${steps}</ol>`;
}

function uiBody(p: UiPanel): string {
  const els = p.elements.map(element).join("");
  const top = p.frame === "mac" ? `<div class="tb"><i></i><i></i><i></i><span>${e(p.title)}</span></div>` : p.frame === "phone" ? `<div class="nt"></div>` : p.title ? `<div class="tb"><span>${e(p.title)}</span></div>` : "";
  return `<div class="fr ${p.frame}">${top}<div class="fb">${els}</div></div>`;
}

function body(p: Panel, i: number, tmax: number): string {
  switch (p.kind) {
    case "ui":
      return uiBody(p);
    case "timeline":
      return timelineSvg(p, tmax, String(i));
    case "sequence":
      return sequenceSvg(p, String(i));
    case "architecture":
      return architectureSvg(p, String(i));
    case "journey":
      return journeyBody(p);
  }
}

function metric(m: Metric): string {
  const value = m.before ? `<s>${e(m.before)}</s>${ARROW_R}<b>${e(m.after)}</b>` : `<b>${e(m.after)}</b>`;
  const src = m.source.replace(/^measured\s*/i, "").trim();
  // "measured on the staging copy" reads as one phrase; a bare noun needs the comma.
  const note = m.verified ? (src ? (/^(?:on|in|by|from|at)\b/i.test(src) ? `measured ${e(src)}` : `measured, ${e(src)}`) : "measured") : "target";
  return `<li><span class="ml">${e(m.label)}</span><span class="mv">${value}</span><span class="tg${m.verified ? " ms" : ""}">${note}</span></li>`;
}

/** The explain page body and styles as one self-contained document. */
export function renderExplainHtml(spec: ExplainSpec): string {
  const tmax = timelineMax(spec.panels.filter((p): p is TimelinePanel => p.kind === "timeline"));
  const two = spec.panels.length > 1;
  const panels = spec.panels
    .map((p, i) => {
      const accent = i === spec.panels.length - 1;
      return `<article class="pn${accent ? " a" : ""}">${p.label ? `<h2>${e(p.label)}</h2>` : ""}${body(p, i, tmax)}${p.caption ? `<p class="cp">${e(p.caption)}</p>` : ""}</article>`;
    })
    .join("");
  const metrics = spec.metrics.length ? `<ul class="mx">${spec.metrics.map(metric).join("")}</ul>` : "";
  const callouts = spec.callouts.length ? `<ol class="co">${spec.callouts.map((c) => `<li>${e(c)}</li>`).join("")}</ol>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
${EXPLAIN_CSS}
</style></head><body><main class="ex">
<h1>${e(spec.title)}</h1>${spec.takeaway ? `<p class="tk">${e(spec.takeaway)}</p>` : ""}
<section class="ps${two ? " two" : ""}">${panels}</section>
${metrics}${callouts}
</main></body></html>
`;
}
