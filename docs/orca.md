# Orca inline player

Read when: you run Claude Code inside Orca and want to tap Play in the chat instead of opening a link.

Orca's native chat renders an HTML page inline when a reply has `::orca-visual{file="<name>.html" title="..."}` on its own line, with the file in `$ORCA_CHAT_SCRATCH_DIR`. earshot writes the player page plus up to three explain pages, each with its own headline, and prints their lines in this order:

1. `earshot-<id>-player.html`: a compact control bar and nothing else, no image. Play and Original (one track at a time, resume from the paused offset), a seek bar, back and forward 10 s, a speed button cycling 1x, 1.25x, 1.5x and 2x, and elapsed / total time. Space toggles play and pause when the frame has focus. Errors show in the status line under the bar.
2. `earshot-<id>-explain.html`, `-explain2.html`, `-explain3.html`: one page per concept, only for the concepts worth a picture (see Explain below). Display-only, and they show on iPhone. The line's title is the page's own headline.
3. `[Listen](...) · [Original](...)`, always the last line.

## Devices

The reply text is the same on Orca Mac and Orca iOS, and iOS cannot tap an inline visual.

| Surface | What happens |
|---|---|
| Orca Mac | the player bar works inline, confirmed 2026-11-12 |
| Orca iOS / iPadOS | the player page detects the device at run time (user agent, `navigator.maxTouchPoints`, and the iPad that reports a Mac user agent) and renders nothing: `display:none` and zero height, so Orca fits an empty frame to no content. The audio is never decoded there. The markdown links are the way to listen |

Limit: the Listen and Original links cannot be hidden on the Mac. The markdown is identical on both devices, and Orca's own visual skill (`orca-chat-visuals`) documents only `::orca-visual{file title}` with no device-conditional content, so there is nothing to key off. earshot keeps the links, makes them the last line, and keeps them to one short line. The collapse is tested in headless WebKit with an iPhone device profile (frame height 0), and the same page keeps its full height in desktop WebKit and Chromium.

## Explain

The pages are explanations of what changed, not a chain of boxes: a real interface before and after, a latency timeline, a journey the user actually takes. One LLM call (stage `explain`) takes the reply text, redacted when `privacy.redact` is on, and returns structured JSON only, either one visual or `{"visuals":[...]}` with up to three concepts. The system prompt is `prompts/visual-explainer.v2.txt` verbatim plus `prompts/visual-explainer-format.v2.txt`, which replaces its output list with the schema. The call starts at the beginning of the pipeline, next to the script and the speech, so it never delays audio; a failure is recorded as a non-fatal `explain:` failure.

The model picks a type and fills panels for it:

| Type | Panels |
|---|---|
| `ui_before_after`, `bug_before_after` | two panels of interface elements (bar, controls, button, link, bubble, wave, row, text) in a Mac window, phone, chat or plain frame |
| `timeline` | lanes of segments with start and duration, on one shared scale across the panels |
| `sequence` | actors and messages |
| `architecture` | components and labeled data paths |
| `journey` | three to five steps, each showing the real thing the user sees |

Every panel carries a caption about what the user can now do, and an element that changed is outlined with a short arrow note. The spec also carries a title, a takeaway, up to three callouts and metrics. A metric with `verified: true` is shown as measured, with the source it names; an unverified one is shown with the word "target". `{"no_image": true}` (or the text `NO_IMAGE`) means no page: a status update, a short answer, a test run.

Code validates the JSON strictly (unknown fields dropped, strings capped and stripped of emoji and long dashes, counts capped), then a quality gate checks every visual on its own: a before/after type needs two panels, each with at least three real interface elements and a caption; a timeline needs at least two segments per panel; a sequence needs two actors and two messages; an architecture needs three components and labeled data paths; a journey needs three steps with something drawn in each; a bare "Fixed", "Implemented", "Completed" or "Merged" label is rejected, as is a box that says "Diagram". The whole picture must also reach 0.55 visual density, so a page of sentences, or a mostly empty one, is rejected. On a miss the model is asked once more with the gate's feedback; visuals that pass ship, and a second miss counts as no image. Fixed HTML and SVG templates draw the pages (the model never writes markup), every value is escaped and the SVG goes through the allowlist sanitizer. The pages are light, use a local font stack, read Orca theme tokens with fallbacks, never redefine one, stack the panels below 760 px and sit side by side above it. Only the player collapses on iOS; the explain pages do not.

