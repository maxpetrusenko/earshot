/**
 * A valid bug_before_after spec used by tests, as the model would return it.
 * It carries the v2 shape: per-panel impact caption, highlighted changed controls with arrow notes.
 */
export const EXPLAIN_SPEC = {
  no_image: false,
  title: "Retries now stop at five",
  takeaway: "You get a dead-letter alert after five tries instead of a queue that retries forever.",
  type: "bug_before_after",
  panels: [
    {
      label: "Before: retries never stop",
      caption: "One bad endpoint could retry all night and hide the real failure from you.",
      frame: "mac",
      title: "Webhook log",
      elements: [
        { kind: "row", text: "Attempt 1 failed", state: "normal" },
        { kind: "row", text: "Attempt 2 failed", state: "normal" },
        { kind: "row", text: "Attempt 40 failed", state: "bad" },
        { kind: "bar", text: "Retry counter resets on each 5xx", value: 10, state: "bad", highlight: true, note: "counter drops to zero on the rebuilt request" },
        { kind: "controls", text: "Retry|Backoff|Pause queue", state: "muted" },
      ],
    },
    {
      label: "After: gives up at five",
      caption: "You see the job marked dead after five tries, with the endpoint named.",
      frame: "mac",
      title: "Webhook log",
      elements: [
        { kind: "row", text: "Attempt 4 failed", state: "normal" },
        { kind: "row", text: "Attempt 5 failed", state: "normal" },
        { kind: "button", text: "Job marked dead", state: "good", highlight: true, note: "one alert instead of a loop" },
        { kind: "bar", text: "Retry counter keeps its value", value: 100, state: "good", highlight: true, note: "lives on the job record now" },
      ],
    },
  ],
  callouts: ["Counter no longer resets", "212 tests pass"],
  metrics: [{ label: "Max attempts", before: "unbounded", after: "5", verified: true, source: "measured on staging, failing endpoint" }],
  assumptions: [],
};
