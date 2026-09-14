---
name: octopus-meme-maker
description: Use this skill when the user asks for a new pink-octopus office-worker GIF meme, a Smooth Squishmallow-style worker octopus sticker, a 4-character Chinese caption on a 720x720 looping GIF, or wants to add a scene to an existing meme library. Drives a 4-stage pipeline (base pose via image_synthesize -> 6s 24fps video via gen_videos -> transparent Chinese text overlay via Pillow -> 720x720 + 480x480 GIF via ffmpeg) and enforces a strict character-anatomy ban-list. Read this skill before starting any new scene.
license: Apache-2.0
metadata:
  author: weekbin
  version: 0.2.0
---

# Octopus Meme Maker

Generate one 720×720 looping GIF + one 480×480 mini-GIF per scene. Read this entire file before producing any output.

## 1. Pre-flight

`${PLUGIN_ROOT}` is the environment variable MiniMax Code sets to this Plugin's root directory. Every command in this file is anchored to it, so the commands work from any working directory.

Read `reference.md` (anatomy + prompt template) and `issues.md` (ban-list + failure modes) before stage 1.

### 1.1 Copy the reference frames

Shell blocks in this file are POSIX shell: macOS, Linux, or Git Bash on Windows.

The character / style reference is the **3 `examples/*.png` files** (3D
Squishmallow-style bases from prior scenes). Do **NOT** copy `sample_*.png`
— those are 6 frames of a different (2D flat-shaded) "在改了" GIF and will
pull the model toward the wrong style. See `reference.md` for the full
rationale.

```shell
mkdir -p <scene-dir>/iterations <scene-dir>/frames-check
cp "${PLUGIN_ROOT}"/examples/*.png <host-image-synthesize-input-dir>/
```

Exit condition: `ls "${PLUGIN_ROOT}"/examples/*.png` lists 3 files; `<scene-dir>/iterations/` and `<scene-dir>/frames-check/` exist.

## 2. Stage 1 — base pose (image_synthesize, 2K 1:1)

Generate a 2048×2048 PNG that the user has personally picked from a contact
sheet. **The hard gate is "抽 6 张拼图给用户挑" — never ask the user to
confirm a single image, and never pick on the user's behalf.** The first
non-contact-sheet round is treated as an unauthorised shortcut.

### 2.1 Generate 6 candidates in one batch

Submit one `image_synthesize` call with **6 parallel requests** in the
`requests` array (NOT 6 separate calls). All 6 share the same prompt and the
same 6 reference frames; the model produces 6 distinct candidates in one
round-trip.

Save successful outputs to `<scene-dir>/iterations/vN-{1..6}-base.jpg`,
where `N` is the round number starting at 1. Reject any candidate that
matches an `issues.md` ban-list entry — note the bad index, but keep the
rest of the batch.

If the round's batch has fewer than 4 non-banned candidates, re-roll only
the bad indices with a refined prompt (see § 7.1) and append the new ones
to the same round. Do not move on to round N+1 just because one image was
weak.

### 2.2 Compose the contact sheet

```shell
python3 "${PLUGIN_ROOT}/scripts/make_contact_sheet.py" \
  <scene-dir>/iterations/vN-1-base.jpg \
  <scene-dir>/iterations/vN-2-base.jpg \
  <scene-dir>/iterations/vN-3-base.jpg \
  <scene-dir>/iterations/vN-4-base.jpg \
  <scene-dir>/iterations/vN-5-base.jpg \
  <scene-dir>/iterations/vN-6-base.jpg \
  <scene-dir>/iterations/vN-contact-sheet.png
```

The script lays the 6 candidates in a 3-cols × 2-rows grid with a bold
number badge (1-6) on each cell so the user can answer "3" / "选 2" /
"第 5 张" without ambiguity. Default cell size is 480×480; total sheet is
~1500×1000 px.

Exit condition: `<scene-dir>/iterations/vN-contact-sheet.png` exists and
shows 6 distinct numbered cells.

### 2.3 Hand the contact sheet to the user

Deliver the contact sheet to the user as an inline image — use a `<media />`
tag so all 6 candidates are visible at once without leaving the chat. Then
**STOP and wait** for the user to pick. This is a hard gate that nothing
in Stage 1 or Stage 2 may bypass.

