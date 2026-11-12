# Orca inline player

Read when: you run Claude Code inside Orca and want to tap Play in the chat instead of opening a link.

Orca's native chat renders an HTML page inline when a reply has `::orca-visual{file="<name>.html" title="..."}` on its own line, with the file in `$ORCA_CHAT_SCRATCH_DIR`. earshot writes up to two pages and prints their lines in this order:

1. `earshot-<id>-player.html`: a compact control bar and nothing else, no image. Play and Original (one track at a time, resume from the paused offset), a seek bar, back and forward 10 s, a speed button cycling 1x, 1.25x, 1.5x and 2x, and elapsed / total time. Space toggles play and pause when the frame has focus. Errors show in the status line under the bar.
2. `earshot-<id>-explain.html`: a visual explanation of what changed, only when a picture helps (see Explain below). Display-only, and it shows on iPhone.
3. `[Listen](...) · [Original](...)`, always the last line.

## Devices

The reply text is the same on Orca Mac and Orca iOS, and iOS cannot tap an inline visual.

| Surface | What happens |
|---|---|
| Orca Mac | the player bar works inline, confirmed 2026-11-12 |
| Orca iOS / iPadOS | the player page detects the device at run time (user agent, `navigator.maxTouchPoints`, and the iPad that reports a Mac user agent) and renders nothing: `display:none` and zero height, so Orca fits an empty frame to no content. The audio is never decoded there. The markdown links are the way to listen |

Limit: the Listen and Original links cannot be hidden on the Mac. The markdown is identical on both devices, and Orca's own visual skill (`orca-chat-visuals`) documents only `::orca-visual{file title}` with no device-conditional content, so there is nothing to key off. earshot keeps the links, makes them the last line, and keeps them to one short line. The collapse is tested in headless WebKit with an iPhone device profile (frame height 0), and the same page keeps its full height in desktop WebKit and Chromium.

## Explain

The picture is an explanation of what changed, not a chain of boxes. One LLM call (stage `explain`) takes the reply text, redacted when `privacy.redact` is on, and returns structured JSON only. The system prompt is `prompts/visual-explainer.v1.txt` verbatim plus `prompts/visual-explainer-format.v1.txt`, which replaces its output list with the schema. The call starts at the beginning of the pipeline, next to the script and the speech, so it never delays audio; a failure is recorded as a non-fatal `explain:` failure.

The model picks a type and fills panels for it:

| Type | Panels |
|---|---|
| `ui_before_after`, `bug_before_after` | two panels of interface elements (bar, controls, button, link, bubble, image, row, text) in a Mac window, phone, chat or plain frame |
| `timeline` | lanes of segments with start and duration, on one shared scale |
| `sequence` | actors and messages |
| `architecture` | components and labeled data paths |

It also returns a title, a takeaway, up to three callouts and metrics. A metric with `verified: true` is shown as measured; an unverified one is shown with the word "target". `{"no_image": true}` (or the text `NO_IMAGE`) means no page: a status update, a short answer, a test run.

Code validates the JSON strictly (unknown fields dropped, strings capped and stripped of emoji and long dashes, counts capped), then a quality gate checks it: a before/after type needs two panels with real elements, a timeline needs segments, a sequence needs messages, an architecture needs labeled data paths, and a bare "Fixed", "Implemented", "Completed" or "Merged" label is rejected. On a miss the model is asked once more with the gate's feedback; a second miss counts as no image. Fixed HTML and SVG templates draw the page (the model never writes markup), every value is escaped and the SVG goes through the allowlist sanitizer. The page is light, uses a local font stack, reads Orca theme tokens with fallbacks, never redefines one, stacks the panels below 760 px and sits side by side above it. Only the player collapses on iOS; this page does not.

`--explain-png` also writes `earshot-<id>-explain.png` (1080x1350, through Playwright, which must be installed with a Chromium) next to the page. `--no-explain` or `--no-sketch` skips the stage, and `image.type: none` disables it in config. `pnpm tsx scripts/explain-demo.ts [--shots]` runs the live model over `test/fixtures/explain/*.json` and writes pages and screenshots to `~/earshot-demo/`.

## Why Web Audio

Orca's content security policy blocks `data:` URLs for media, so `<audio src="data:audio/mpeg;base64,...">` fails with `NotSupportedError`. The page cannot fetch the audio either, because it has no network access. It embeds the MP3 as base64 text, decodes it with `AudioContext.decodeAudioData`, and plays it through an `AudioBufferSourceNode`. Seek, skip and speed changes stop the source and start a new one at the new offset, so the position is `offset + (context time - start time) * rate` at every speed.

## Use

```bash
echo "<agent reply>" | earshot run --format auto
```

`--format auto` picks the Orca output when `ORCA_CHAT_SCRATCH_DIR` is set and writable, and otherwise prints the links at once and finishes the memo in the background. `--format orca` forces the Orca output and falls back to the markdown line when the page cannot be made. `--orca-dir <path>` overrides the scratch directory. Orca output waits for the finished audio, so it cannot be combined with `--detach`.

The Stop hook treats either line as already narrated.

## Page size

The player page embeds both tracks, re-encoded with ffmpeg to mono, 22.05 kHz MP3. earshot predicts the size from the track durations, picks 24k, 20k or 16k, and encodes once. Budget is 480 KB (Orca's limit is 512 KB). If 16k still does not fit, the original track is dropped and the page says so. The files are `earshot-<brief id>-player.html` and `earshot-<brief id>-explain.html`; each page needs a new file name.

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
