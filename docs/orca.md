# Orca inline player

Read when: you run Claude Code inside Orca and want to tap Play in the chat instead of opening a link.

Orca's native chat renders an HTML page inline when a reply has `::orca-visual{file="<name>.html" title="..."}` on its own line, with the file in `$ORCA_CHAT_SCRATCH_DIR`. earshot writes the player page plus up to three explain pages, each with its own headline, and prints their lines in this order:

1. `earshot-<id>-player.html`: one compact row and nothing else, no image: a play / pause button, a Listen / Original toggle (the edited track or the original, one at a time, each resuming from its own paused offset; the toggle is absent when the original was dropped to fit the size budget) and elapsed / total time. There is no seek bar, no back or forward 10 s and no speed control. Space toggles play and pause when the frame has focus. Errors show in the status line under the row. On iOS and iPadOS the page still collapses to nothing (see Devices); the Listen links are the player there.
2. `earshot-<id>-explain.html`, `-explain2.html`, `-explain3.html`: one page per concept, only for the concepts worth a picture (see Explain below). Display-only, and they show on iPhone. The line's title is the page's own headline. In `--format auto` the chat gets an Explain line only with `--visual` (see below); otherwise the pages go on the card behind the links.
3. `[Listen](...) · [Original](...)`, always the last line.

## Agents in Orca

Orca launches any agent in its catalog (`orca orchestration worker-start --agent <alias>`: claude, codex, opencode, opencode2, cursor-agent, gemini, droid, hermes and about forty more). The `::orca-visual` line works for whichever agent prints it, so each agent needs the earshot step in its own instructions:

| Agent | Install |
|---|---|
| Claude Code | `earshot install claude-code` (skill) |
| Codex | `earshot install codex --mode instructions` |
| Cursor | `earshot install cursor` |
| opencode, opencode2 | `earshot install opencode` |
| Gemini CLI | `earshot install gemini` |
| Droid | `earshot install droid` |

A host reaches the links from a phone over the tailnet. On a host whose Tailscale is the macOS system-extension build (uniclaw), the CLI cannot reach the daemon over ssh, so set `serve.mode: tailnet-ip`: earshot then reads the tailnet IPv4 from the network interfaces (100.64.0.0/10) when `tailscale status` fails, and serves and links `http://<tailnet ip>:7777`.

## Frame height

Orca's visual shell (`native-chat-visual-shell`) reports `documentElement.getBoundingClientRect().height` (plus any body overflow) as the frame height. It ignores a height of 0, so a page that is `display:none` leaves the frame at its 160 px default, and it clamps the result to at least 80 px. The player is therefore as tall as its content with nothing added: `html` and `body` have margin 0, padding 0 and no min-height, and the bar is 80 px (`ORCA_MIN_FRAME_PX`) with the row centered, so the frame has no blank band under the row. A status message grows the bar. On iOS the page reports 1 px: the frame is 80 px and empty, the lowest Orca allows.

## Devices

The reply text is the same on Orca Mac and Orca iOS, and iOS cannot tap an inline visual.

| Surface | What happens |
|---|---|
| Orca Mac | the player bar works inline, confirmed 2026-11-12 |
| Orca iOS / iPadOS | the player page detects the device at run time (user agent, `navigator.maxTouchPoints`, and the iPad that reports a Mac user agent) and renders nothing: the bar is hidden and the body is 1 px, so Orca fits the frame to its 80 px minimum (a 0 px height would be ignored and leave the 160 px default). The audio is never decoded there. The markdown links are the way to listen |

Limit: the Listen and Original links cannot be hidden on the Mac. The markdown is identical on both devices, and Orca's own visual skill (`orca-chat-visuals`) documents only `::orca-visual{file title}` with no device-conditional content, so there is nothing to key off. earshot keeps the links, makes them the last line, and keeps them to one short line. The collapse is tested in headless WebKit with an iPhone device profile (page height 1 px), and the same page keeps its full height in desktop WebKit and Chromium.

## Explain