| User signal | Action |
|---|---|
| **A number** ("3", "选 2", "第 5 张") | Copy `iterations/vN-{N}-base.jpg` → `<scene-dir>/base.png` and proceed to Stage 2. |
| **All-bad signal** ("全部不行" / "再抽" / "继续抽卡" / "都不行") | Start a new round: bump N → N+1, refine the prompt per § 7.1, re-run § 2.1 and § 2.2. Repeat until the user picks. |
| **Specific feedback** ("3 号嘴有问题" / "想要更慵懒" / "表情再焦一点") | Treat as both a pick AND a refinement: lock the chosen one as `base.png`, note the feedback, then start a follow-up round N+1 with the feedback applied before committing to Stage 2. |

**The contact-sheet loop is mandatory and runs until the user picks.**

- **STOP after every contact-sheet delivery.** Do not start Stage 2, do not
  start a follow-up round, do not move on in any way — the loop must wait
  for the user's reply.
- **Loop indefinitely.** There is no upper bound on `N`; keep re-rolling
  with the user's feedback applied until they pick a number or signal
  abandon / relax.
- **Only the user ends the loop.** A single 'best of 1-2' round, picking
  on the user's behalf because a candidate 'looks great', or skipping the
  contact sheet to save time are all unauthorised shortcuts and forbidden.
  The user is the curator; the model's taste does not count.

Exit signal of § 2.3: the user has typed a number (e.g. "3" / "选 2") OR
has explicitly signalled that they want to abandon / relax the prompt. No
other input counts.

### 2.4 Prompt skeleton

```text
A cute pink octopus mascot plush toy character in <SCENE_POSE>.
[Full anatomy block — see reference.md § Anatomy]
[Scene-specific action / expression / prop]
Style: Squishmallow / Pop Mart 3D render, NOT furry, NOT stitched plush.
```

Exit condition: `<scene-dir>/base.png` is a 2048×2048 PNG copied from a
contact-sheet candidate the user has explicitly chosen. The contact-sheet
loop has no upper bound on rounds — keep re-rolling until the user picks.
Only an explicit user signal ("选了 / OK / 继续 / 放弃 / 放松 prompt") ends
the loop; nothing else counts.

## 3. Stage 2 — 6s video (gen_videos, 1080p 24fps)

Call `gen_videos` with `<scene-dir>/base.png` as `first_frame_image` and a 6-second prompt that restates the stage 1 prompt's style block. Copy the output to `<scene-dir>/video.mp4` inside the host's workspace (host tool requires a workspace-relative path; absolute paths fail).

### 3.1 gen_videos parameters

```text
video_prompt = "<stage 1 style block> + <6-second motion description>"
duration     = 6s
fps          = 24
size         = 1080x1080
```

Exit condition: `<scene-dir>/video.mp4` exists and `ffprobe -show_streams video.mp4` reports `width=1080 height=1080` at `r_frame_rate=24/1` with `nb_frames=141`.

## 4. Stage 3 — preview strip (sanity check, not the deliverable)

### 4.1 Generate the strip

```shell
python3 "${PLUGIN_ROOT}/scripts/make_preview_strip.py" <scene-dir>/video.mp4 \
  <scene-dir>/frames-check/preview.png \
  --labels "t=0.0s,<pose>,t=1.8s,<pose>,t=3.0s,<pose>,t=4.2s,<pose>,t=5.8s,<pose>"
```

Exit condition: `frames-check/preview.png` exists, 5 frames wide, and the user confirms the animation reads as expected.

## 5. Stage 4 — GIF assembly (the deliverable)

### 5.1 Compose both GIFs

```shell
python3 "${PLUGIN_ROOT}/scripts/make_gif.py" <scene-dir> "<caption>"
```

The script writes both `<scene-dir>/final.gif` (720×720) and `<scene-dir>/final-mini.gif` (480×480). Both scripts resolve their own location, so the command works from any working directory.

File size tracks scene complexity, not a fixed budget. Across the 23 reference scenes the main GIF lands between 2.8 MB and 15.8 MB (median 7.2 MB), and the mini GIF between 0.8 MB and 5.3 MB (median 1.6 MB). Report both sizes to the user as information; treat the ranges as a sanity band rather than a cap.

Exit condition: both files exist, `ffprobe -select_streams v:0 -show_entries stream=width,height,nb_frames` reports `720,720,141` for `final.gif` and `480,480,141` for `final-mini.gif`, and the caption reads correctly. If `final.gif` exceeds 16 MB, apply the reduction levers in § Failure Recovery.

## 6. Examples

### 6.1 摆烂躺平 (lying flat)

