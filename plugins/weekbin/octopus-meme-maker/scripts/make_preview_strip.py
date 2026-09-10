#!/usr/bin/env python3
"""Extract 5 key frames from a 6s 24fps video and stitch them into a preview strip.

Usage:
    python3 make_preview_strip.py <video.mp4> <output.png> [--labels "t=0s 强撑,..."]

The 5 frame indices are tuned for a 141-frame 5.87s source video. Pass --labels
as 5 comma-separated strings; they render under each frame.

Exit 0: <output> exists (5 frames wide, white background, label band at the bottom).
Exit 1: ffmpeg fails to extract frames, or the count of extracted frames is not 5.
"""
import argparse
import os
import shutil
import subprocess
import sys
import tempfile

from PIL import Image, ImageDraw, ImageFont

DEFAULT_LABELS = ["t=0.0s", "t=1.8s", "t=3.0s", "t=4.2s", "t=5.5s"]
FRAME_INDICES = [0, 43, 72, 100, 140]  # 5 key moments @ 24fps over 5.87s
FRAME_WIDTH = 480
LABEL_BAND_H = 50
LABEL_BG = "white"
LABEL_FG = "black"
DEFAULT_LABEL_FONT_SIZE = 24

FONT_CANDIDATES = [
    # macOS
    "/System/Library/Fonts/STHeiti Medium.ttc",
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    # Linux
    "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    # Windows
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\msyhbd.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
]


def pick_chinese_font():
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            return path
    return None


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("video", help="Input video.mp4 (1080x1080, 24fps, ~5.87s)")
    p.add_argument("output", help="Output preview.png path")
    p.add_argument("--labels", default=",".join(DEFAULT_LABELS),
                   help="Comma-separated 5 labels, e.g. 't=0s 强撑,t=1.8s 眼皮打架,...'")
    p.add_argument("--font", default=None, help="Path to a CJK .ttc / .ttf file")
    p.add_argument("--workdir", default=None, help="Temp dir for extracted frames (auto-generated if omitted)")
    args = p.parse_args()

    font_path = args.font or pick_chinese_font()
    if not font_path:
        print(
            "ERROR: no CJK font found. Install one of: wqy-microhei / noto-cjk (Linux), "
            "STHeiti (macOS), msyh (Windows); or pass --font <path>.",
            file=sys.stderr,
        )
        sys.exit(1)

    labels = args.labels.split(",")
    if len(labels) != 5:
        print(f"ERROR: --labels must have exactly 5 comma-separated values, got {len(labels)}.",
              file=sys.stderr)
        sys.exit(1)

    workdir = args.workdir or tempfile.mkdtemp(prefix="octopus_preview_")
    if os.path.exists(workdir):
        shutil.rmtree(workdir)
    os.makedirs(workdir, exist_ok=True)

    select_expr = "+".join(f"eq(n,{i})" for i in FRAME_INDICES)
    cmd = [
        "ffmpeg", "-y",
        "-i", args.video,
        "-vf", f"select='{select_expr}',scale={FRAME_WIDTH}:-1",
        "-vsync", "vfr",
        f"{workdir}/f_%d.png",
    ]
    print("Extracting 5 key frames...")
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"ERROR: ffmpeg failed:\n{result.stderr}", file=sys.stderr)
        sys.exit(1)

    frame_files = sorted(f for f in os.listdir(workdir) if f.endswith(".png"))
    if len(frame_files) != 5:
        print(f"ERROR: expected 5 frames, got {len(frame_files)}: {frame_files}", file=sys.stderr)
        sys.exit(1)

    imgs = [Image.open(os.path.join(workdir, f)) for f in frame_files]
    w, h = imgs[0].size
    strip = Image.new("RGB", (w * 5, h + LABEL_BAND_H), LABEL_BG)
    font = ImageFont.truetype(font_path, DEFAULT_LABEL_FONT_SIZE)
    draw = ImageDraw.Draw(strip)
    for i, im in enumerate(imgs):
        strip.paste(im, (i * w, 0))
        draw.text((i * w + 10, h + 10), labels[i], font=font, fill=LABEL_FG)
    strip.save(args.output, "PNG")
    print(f"OK: {args.output} ({w*5}x{h+LABEL_BAND_H}, 5 frames, font={font_path})")


if __name__ == "__main__":
    main()
