# Changelog

## Unreleased

- Orca inline player rewritten on the Web Audio API (`decodeAudioData` plus `AudioBufferSourceNode`). The old `<audio src="data:...">` page failed in Orca with `NotSupportedError`. The page shows the memo title and sketch on top and a compact bar below: Play/Pause, Original, a seek bar, back and forward 10 s, speed (1x, 1.25x, 1.5x, 2x), elapsed / total, and Space to toggle.
- `--format auto`: inside Orca (`ORCA_CHAT_SCRATCH_DIR` writable) the skill prints the `::orca-visual` line and then the markdown links; elsewhere it prints the links at once. The Claude Code skill now uses it.
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
