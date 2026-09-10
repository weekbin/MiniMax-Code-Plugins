#!/usr/bin/env python3
"""Compose the final 720x720 + 480x480 GIFs from a video and a Chinese caption.

Usage:
    python3 make_gif.py <scene-dir> "<caption>" [--output-name final.gif]

The script runs 4 ffmpeg steps and one Pillow text-overlay step:
    1. Make a transparent 1080x220 PNG with the caption (delegated to make_text_overlay.py).
    2. Burn the overlay onto the video at y=520, scale to 720x720, dump 141 frames as PNGs.
    3. palettegen on the 141 PNGs to a 720x720 palette.
    4. paletteuse -> 720x720 final.gif.
    5. Downscale the 141 PNGs to 480x480 + paletteuse -> 480x480 final-mini.gif.

Exit 0: <scene-dir>/final.gif and <scene-dir>/final-mini.gif both exist.
Exit 1: video.mp4 missing, ffmpeg missing, or any step fails.
"""
import argparse
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
TEXT_OVERLAY_SCRIPT = os.path.join(HERE, "make_text_overlay.py")

FRAMES = 141            # 5.87s @ 24fps
DURATION = "5.87"        # seconds kept from the source video
OUTPUT_W = 720           # main GIF width
OUTPUT_H = 720           # main GIF height
MINI_W = 480             # mini GIF width
MINI_H = 480             # mini GIF height
OVERLAY_Y = 520          # vertical offset of the text overlay (top-left of the 720x176 strip)
OVERLAY_W = 720
OVERLAY_H = 176
FPS = 24
PALETTE_DITHER = "bayer:bayer_scale=5"


def run(cmd, label):
    print(f"[{label}] {' '.join(cmd)}")
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"ERROR during {label}:\n{result.stderr}", file=sys.stderr)
        sys.exit(1)
    return result


def require_ffmpeg():
    if shutil.which("ffmpeg") is None:
        print("ERROR: ffmpeg not found on PATH. Install ffmpeg 4.4+ first.", file=sys.stderr)
        sys.exit(1)


def require_text_overlay_script():
    if not os.path.exists(TEXT_OVERLAY_SCRIPT):
        print(f"ERROR: {TEXT_OVERLAY_SCRIPT} not found. Run from the Plugin's scripts/ directory.", file=sys.stderr)
        sys.exit(1)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("scene_dir", help="Scene directory containing video.mp4")
    p.add_argument("caption", help="Chinese caption rendered onto the GIF")
    p.add_argument("--output-name", default="final.gif", help="Main GIF name (default: final.gif)")
    p.add_argument("--mini-name", default="final-mini.gif", help="Mini GIF name (default: final-mini.gif)")
    args = p.parse_args()

    scene_dir = os.path.abspath(args.scene_dir)
    video = os.path.join(scene_dir, "video.mp4")
    if not os.path.exists(video):
        print(f"ERROR: {video} not found. Run stage 2 (gen_videos) first.", file=sys.stderr)
        sys.exit(1)

    require_ffmpeg()
    require_text_overlay_script()

    workdir = tempfile.mkdtemp(prefix="octopus_gif_")
    frames_dir = os.path.join(workdir, "frames")
    os.makedirs(frames_dir, exist_ok=True)
    overlay = os.path.join(workdir, "overlay.png")
    palette = os.path.join(workdir, "palette.png")
    mini_frames_dir = os.path.join(workdir, "mini_frames")
    os.makedirs(mini_frames_dir, exist_ok=True)
    mini_palette = os.path.join(workdir, "mini_palette.png")

    output = os.path.join(scene_dir, args.output_name)
    mini = os.path.join(scene_dir, args.mini_name)

    try:
        # 1. text overlay
        run([sys.executable, TEXT_OVERLAY_SCRIPT, args.caption, overlay], "1/5 overlay")

        # 2. burn overlay -> 141 PNG frames @ 720x720
        run([
            "ffmpeg", "-y",
            "-i", video,
            "-loop", "1", "-i", overlay,
            "-filter_complex",
            f"[0:v]scale={OUTPUT_W}:{OUTPUT_H}[vid];"
            f"[1:v]scale={OVERLAY_W}:{OVERLAY_H}[ovl];"
            f"[vid][ovl]overlay=0:{OVERLAY_Y}[out]",
            "-map", "[out]", "-t", DURATION, "-vsync", "0",
            f"{frames_dir}/f_%04d.png",
        ], "2/5 burn-overlay -> frames")

        # 3. palettegen @ 720x720
        run([
            "ffmpeg", "-y",
            "-framerate", str(FPS),
            "-i", f"{frames_dir}/f_%04d.png",
            "-vf", "palettegen=stats_mode=diff",
            palette,
        ], "3/5 palettegen")

        # 4. paletteuse -> final.gif
        run([
            "ffmpeg", "-y",
            "-framerate", str(FPS),
            "-i", f"{frames_dir}/f_%04d.png",
            "-i", palette,
            "-lavfi", f"paletteuse=dither={PALETTE_DITHER}",
            output,
        ], "4/5 paletteuse -> final.gif")

        # 5. mini: downscale frames + palette
        run([
            "ffmpeg", "-y",
            "-framerate", str(FPS),
            "-i", f"{frames_dir}/f_%04d.png",
            "-vf", f"scale={MINI_W}:{MINI_H}",
            f"{mini_frames_dir}/f_%04d.png",
        ], "5a/5 downscale -> mini frames")

        run([
            "ffmpeg", "-y",
            "-framerate", str(FPS),
            "-i", f"{mini_frames_dir}/f_%04d.png",
            "-vf", "palettegen=stats_mode=diff",
            mini_palette,
        ], "5b/5 mini palettegen")

        run([
            "ffmpeg", "-y",
            "-framerate", str(FPS),
            "-i", f"{mini_frames_dir}/f_%04d.png",
            "-i", mini_palette,
            "-lavfi", f"paletteuse=dither={PALETTE_DITHER}",
            mini,
        ], "5c/5 mini paletteuse -> final-mini.gif")

        main_size = os.path.getsize(output) / (1024 * 1024)
        mini_size = os.path.getsize(mini) / (1024 * 1024)
        print()
        print(f"Done. Main: {output} ({main_size:.1f} MB)  Mini: {mini} ({mini_size:.1f} MB)")
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


if __name__ == "__main__":
    main()
