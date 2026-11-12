import { EXPLAIN_CSS } from "./explain-css.js";
import { architectureSvg, sequenceSvg, timelineMax, timelineSvg } from "./explain-svg.js";
import type { ExplainSpec, IoPanel, Metric, Panel, TimelinePanel, UiEl, UiPanel } from "./explain-schema.js";
import { escapeHtml as e } from "./orca.js";

/**
 * Deterministic templates: one per spec type. The model returns data only; every value is escaped here and
 * the SVG parts also pass the allowlist sanitizer. The page is display-only: no script, no audio, and no
 * iOS collapse (only the player hides there).
 */

const ARROW = `<svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true"><path d="M11 2v14M5 11l6 7 6-7" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ARROW_R = `<svg width="22" height="14" viewBox="0 0 22 14" aria-hidden="true"><path d="M1 7h18M13 1l7 6-7 6" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function element(el: UiEl): string {
  const st = `s-${el.state}`;
  switch (el.kind) {
    case "bar": {
      const track = el.value >= 0 ? `<div class="trk"><b style="width:${Math.round(el.value)}%"></b></div>` : `<div class="trk"><b style="width:35%"></b></div>`;
      return `<div class="el bar ${st}"><span>${e(el.text)}</span>${track}</div>`;
    }
    case "controls":
      return `<div class="el ctl ${st}">${el.text.split("|").map((t) => t.trim()).filter(Boolean).slice(0, 6).map((t) => `<span>${e(t)}</span>`).join("")}</div>`;
    case "button":
      return `<div class="el btn ${st}">${e(el.text)}</div>`;
    case "link":
      return `<div class="el lnk ${st}">${e(el.text)}</div>`;
    case "bubble":
      return `<div class="el bub ${el.side === "right" ? "r" : ""} ${st}">${e(el.text)}</div>`;
    case "image":
      return `<div class="el img ${st}">${e(el.text)}</div>`;
    case "row":
      return `<div class="el row ${st}">${e(el.text)}</div>`;
    case "text":
      return `<div class="el tx ${st}">${e(el.text)}</div>`;
  }
}

function uiBody(p: UiPanel): string {
  const els = p.elements.map(element).join("");
  const top = p.frame === "mac" ? `<div class="tb"><i></i><i></i><i></i><span>${e(p.title)}</span></div>` : p.frame === "phone" ? `<div class="nt"></div>` : p.title ? `<div class="tb"><span>${e(p.title)}</span></div>` : "";
  return `<div class="fr ${p.frame}">${top}<div class="fb">${els}</div></div>`;
}

function ioBody(p: IoPanel): string {
  return `<div class="io"><div class="bx"><small>${e(p.inLabel)}</small><code>${e(p.input)}</code></div><div class="tf">${ARROW}<span>${e(p.transform)}</span></div><div class="bx o"><small>${e(p.outLabel)}</small><code>${e(p.output)}</code></div></div>`;
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
    case "io":
      return ioBody(p);
  }
}

function metric(m: Metric): string {
  const value = m.before ? `<s>${e(m.before)}</s>${ARROW_R}<b>${e(m.after)}</b>` : `<b>${e(m.after)}</b>`;
  return `<li><span class="ml">${e(m.label)}</span><span class="mv">${value}${m.verified ? "" : `<span class="tg">target</span>`}</span></li>`;
}

/** The explain page body and styles as one self-contained document. */
export function renderExplainHtml(spec: ExplainSpec): string {
  const tmax = timelineMax(spec.panels.filter((p): p is TimelinePanel => p.kind === "timeline"));
  const two = spec.panels.length > 1;
  const panels = spec.panels
    .map((p, i) => {
      const accent = i === spec.panels.length - 1;
      return `<article class="pn${accent ? " a" : ""}">${p.label ? `<h2>${e(p.label)}</h2>` : ""}${body(p, i, tmax)}</article>`;
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
