import type { ExplainSpec, Panel } from "./explain-schema.js";

/** A node name that names nothing. */
const GENERIC = /^(?:component|service|module|box|layer|node|block|thing|item|step)\s*\d*$/i;

/** Every drawn name of a reference-style panel, for the shared placeholder and bare-status checks. */
export function cardLabels(p: Panel): string[] {
  switch (p.kind) {
    case "cards":
      return p.cards.flatMap((c) => [c.tag, c.title, c.mono]).filter(Boolean);
    case "range":
      return p.rows.map((r) => r.label);
    case "layers":
      return p.layers.flatMap((l) => [l.name, ...l.items.map((i) => i.name)]);
    default:
      return [];
  }
}

/** True for panels drawn as cards, a range axis or layers. */
export const isCardPanel = (p: Panel | undefined): boolean => p?.kind === "cards" || p?.kind === "range" || p?.kind === "layers";

const words = (t: string): number => t.split(/\s+/).filter(Boolean).length;

/**
 * Gate for the reference style. Rules: phone-first and one concept; a PROJECT / KIND eyebrow, a short declarative
 * headline and a one-line subhead; values exactly as the reply gives them; an axis only when numbers exist;
 * illustrative values say so in the eyebrow; architecture only as real named layers with icons.
 */
export function cardsGate(spec: ExplainSpec): string | null {
  const p = spec.panels[0];
  if (!p || spec.panels.length !== 1) return "this type takes exactly one panel";
  if (!spec.eyebrow || !spec.eyebrow.includes("/")) return 'needs an eyebrow in the form "PROJECT / KIND", for example "EARSHOT / LOG COMPARISON"';
  if (words(spec.title) > 9) return "the headline must be a short declarative conclusion, nine words at most";
  if (!spec.takeaway) return "needs a one-line subhead (takeaway)";
  if (spec.illustrative && !/illustrative/i.test(spec.eyebrow)) return 'the values are marked illustrative, so the eyebrow must say it, for example "EARSHOT / ILLUSTRATIVE DATA"';
  switch (p.kind) {
    case "cards": {
      if (p.cards.length !== 2) return "needs exactly two labeled cards (BEFORE and AFTER, or two named states)";
      if (spec.type === "log_compare") {
        if (p.cards.some((c) => !c.tag || !c.mono)) return "each card needs a tag (BEFORE, AFTER) and the exact log or console value in mono";
        if (new Set(p.cards.map((c) => c.mono)).size < 2) return "the two cards show the same value; show what looked wrong against what is right";
      } else {
        if (p.cards.some((c) => !c.tag || !c.title || c.mark === "none")) return "each state card needs a tag, a state name and a mark (dashed or wave)";
        if (p.cards[0]!.mark === p.cards[1]!.mark) return "the two states must look different: give them different marks";
      }
      return null;
    }
    case "range": {
      if (!p.unit) return "a range chart needs the unit the reply uses";
      if (p.rows.length < 2) return "a range chart needs at least two rows with numbers from the reply; with no timings or values there is no axis, so use a card type or return no_image";
      if (p.rows.some((r) => !r.label)) return "every row needs a label";
      return null;
    }
    case "layers": {
      if (p.layers.length < 3) return "a layered architecture needs at least three layers";
      const nodes = p.layers.flatMap((l) => (l.items.length ? l.items : [l]));
      const generic = nodes.find((n) => GENERIC.test(n.name));
      if (generic) return `"${generic.name}" is not a real component name`;
      const bare = nodes.find((n) => !n.icon);
      if (bare) return `"${bare.name}" needs an icon from the allowed list`;
      if (!p.layers.slice(0, -1).some((l) => l.link)) return "label what travels between the layers on at least one arrow";
      return null;
    }
    default:
      return "this type needs the card, range or layer panel";
  }
}
