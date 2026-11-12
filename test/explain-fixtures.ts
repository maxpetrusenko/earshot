/** A valid ui_before_after spec used by tests, as the model would return it. */
export const EXPLAIN_SPEC = {
  no_image: false,
  title: "Retries now stop at five",
  takeaway: "A failing webhook used to retry forever; now it gives up after five tries.",
  type: "bug_before_after",
  panels: [
    {
      label: "Before: retries never stop",
      frame: "mac",
      title: "Webhook log",
      elements: [
        { kind: "row", text: "Attempt 1 failed", state: "normal" },
        { kind: "row", text: "Attempt 2 failed", state: "normal" },
        { kind: "row", text: "Attempt 40 failed", state: "bad" },
        { kind: "bar", text: "Retry counter resets on each 5xx", value: 10, state: "bad" },
      ],
    },
    {
      label: "After: gives up at five",
      frame: "mac",
      title: "Webhook log",
      elements: [
        { kind: "row", text: "Attempt 4 failed", state: "normal" },
        { kind: "row", text: "Attempt 5 failed", state: "normal" },
        { kind: "button", text: "Stopped after 5 tries", state: "good" },
        { kind: "bar", text: "Retry counter keeps its value", value: 100, state: "good" },
      ],
    },
  ],
  callouts: ["Counter no longer resets", "212 tests pass"],
  metrics: [{ label: "Max attempts", before: "unbounded", after: "5", verified: true }],
  assumptions: [],
};