The pages are explanations of what changed, not a chain of boxes: a real interface before and after, a latency timeline, a journey the user actually takes. One LLM call (stage `explain`) takes the reply text, redacted when `privacy.redact` is on, and returns structured JSON only, either one visual or `{"visuals":[...]}` with up to three concepts. The system prompt is `prompts/visual-explainer.v6.txt` verbatim plus `prompts/visual-explainer-format.v6.txt`, which replaces its output list with the schema. The call starts at the beginning of the pipeline, next to the script and the speech, so it never delays audio; a failure is recorded as a non-fatal `explain:` failure.

The model picks a type and fills panels for it:

| Type | Panels |
|---|---|
| `ui_before_after`, `bug_before_after` | two panels of interface elements (bar, controls, button, link, bubble, wave, row, text) in a Mac window, phone, chat or plain frame |
| `timeline` | lanes of segments with start and duration, on one shared scale across the panels |
| `sequence` | actors and messages |
| `architecture` | components and labeled data paths |
| `journey` | three to five steps, each showing the real thing the user sees |
| `flow` | 3 to 7 real steps in one direction with an icon each; the changed step is outlined, the broken step is red with its cause; optional before and after lanes share rows. Rejected with no marked step or generic names |
| `ranked`, `grid` | options best first with one recommended; hosts or agents side by side |

Every panel carries a caption about what the user can now do, and an element that changed is outlined with a short arrow note. The spec also carries a title, a takeaway, up to three callouts and metrics. A metric with `verified: true` is shown as measured, with the source it names; an unverified one is shown with the word "target". `{"no_image": true}` (or the text `NO_IMAGE`) means no page: a status update, a short answer, a test run.

Code validates the JSON strictly (unknown fields dropped, strings capped and stripped of emoji and long dashes, counts capped), then a quality gate checks every visual on its own: a before/after type needs two panels, each with at least three real interface elements and a caption; a timeline needs at least two segments per panel; a sequence needs two actors and two messages; an architecture needs three components and labeled data paths; a journey needs three steps with something drawn in each; a bare "Fixed", "Implemented", "Completed" or "Merged" label is rejected, as is a box that says "Diagram". The whole picture must also reach 0.55 visual density, so a page of sentences, or a mostly empty one, is rejected. On a miss the model is asked once more with the gate's feedback; visuals that pass ship, and a second miss counts as no image. Fixed HTML and SVG templates draw the pages (the model never writes markup), every value is escaped and the SVG goes through the allowlist sanitizer. The pages are light, use a local font stack, read Orca theme tokens with fallbacks, never redefine one, stack the panels below 760 px and sit side by side above it. Only the player collapses on iOS; the explain pages do not.

Director pass (prompt v6): before the visual the model writes five director lines as a `director` object on every visual: `intent`, `key_frame`, `first_look`, `two_second_test` and `motion` (the format from the `visual-studio` skill). The gate rejects a visual whose `director` is missing or has an empty line, and the model is asked once more with that feedback like any other gate miss. The lines are logged by the worker (`director 1 intent: ...`) and saved in the brief folder next to the page as `explain.director.txt` (`explain2.director.txt`, `explain3.director.txt`); they are never drawn on the page and never served.

Explainer style (prompt v6): pages follow the reference images in `examples/references/`. Types `log_compare`, `state_key`, `range_chart` and layered `architecture` draw an eyebrow, a headline that states the conclusion, a subhead, the evidence in one close-up and an optional footer; they skip the density gate and use their own: an eyebrow with a slash, a headline of nine words at most, two cards for a log or state, at least two numeric rows for a range (no numbers, no axis), the word ILLUSTRATIVE in the eyebrow when `illustrative` is true, and for an architecture three real-named layers with an icon on each. The rules are shared with the `explainer-visuals` skill.


`--explain-png` also writes one PNG per explain page (`earshot-<id>-explain.png`, `-explain2.png`, `-explain3.png`), 1080 px wide at 2x, cropped to the content (height follows the page, padded 40 px), through Playwright, which must be installed with a Chromium. `--no-explain` or `--no-sketch` skips the stage, and `image.type: none` disables it in config. 

### `--visual`: a picture on request