- Caption: "摆烂躺平"
- Pose: sprawled on the desk, one eye half-closed, one tentacle holding a coffee cup
- Expected: `base.png` 2048×2048; `final.gif` ≈ 6 MB; `final-mini.gif` ≈ 1.6 MB.

### 6.2 假装很忙 (pretending to be busy, no caption)

- Caption: (none)
- Pose: phone in one tentacle, eyes down, neutral mouth
- Stage 4 command: `python3 "${PLUGIN_ROOT}/scripts/make_gif.py" <scene-dir> ""` — the overlay is empty, only the video frames survive.

### 6.3 期待 m3pro (waiting for m3pro)

- Caption: "期待 m3pro"
- Pose: tentacles cupping the cheeks, eyes wide
- Expected: `base.png` 2048×2048; `final.gif` ≈ 4 MB; `final-mini.gif` ≈ 1.0 MB.

## 7. Failure Recovery

### 7.1 Stage 1 contact-sheet round needs a re-roll

If the user issues an all-bad signal ("全部不行" / "再抽" / "继续抽卡") or
specific feedback ("嘴不行" / "表情不够慵懒"):

1. Re-read `issues.md` § Ban-list and § Feedback signals. Map the feedback
   to one or more concrete prompt deltas — e.g. "mouth too dark" → drop
   any word that could be misread as a lip color; "想要更慵懒" → push the
   eyelid-arc coverage from "top 30%" to "top 50%"; "再焦一点" → raise
   grill-mark count from 3-4 to 5-6 stripes.
2. Increment N → N+1. Generate a new batch of 6 candidates with the
   refined prompt. **Do not** delete the previous round's files; they are
   evidence and let the user compare.
3. Compose a fresh contact sheet and re-deliver to the user.

If `N` reaches 4 without a user pick, escalate: surface the best candidate
from rounds 1-3 in a final contact sheet and ask the user to either pick
the best of the rest, relax the prompt scope, or abandon the scene.

### 7.2 Stage 2 gen_videos returns "input file path outside workspace"

The host tool only accepts paths inside the host's workspace. Copy `<scene-dir>/base.png` to `<host-workspace>/<scene-dir>/base.png` first, then pass the workspace-relative path. Do not pass an absolute path.

### 7.3 Stage 4 final.gif exceeds 16 MB

The scene carries heavy motion blur, a wide gradient, or many distinct colours. Lower `PALETTE_DITHER` from `bayer:bayer_scale=5` to `bayer:bayer_scale=4` in `"${PLUGIN_ROOT}/scripts/make_gif.py"`, or reduce `FPS` from 24 to 20. Re-run stage 4; do not regenerate base or video.

## 8. Quick Reference

| Stage | Tool | Output | Exit criterion |
|---|---|---|---|
| 1. base pose (loop) | `image_synthesize` + `make_contact_sheet.py` | `<scene-dir>/base.png` | 2048×2048 PNG, user-picked from a 6-image contact sheet; loop N → N+1 indefinitely until user picks |
| 2. video | `gen_videos` | `<scene-dir>/video.mp4` | 1080×1080, 141 frames @ 24fps |
| 3. preview | `make_preview_strip.py` | `frames-check/preview.png` | 5 frames wide |
| 4. GIF | `make_gif.py` | `final.gif` + `final-mini.gif` | 720,720,141 and 480,480,141 |

For character anatomy, prompt template, and reference frames, see `reference.md`. For known failure modes and feedback-signal translations, see `issues.md`.

## 9. Hard Rules

- **Stage 1 IS a contact-sheet loop. Generate 6 candidates, compose a contact sheet, deliver to the user via `<media />`, then STOP and wait for the user to pick. Loop N → N+1, N+2, ... indefinitely until the user picks a number or explicitly signals abandon / relax. Stage 2 must not start until the user has picked.** This is the most important rule in this file. A single 'best of 1-2' round, picking on the user's behalf, or skipping the contact sheet because a candidate 'looks great' are all forbidden. The user is the curator, not the model.
- **Never pick on the user's behalf.** Stage 2 must not start until the user has explicitly chosen a number or issued an abandon / relax signal.
- **Never crop the video to fit text.** The text is composited as a transparent overlay, not baked into the video.
- **Never hardcode scene paths.** Use `<scene-dir>` as a parameter; the Plugin must work for any user-provided scene name.
- **Never delete old iteration files.** They are evidence and let the user compare across rounds.
- After stage 4, append a row to the maintainer's `README.md` scene table with `path`, `caption`, and `size` for both GIFs.