`--explain-png` also writes one PNG per explain page (`earshot-<id>-explain.png`, `-explain2.png`, `-explain3.png`), 1080 px wide at 2x and full page height, through Playwright, which must be installed with a Chromium. `--no-explain` or `--no-sketch` skips the stage, and `image.type: none` disables it in config. `pnpm tsx scripts/explain-demo.ts [--shots]` runs the live model over `test/fixtures/explain/*.json`; `pnpm tsx scripts/explain-preview.ts <spec.json> [out.html] [--shots]` renders a saved or hand-written answer without an LLM and prints each visual's density and gate result; `pnpm tsx scripts/explain-score.ts <png|dir>` scores screenshots with Opus (`--json` for machine output).

## Why Web Audio

Orca's content security policy blocks `data:` URLs for media, so `<audio src="data:audio/mpeg;base64,...">` fails with `NotSupportedError`. The page cannot fetch the audio either, because it has no network access. It embeds the MP3 as base64 text, decodes it with `AudioContext.decodeAudioData`, and plays it through an `AudioBufferSourceNode`. Seek, skip and speed changes stop the source and start a new one at the new offset, so the position is `offset + (context time - start time) * rate` at every speed.

## Use

```bash
echo "<agent reply>" | earshot run --format auto
```

`--format auto` picks the Orca output when `ORCA_CHAT_SCRATCH_DIR` is set and writable, and otherwise prints the links at once and finishes the memo in the background. `--format orca` forces the Orca output and falls back to the markdown line when the page cannot be made. `--orca-dir <path>` overrides the scratch directory. Orca output waits for the finished audio, so it cannot be combined with `--detach`.

The Stop hook treats either line as already narrated.

## Page size

The player page embeds both tracks, re-encoded with ffmpeg to mono, 22.05 kHz MP3. earshot predicts the size from the track durations, picks 24k, 20k or 16k, and encodes once. Budget is 480 KB (Orca's limit is 512 KB). If 16k still does not fit, the original track is dropped and the page says so. The files are `earshot-<brief id>-player.html`, `-explain.html`, `-explain2.html` and `-explain3.html`; each page needs a new file name.

## Speed

Inline mode waits for the whole audio, so the time to the line is the time to finish both tracks. Kokoro-FastAPI handles one request at a time, so two tracks on one server take the sum of their audio. When the caller waits for the audio, earshot sends the first chunk of a track alone, so its first audio is not queued behind the other chunks on a Kokoro that serves one request at a time, then sends the rest at once and writes them in order, and `tts.original_base_url` can point the original track at a second Kokoro instance so the tracks stop competing:

```bash
# on the TTS host: a second instance on another port
uvicorn api.src.main:app --host <addr> --port 8883
```

```yaml
tts:
  original_base_url: http://<addr>:8883/v1
```

Measured through the skill's command (`earshot run --format auto`, short style, Claude script, Kokoro on a Mac mini with a second instance for the original), on a 0.4 KB reply, two runs:

| Run | Time from reply in to both lines out |
|---|---|
| 1 | 7.0 s |
| 2 | 11.1 s |

Run 2 broke down as script 9.5 s (the LLM, which varies), original speech 4.5 s in parallel, edited speech finishing 1.2 s after the script, page encode 0.15 s. The page was 212 KB.

## Limits

- Not verified: whether Orca re-renders a file in place when it is rewritten. Each page needs a new file name.
- The page uses Orca theme tokens with fallbacks; it never redefines a token and avoids `100vh`.
