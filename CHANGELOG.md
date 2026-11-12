# Changelog

## Unreleased

- Explainer v2: up to three concepts per reply (`{"visuals":[...]}`), one page each with its own headline (`explain.html`, `explain2.html`, `explain3.html`), each printed as its own Orca line. Prompts `visual-explainer.v2` and `visual-explainer-format.v2`. New `journey` type, per-panel impact captions, outlined changed controls with arrow notes, a shared timeline scale, and a measured-or-target note on every metric with its source. The gate now rejects sparse panels, panels without a caption, placeholder "Diagram" boxes, and anything below 0.55 visual density. Multi-visual runs no longer crash: the bundle allowlist accepts `explain2.html` and `explain3.html`, and a pipeline crash now prints its stack instead of exiting silently.
- `scripts/explain-preview.ts` renders a saved or hand-written answer without an LLM and prints density and gate results; `scripts/explain-score.ts` scores screenshots with Opus and exits 2 when the Claude login cannot be used.
- `examples/`: one reply end to end, with both audio tracks, the edited script, its reasoning, and two explainer pages.
- Claude Code Play button mod (`integrations/claude-code/mod/earshot-player/`): hides the Listen line and draws Play and Original buttons under the reply. Accepts `[Listen](url)`, `[Listen original](url)` and `[Original](url)`, case-insensitive; no-op on the `mobile` surface. `earshot install claude-code --mode mod` copies it to `<claude dir>/skills/earshot-player/` (auto-loaded by Claude Code); `uninstall --mode mod` removes it. The buttons draw only inside Claude Code's own UI, not in Orca or the phone app.
- Orca inline player rewritten on the Web Audio API (`decodeAudioData` plus `AudioBufferSourceNode`). The old `<audio src="data:...">` page failed in Orca with `NotSupportedError`. The player page is a compact bar: Play/Pause, Original, a seek bar, back and forward 10 s, speed (1x, 1.25x, 1.5x, 2x), elapsed / total, and Space to toggle.
- `--format auto`: inside Orca (`ORCA_CHAT_SCRATCH_DIR` writable) the skill prints the `::orca-visual` line and then the markdown links; elsewhere it prints the links at once. The Claude Code skill now uses it.
- Orca output is now two independent visuals, player first: `earshot-<id>-player.html` (control bar only, no image) and `earshot-<id>-explain.html` (visual explanation only), then the Listen / Original line last. The player detects iOS and iPadOS at run time and collapses to nothing there, since iOS cannot tap an inline visual. The Mac cannot hide the markdown links (the text is the same on both devices); see docs/orca.md.
- The flow diagram is replaced by an explain stage: one LLM call (prompt `visual-explainer.v1`, verbatim, plus a JSON output-format appendix) turns the reply into a structured spec of what changed (before/after UI, bug before/after, architecture, timeline, sequence or example in/out). Deterministic HTML/SVG templates draw it, so the model never writes markup. It runs in parallel with the script and speech, a quality gate rejects bare label boxes and "Fixed"/"Merged" style labels (one retry, then no image), and small replies get no image. The page shows on iPhone too. `--explain-png` also writes a 1080x1350 PNG; `--no-explain` (or `--no-sketch`) skips it. Metrics are shown as measured only when the model marks them verified, otherwise as a target.
- Prompt `ear-script.v4` (the default short style) no longer asks for a diagram. v3 had lost its body (length, order and voice rules) in the previous release; v4 restores it from v2 and keeps the evidence key. The flow parser, the red/green flow renderer and `scripts/sketch-hitrate.ts` are removed; `scripts/explain-demo.ts` runs the explain stage live over `test/fixtures/explain`.
- Faster first audio when the caller waits for the whole track: the first chunk is sent alone, then the rest. Original first audio on a second Kokoro dropped from about 6.7 s to 0.9 s on a 1 KB reply.
- Removed: `--orca-audio` and the `orca.audio` config key. The stream page needed network access, which Orca pages do not have.

## 1.0.0 (2026-11-11)

First stable release.

- Ear-first rewrite: the memo is written for listening, with the diagram as a glance companion.
- Two links under every reply: `[Listen](...) · [Original](...)`. Both stream while the memo is still being made. The file names `edited.mp3` and `original.mp3` are unchanged, so older links keep working.
- Listen is a short summary (prompt v2, `script.style: short`, the default): 20 to 40 seconds, hard cap of 110 words enforced at a sentence boundary, ordered as what got done, what changed, then one decision as a question. It skips quoted text, file names, paths, number lists and URLs. `story` and `brief` stay selectable.
- Original is the reply read as written, cleaned for speech: code blocks, link targets, URLs, flags, paths and the earshot link line are skipped, and a table becomes one line saying it is in the chat.
- Claude Code skill and Stop hook. The skill asks for a link under every reply; the hook defaults to `min_chars: 80` and `require_tool_use: false`, and skips replies the skill already narrated.
- Codex `notify` program and an MCP server (`narrate`, `brief_status`).
- Scrubbing of keys, tokens and private keys before any network call.
- Tailnet-only serving through `tailscale serve`; there is no public mode.