`earshot run --format auto --visual` (inside Orca) prints the Explain line at once, between the player line and the Listen links, and writes a placeholder page ("Drawing the picture.") first, so Orca finds a file the moment it renders the reply. The detached worker writes the real page over it. If the model answers NO_IMAGE, the gate rejects the visual twice or the LLM call fails, the worker writes a deterministic "what changed" card instead: an eyebrow, a headline from the reply's first heading or sentence (nine words at most), and up to six rows taken from the reply's headings and bullets (sentences when it has none), in the same house style. The model may draw one to three visuals and the count is unknown when the line prints, so there is always exactly one Explain line, and its page stacks every visual the model made, in order (a line per visual would leave empty cards whenever it drew fewer). The fallback card needs no LLM, so it cannot fail, and it is never empty: a reply with no usable text gets one plain row. The same card is saved as `explain.html` in the brief folder, so the card page links it. The worker also writes it if it dies before the explain stage ends, so the placeholder never stays. `--visual` runs the explain stage whatever the reply length (the normal 500 character minimum does not apply) and is ignored with `--no-explain`, `--no-sketch` or `image.type: none`. Without `--visual`, behavior is unchanged: no Explain line is printed. Pass it only for multi-step changes, UI changes, perf results and architecture recommendations, never for status or short replies (the earshot skill says the same).

### Scripts

Renders and scoring run on pro; every command below is `# macbook-only` (Playwright, and `claude -p` signed in on pro).

```
pnpm tsx scripts/explain-demo.ts --shots              # macbook-only: live model over test/fixtures/explain/*.json, 390 px only
pnpm tsx scripts/explain-demo.ts --shots --final      # macbook-only: 390 and 1280 px, once, at the end
pnpm tsx scripts/explain-preview.ts <spec.json> [out.html] [--shots] [--final]   # macbook-only: a saved answer, no LLM
pnpm tsx scripts/explain-score.ts <dir> --min 8       # macbook-only: draft score
pnpm tsx scripts/explain-score.ts <dir> --final --width 390 --min 8   # macbook-only: the Opus score that counts
```

`explain-score.ts` scores images in parallel (`--jobs`, default 4). The two-second test and every draft round run on Sonnet (`--twosec-model`, `--draft-model`, both `sonnet`); Opus scores only with `--final` (`--final-model`, default `opus`), and `--model` overrides the rubric model in either mode. `--width 390` scores only the shots rendered at 390 px. It prints the wall time and the models on stderr (`--json` for machine output). Measured on the same seven 390 px images: 127 s with Opus one image at a time before, 28 s with Sonnet four at a time after; the Opus `--final` pass over the same set takes about 37 s.

### Automatic

`visuals.auto` (default true) prints the Explain line by itself when `src/situation.ts` finds a situation other than none and the reply is 600 characters or longer. The classifier is a deterministic score over structure (headings, bullets, code) and vocabulary, with no LLM call; `none` covers status updates, test and lint results, short answers and drafts, and `post` routes to post media with no explain image. The situation goes to the model as a hint (plan: flow, architecture: layers, logic: flow with before and after lanes, bug: flow with the failing step red, perf: range chart, UI: before and after, schema: before and after tables, options: ranked, hosts: grid). `--no-visual` forces it off for one reply, `--visual` forces it on. A UI change that names a page that answers HEAD within 2 s gets a real screenshot with one outline instead of a drawing.

### Does Orca swap the page when the file changes? No

