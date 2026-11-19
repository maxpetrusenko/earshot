# Scores

Opus (`claude -p --model opus`, `explain-score.ts --final`) overall score out of 10 per image at 390 px, after the two-second test. FAIL means the two-second test failed and the image scored 0 without the rubric. Target: every image 8 or higher.

| Image | Round 1 | Round 2 | Round 3 (final) |
| --- | --- | --- | --- |
| gate-threshold (log) | 7 | 7 | 7 |
| orca-timeline (state key) | 6 | 7 | 7 |
| perf-illustrative (range, player) | 8 | FAIL (60 printed twice, wave ran to 60 s) | 7 |
| architecture-rec (layers) | 8 | 7 | 8 |
| orca-player (existing fixture) | 6 | 7 | 8 |
| bugfix (existing fixture, attempts) | FAIL (axis labels, 40 printed twice) | FAIL (axis labels ran together) | 7 |
| perf (existing fixture, 1.8 s to 240 ms) | 4 | 7 | 6 |
| perf, second visual (201 queries to 1) | 4 | not produced | 6 |
| status-tests (343 tests) | NO_IMAGE | NO_IMAGE | NO_IMAGE |

Two-second test in the final round: every image passed (8 of 8).

Result: not approved. Two of eight images reach 8 (architecture-rec, orca-player). The rest sit at 6 or 7.

## What moved the scores

- Round 1 to 2: clipped units and labels over the axis (the "attemp" and "querie" cuts) fixed; value labels moved under the track; dashes and waveform filled the whole track.
- Round 2 to 3: the gap in the BEFORE log line became an invisible spacer (the dashed box read as a broken glyph); an open value ("more than 40") draws an open bracket instead of a dot at the axis end; the waveform fades out so it does not read as a duration; axis tick labels are not counted as repeated numbers by the two-second test; the unit sits on its own line under a long-unit axis.

## What still holds the scores at 6 and 7

- gate-threshold: the AFTER line reads 0.549 needs 0.550 correctly; the judge wants the AFTER caption closer to its line.
- orca-timeline: the judge wants the bug (both states grey) shown as well as the fix. Max's reference shows only the fixed key, so this was left as the reference does it.
- perf and perf second visual: the model splits the reply into two images and each omits the other's main number (1.8 s to 240 ms, 201 queries to 1). The prompt says one concept per image, so each image is right for its concept; the judge scores the omission.
- perf-illustrative: the green waveform after the bracket still reads as playback data to the judge, although it fades; the eyebrow PROJECT is the model's choice.
- bugfix: the open bracket fades to the axis end; the judge reads the fade as an invented end.

Rounds 1 and 2 were scored on renders from earlier template versions; round 3 is the final template and prompt.

## Automatic visuals round (2026-11-18)

Nine situation fixtures at 390 px, Sonnet drafts (two rounds), then one Opus final. Post routes to post media and has no explain image. Draft 1 mean 6.5 (the plan image truncated step names, the host grid dropped numbers); fixes: whole-word step names, host lines keep the reply's numbers, one visual per reply, a last odd grid cell spans both columns.

| Situation | Type | Draft 1 | Draft 2 | Opus final |
|---|---|---|---|---|
| architecture | layers | 7 | 7 | 8 |
| perf | range_chart | 7 | scorer error | 8 |
| bug | flow | 7 | 4 | 5 |
| hosts | grid | 6 | 7 | 7 |
| logic | flow, two lanes | 8 | 8 | 7 |
| options | ranked | 8 | 7 | 7 |
| plan | flow | 4 | 8 | 7 |
| schema | ui_before_after | 6 | 6 | scorer error |
| ui | ui_before_after | 7 | scorer error | 4 |

## Follow-up round (2026-11-18, after the CI fix)

Nine situation fixtures at 390 px. Two Sonnet draft rounds, then Opus final (`explain-score.ts --final`, parallel). Changes in this round: the UI mockup shows only elements the reply names (gate: at most one invented element per panel, none outlined, at least three named; otherwise a flow or no image), the mockup page now prints its eyebrow and footer, flow notes and footers are sent back to the model when too long instead of cut mid-sentence, at most three outlined elements, prompt `visual-explainer-format.v8`.

| Situation | Type | Draft 1 | Draft 2 | Opus final |
|---|---|---|---|---|
| architecture | layers | 7 | 7 | 7 |
| perf | range_chart | 7 | 7 | 8 |
| bug | flow | 7 | 7 | 7 |
| hosts | grid | 8 | 7 | 7 |
| logic | flow, two lanes | 5 | 8 | 6 |
| options | ranked | 7 | 7 | 7 |
| plan | flow | 7 | no image (note 66 chars, gate) | no image (same) |
| schema | ui_before_after | 5 | 6 | 6 |
| ui | ui_before_after, then flow | 6 | no image (too sparse) | 6 (flow) |

Not approved: one of eight scored images reaches 8 (perf). Remaining complaints: both columns of a two-lane flow repeat the unchanged steps (tall image), the schema mockup is tall with many outlined columns, the bug image shows the fix only in the footer. Opus scored the bug image 5 before the footer fix and 7 now. The earlier Opus schema error did not recur; the scorer now retries and names the cause.
