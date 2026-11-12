import { renderMermaid } from "beautiful-mermaid";
import type { LlmProvider } from "./llm.js";
import { traceGeneration, traceSpan } from "./lib/llm-tracing.js";
import { extractJson } from "./earscript.js";
import { sanitizeSvg } from "./svg-sanitize.js";

export class SketchError extends Error {}

/** What the model returns for a multi-part task. "none" (or a missing key) means no picture. */
export interface FlowSpec {
  nodes: { id: string; label: string }[];
  edges: [string, string][];
  /** Node id of the part that was broken. */
  broken?: string;
  /** Node id of the part that fixed it. */
  fixed?: string;
}

export const FLOW_MIN_NODES = 3;
export const FLOW_MAX_NODES = 7;

const cleanLabel = (s: unknown): string =>
  String(s ?? "")
    .replace(/[^A-Za-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4)
    .join(" ")
    .slice(0, 30);

/**
 * Validate the model's structured sketch. Returns null for "none", for junk and for anything that is not a
 * multi-part flow (under 3 or over 7 nodes, no edges): the reply then gets no picture.
 */
export function parseFlowSpec(raw: unknown): FlowSpec | null {
  let v = raw;
  if (typeof v === "string") {
    const t = v.trim();
    if (!t.startsWith("{")) return null;
    try {
      v = JSON.parse(t);
    } catch {
      return null;
    }
  }
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o.nodes) || !Array.isArray(o.edges)) return null;
  const nodes: FlowSpec["nodes"] = [];
  const seen = new Set<string>();
  for (const n of o.nodes) {
    const r = (n ?? {}) as Record<string, unknown>;
    const id = String(r.id ?? "").trim();
    const label = cleanLabel(r.label);
    if (!id || !label || seen.has(id)) continue;
    seen.add(id);
    nodes.push({ id, label });
  }
  if (nodes.length < FLOW_MIN_NODES || nodes.length > FLOW_MAX_NODES) return null;
  const edges: [string, string][] = [];
  for (const e of o.edges) {
    if (Array.isArray(e) && seen.has(String(e[0])) && seen.has(String(e[1])) && e[0] !== e[1]) edges.push([String(e[0]), String(e[1])]);
  }
  if (edges.length < nodes.length - 1) return null;
  const pick = (x: unknown) => (typeof x === "string" && seen.has(x) ? x : undefined);
  const broken = pick(o.broken);
  const fixed = pick(o.fixed);
  return { nodes, edges, ...(broken ? { broken } : {}), ...(fixed && fixed !== broken ? { fixed } : {}) };
}

const LETTERS = "ABCDEFGHIJ";

/** Mermaid source for a spec, plus the letter ids given to the broken and fixed nodes. The marked nodes carry a "broke" or "fixed" word. */
export function flowToMermaid(spec: FlowSpec): { mermaid: string; broken?: string; fixed?: string } {
  const letter = new Map(spec.nodes.map((n, i) => [n.id, LETTERS[i]!]));
  const lines = ["flowchart TD"];
  for (const n of spec.nodes) {
    const mark = n.id === spec.broken ? " broke" : n.id === spec.fixed ? " fixed" : "";
    lines.push(`  ${letter.get(n.id)}[${n.label}${mark}]`);
  }
  for (const [a, b] of spec.edges) lines.push(`  ${letter.get(a)} --> ${letter.get(b)}`);
  return { mermaid: lines.join("\n"), broken: spec.broken ? letter.get(spec.broken) : undefined, fixed: spec.fixed ? letter.get(spec.fixed) : undefined };
}

const MARKS = {
  broke: { fill: "#FDECEA", stroke: "#B42318", text: "#8A1C12" },
  fixed: { fill: "#E3F1EC", stroke: "#1F6F5C", text: "#14513F" },
};

/** Restyle one node group in the renderer's SVG: a visible border and fill, and a class the sanitizer keeps. */
function markNode(svg: string, id: string, kind: keyof typeof MARKS): string {
  const c = MARKS[kind];
  const re = new RegExp(`<g class="node" data-id="${id}"[^>]*>[\\s\\S]*?</g>`);
  return svg.replace(re, (g) =>
    g
      .replace('class="node"', `class="node ${kind}"`)
      .replace(/(<rect[^>]*?) fill="[^"]*" stroke="[^"]*" stroke-width="[^"]*"/, `$1 fill="${c.fill}" stroke="${c.stroke}" stroke-width="2.5"`)
      .replace(/(<text[^>]*?) fill="[^"]*"/, `$1 fill="${c.text}"`)
      .replace(/font-weight="500"/, 'font-weight="700"'),
  );
}