Read from Orca's source (`shared/native-chat/native-chat-visual-shell.js`, the renderer's visual hook and the `agentSession.readVisual` contract): the host reads the file once when the visual mounts and keeps it in a cache keyed by session and file name. It re-reads only when the visual remounts (reopening the chat) or when that file is open in an Orca file tab and changes. A file that does not exist yet is retried at 1.5, 4 and 10 s (15.5 s in all), then the visual shows "Visualization unavailable". The page is rendered from an iframe `srcdoc` with `connect-src 'none'`, so it cannot fetch its own file, and `location.reload()` re-renders the same text (`test/orca-swap.test.ts` runs both with Orca's own shell). So a stand-in page that is later overwritten stays on screen until the chat is reopened. earshot therefore writes nothing until a page is real, and at 12 s writes a final page (a note for the player, the deterministic card for Explain) so something shows inside the retry window. A real page that arrives later replaces it on the next mount.

## Why Web Audio

Orca's content security policy blocks `data:` URLs for media, so `<audio src="data:audio/mpeg;base64,...">` fails with `NotSupportedError`. The page cannot fetch the audio either, because it has no network access. It embeds the MP3 as base64 text, decodes it with `AudioContext.decodeAudioData`, and plays it through an `AudioBufferSourceNode`. Pausing or switching track stops the source; playing starts a new one at the saved offset of that track, so the position is `offset + (context time - start time)`.

## Use

```bash
echo "<agent reply>" | earshot run --format auto
```

`--format auto` never blocks. Inside Orca (scratch dir set and writable) it writes stand-in pages, prints the `::orca-visual` lines and the links in about half a second, and a detached worker makes the audio; when the audio is ready the worker rewrites the same player file (write to a temp name, then rename) with the real player. Outside Orca it prints the links at once and finishes the memo in the background. The Explain line is never printed in this mode: the explain stage needs 5 to 10 s and may answer no image, and a line that can end up an empty card is worse than none. For a reply of 500 characters or more the worker still runs the stage and saves the pages (`explain.html`, `explain2.html`, `explain3.html`) in the brief; the card page (`/b/<id>`, the phone link page) shows a "What changed" section with a link to each, and shows nothing when the model drew no image. `--format orca` blocks and prints a line, titled with the page's headline, for each page that exists.

`--format orca` is the blocking form: it waits for the finished audio, writes the real pages and falls back to the markdown line when a page cannot be made, so it cannot be combined with `--detach`. Use it if your Orca does not re-read a page file that changes after the reply was rendered. `--orca-dir <path>` overrides the scratch directory.

The stand-in player says "Preparing audio. The Listen link works now." and reloads itself every 1.5 s for up to two minutes. If the worker fails it is replaced by a final note without the reload. Whether Orca re-reads a file that changes after the reply was rendered is not verified; the Listen and Original links always work and stream while the audio is made, so playback is never blocked on it.

The Stop hook treats either line as already narrated.

## Page size

The player page embeds both tracks, re-encoded with ffmpeg to mono, 22.05 kHz MP3. earshot predicts the size from the track durations, picks 24k, 20k or 16k, and encodes once. Budget is 480 KB (Orca's limit is 512 KB). If 16k still does not fit, the original track is dropped and the page says so. The files are `earshot-<brief id>-player.html`, `-explain.html`, `-explain2.html` and `-explain3.html`; each page needs a new file name.

## Speed

Measured through the skill's command (`earshot run --format auto`, short style, Claude script, Kokoro on a Mac mini with a second instance for the original), 0.7 KB reply, 2026-11-18:

| | Before (blocking) | After |
|---|---|---|
| Command returns, in Orca | 6.8 s (about 19 s on longer replies) | 0.4 s |
| Command returns, outside Orca | 0.35 s | 0.38 s |
| First Original audio (link) | 0.4 s | 0.4 to 0.8 s |
| First Listen audio (link) | 2.7 s | 2.7 to 3.5 s |
| Real player page written | at return | 6.5 to 7.2 s |

Stages of that run, in parallel: script (Claude, streamed) 3.2 to 3.9 s, edited speech finishing 2.7 s after the script starts, original speech 5.0 s (3 chunks, 37 s of audio), explain call 5.3 s, page encode 0.27 s. The critical path to the real player is the slower of original speech and the explain call, plus the encode; the links do not wait for either.

The first chunk of a track goes to the TTS server alone, so its first audio is not queued behind the other chunks on a Kokoro that serves one request at a time; the rest are sent at once and written in order. `tts.original_base_url` can point the original track at a second Kokoro instance so the tracks stop competing:

```bash
# on the TTS host: a second instance on another port
uvicorn api.src.main:app --host <addr> --port 8883
```

```yaml
tts:
  original_base_url: http://<addr>:8883/v1
```

## Limits

- Orca does not re-render a file that is rewritten after it first rendered (see above); each page needs a new file name and is written once it is real.
- The page uses Orca theme tokens with fallbacks; it never redefines a token and avoids `100vh`.
