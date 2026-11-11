import { renderMermaid } from "beautiful-mermaid";
import type { LlmProvider } from "./llm.js";
import { traceGeneration, traceSpan } from "./lib/llm-tracing.js";
import { extractJson } from "./earscript.js";
import { sanitizeSvg } from "./svg-sanitize.js";

export class SketchError extends Error {}

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
export async function renderSketch(mermaid: string): Promise<string> {
  const bad = validateMermaid(mermaid);
  if (bad) throw new SketchError(bad);
  try {
    const svg = await renderMermaid(mermaid, THEME);
    const clean = sanitizeSvg(svg);
    if (!clean.includes("<svg")) throw new SketchError("renderer produced no svg");
    return clean;
  } catch (e) {
    if (e instanceof SketchError) throw e;
    throw new SketchError(`render failed: ${(e as Error).message.split("\n")[0]}`);
  }
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