/** Render a structured flow to a sanitized SVG with the broken node red and the fixed node green. */
export async function renderFlow(spec: FlowSpec): Promise<{ svg: string; mermaid: string }> {
  const { mermaid, broken, fixed } = flowToMermaid(spec);
  const base = await renderMermaidRaw(mermaid);
  let svg = base;
  if (broken) svg = markNode(svg, broken, "broke");
  if (fixed) svg = markNode(svg, fixed, "fixed");
  const clean = sanitizeSvg(svg);
  if (!clean.includes("<svg")) throw new SketchError("renderer produced no svg");
  return { svg: clean, mermaid };
}

export interface Sketch {
  svg: string;
  mermaid: string;
  retries: number;
}

const THEME = {
  bg: "#FAF7F2",
  fg: "#1B1B18",
  line: "#1F6F5C",
  accent: "#1F6F5C",
  muted: "#5B5A52",
  surface: "#F1EBDD",
  border: "#1F6F5C",
  font: "Helvetica Neue",
  padding: 28,
  nodeSpacing: 36,
  layerSpacing: 52,
};

/** The prompt promises only these characters. Anything else is rejected before rendering. */
export function validateMermaid(src: string): string | null {
  if (!/^flowchart (?:LR|TD)\b/.test(src)) return 'diagram must start with "flowchart LR" or "flowchart TD"';
  if (!/^[A-Za-z0-9 \t\[\]\-.>\n]+$/.test(src)) return "diagram uses characters outside letters, digits, spaces, [ ] --> and -.->";
  const nodes = new Set([...src.matchAll(/\b([A-Za-z]\w*)\[/g)].map((m) => m[1]));
  if (nodes.size < 2 || nodes.size > 8) return `diagram has ${nodes.size} nodes; it needs 3 to 6`;
  return null;
}

/** Render Mermaid to a sanitized SVG. Throws SketchError on invalid or unrenderable input. */
async function renderMermaidRaw(mermaid: string): Promise<string> {
  const bad = validateMermaid(mermaid);
  if (bad) throw new SketchError(bad);
  try {
    return await renderMermaid(mermaid, THEME);
  } catch (e) {
    throw new SketchError(`render failed: ${(e as Error).message.split("\n")[0]}`);
  }
}

export async function renderSketch(mermaid: string): Promise<string> {
  const clean = sanitizeSvg(await renderMermaidRaw(mermaid));
  if (!clean.includes("<svg")) throw new SketchError("renderer produced no svg");
  return clean;
}

const FIX_SYSTEM =
  'You repair Mermaid flowcharts. Return one JSON object {"mermaid": "..."} and nothing else. ' +
  'Use only "flowchart LR" or "flowchart TD", 3 to 6 nodes, labels of one to three plain words, ' +
  "and only letters, digits, spaces and the characters [ ] --> -.-> . Use -.-> for any inferred link.";

/** Render; on failure ask the LLM once to repair using the error text. */
export async function buildSketch(llm: LlmProvider, mermaid: string): Promise<Sketch> {
  return traceSpan(
    "sketch",
    { input: { mermaid } },
    async () => {
      try {
        return { svg: await renderSketch(mermaid), mermaid, retries: 0 };
      } catch (first) {
        if (!(first instanceof SketchError)) throw first;
        const user = `This diagram failed: ${first.message}\n\n${mermaid}`;
        const raw = await traceGeneration("sketch-fix", { model: llm.model, input: user }, () =>
          llm.complete({ system: FIX_SYSTEM, user, json: true }),
        );
        const fixed = (extractJson(raw) as { mermaid?: unknown }).mermaid;
        if (typeof fixed !== "string") throw new SketchError("repair returned no diagram");
        return { svg: await renderSketch(fixed.trim()), mermaid: fixed.trim(), retries: 1 };
      }
    },
    (r) => ({ retries: r.retries, svg_bytes: r.svg.length }),
  );
}
