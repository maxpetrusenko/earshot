import { describe, expect, it } from "vitest";
import { explainGate, uiGroundingProblem } from "../src/explain-gate.js";
import { parseExplain, type ExplainSpec } from "../src/explain-schema.js";

const REPLY = 'The invoice toolbar now has an Export button next to the search box. The button opens a dropdown with CSV and PDF. Before, a grey link labelled More hid the Export menu.';
const director = { intent: "see the export button", key_frame: "toolbar with Export", first_look: "Export button", two_second_test: "Export button visible", motion: "no, a static frame" };
const el = (kind: string, text: string, extra: Record<string, unknown> = {}) => ({ kind, text, ...extra });
const ui = (before: unknown[], after: unknown[]): ExplainSpec =>
  parseExplain({
    director,
    eyebrow: "INVOICES / UI",
    title: "Export is one click now.",
    takeaway: "The toolbar shows it.",
    type: "ui_before_after",
    panels: [
      { label: "Before", caption: "Export was buried in a menu.", frame: "mac", title: "Invoices", elements: before },
      { label: "After", caption: "Export sits in the toolbar.", frame: "mac", title: "Invoices", elements: after },
    ],
  })!;

describe("ui_before_after only shows what the reply names", () => {
  const grounded = [el("link", "More"), el("button", "Export"), el("text", "search box"), el("row", "dropdown with CSV and PDF")];
  it("passes a panel built from the reply's own elements", () => {
    expect(uiGroundingProblem(ui(grounded, grounded), REPLY)).toBeNull();
    expect(explainGate(ui(grounded, grounded), undefined, REPLY)).toBeNull();
  });
  it("allows one generic element per panel, not two", () => {
    expect(uiGroundingProblem(ui([...grounded, el("bar", "Navigation sidebar")], grounded), REPLY)).toBeNull();
    expect(uiGroundingProblem(ui([...grounded, el("bar", "Navigation sidebar"), el("row", "Avatar menu")], grounded), REPLY)).toMatch(/never names/);
  });
  it("rejects an outlined element the reply does not name", () => {
    expect(uiGroundingProblem(ui([...grounded, el("button", "Settings gear", { highlight: true })], grounded), REPLY)).toMatch(/outlines "Settings gear"/);
  });
  it("sends a reply that names too little to a flow or no_image", () => {
    const filler = [el("bar", "Top navigation"), el("row", "Invoice #1042"), el("row", "Invoice #1043"), el("button", "Export")];
    expect(uiGroundingProblem(ui(filler, filler), REPLY)).toMatch(/never names|flow/);
  });
  it("does not apply to other types, and is skipped when no reply is given", () => {
    const filler = [el("bar", "Top navigation"), el("row", "Invoice #1042"), el("row", "Invoice #1043"), el("button", "Export")];
    expect(explainGate(ui(filler, filler))).toBeNull();
  });
});

describe("flow notes and footers are shortened by the model, not cut by the parser", () => {
  const flow = (note: string, footer = "") => ({
    director,
    eyebrow: "BILLING / PLAN",
    title: "Step 2 needs your call.",
    takeaway: "One step carries the risk.",
    type: "flow",
    footer,
    panels: [{ steps: [{ name: "Read export", icon: "file" }, { name: "Change POST", icon: "code", state: "changed", note }, { name: "Notify owner", icon: "send" }] }],
  });
  it("keeps a long note whole and the gate asks for a shorter one", () => {
    const long = "Two internal scripts expect the file. Keep a flag for one release so they can switch.";
    const s = parseExplain(flow(long))!;
    expect(explainGate(s)).toMatch(/note on "Change POST" is \d+ characters; at most 64/);
    expect(explainGate(parseExplain(flow("Two scripts expect the old file"))!)).toBeNull();
  });
  it("a footer over 120 characters is sent back, not cut", () => {
    const f = "x".repeat(60) + " " + "y".repeat(70);
    expect(explainGate(parseExplain(flow("Scripts expect the file", f))!)).toMatch(/footer is \d+ characters/);
  });
  it("more than three outlined elements in a ui panel is sent back", () => {
    const e = (t: string) => el("button", t, { highlight: true });
    expect(explainGate(ui([e("Export"), e("More"), e("search box"), e("dropdown")], [el("button", "Export"), el("link", "More"), el("row", "CSV and PDF")]), undefined, REPLY)).toMatch(/more than three/);
  });
});
