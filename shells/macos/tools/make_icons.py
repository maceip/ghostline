#!/usr/bin/env python3
"""Build the macOS app icon set for the Zode shell.

The canonical artwork is `icons/zode.png` in the repository root. This script
turns it into the PNGs the `AppIcon.appiconset` of
`Zode/Resources/Assets.xcassets` needs.

macOS icons are drawn on a canvas that is larger than the icon itself: the
artwork occupies ~80 % of the canvas (a 100 px margin on a 1024 px canvas)
and is masked with the system's rounded rectangle ("squircle"). This script
reproduces that: the artwork is scaled into the inner rectangle and masked
with a superellipse (|x/a|^n + |y/b|^n = 1, n = 5), which is the shape the
system uses for the corner curvature.

The script only needs the Python standard library. If Pillow is installed it
is used for the decoding/resampling (it is faster), otherwise the built-in
PNG codec is used.

Usage:
    python3 tools/make_icons.py [--source ../../icons/zode.png] [--check]
"""

from __future__ import annotations

import argparse
import json
import math
import os
import struct
import sys
import zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
SHELL_ROOT = HERE.parent
REPO_ROOT = SHELL_ROOT.parent.parent

DEFAULT_SOURCE = REPO_ROOT / "icons" / "zode.png"
DEFAULT_OUTPUT = SHELL_ROOT / "Zode" / "Resources" / "Assets.xcassets" / "AppIcon.appiconset"

# The macOS icon canvas: the artwork fills 824 of 1024 points, which leaves a
# 100 point (9.77 %) margin on every side.
ARTWORK_FRACTION = 824.0 / 1024.0

# The superellipse exponent of the macOS rounded rectangle.
SUPERELLIPSE_N = 5.0

# The icon sizes the app icon set needs: (points, scale) -> pixel size.
ICON_SPECS = [
    (16, 1),
    (16, 2),
    (32, 1),
    (32, 2),
    (128, 1),
    (128, 2),
    (256, 1),
    (256, 2),
    (512, 1),
    (512, 2),
]


# =============================================================================
# PNG codec (stdlib only)
# =============================================================================

def decode_png(path: Path) -> tuple[int, int, bytearray]:
    """Decodes an 8 bit PNG into an RGBA buffer.

    Supports the colour types the repository artwork uses: greyscale, RGB,
    palette, greyscale+alpha and RGBA (bit depth 8, no interlacing).
    """
    data = path.read_bytes()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError(f"{path} is not a PNG file")

    pos = 8
    width = height = 0
    color_type = 6
    bit_depth = 8
    interlace = 0
    idat = bytearray()
    palette = b""
    transparency = b""

    while pos < len(data):
        length = struct.unpack(">I", data[pos:pos + 4])[0]
        ctype = data[pos + 4:pos + 8].decode("latin-1")
        body = data[pos + 8:pos + 8 + length]
        pos += 12 + length
        if ctype == "IHDR":
            width, height, bit_depth, color_type, _comp, _filt, interlace = struct.unpack(">IIBBBBB", body)
        elif ctype == "PLTE":
            palette = body
        elif ctype == "tRNS":
            transparency = body
        elif ctype == "IDAT":
            idat += body
        elif ctype == "IEND":
            break

    if bit_depth != 8:
        raise ValueError(f"only 8 bit PNGs are supported (got {bit_depth})")
    if interlace:
        raise ValueError("interlaced PNGs are not supported")

    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}.get(color_type)
    if channels is None:
        raise ValueError(f"unsupported PNG colour type {color_type}")

    raw = zlib.decompress(bytes(idat))
    stride = width * channels
    out = bytearray(height * stride)
    prev = bytearray(stride)
    offset = 0

    for y in range(height):
        ftype = raw[offset]
        offset += 1
        line = bytearray(raw[offset:offset + stride])
        offset += stride
        if ftype == 1:
            for x in range(channels, stride):
                line[x] = (line[x] + line[x - channels]) & 0xFF
        elif ftype == 2:
            for x in range(stride):
                line[x] = (line[x] + prev[x]) & 0xFF
        elif ftype == 3:
            for x in range(stride):
                left = line[x - channels] if x >= channels else 0
                line[x] = (line[x] + ((left + prev[x]) >> 1)) & 0xFF
        elif ftype == 4:
            for x in range(stride):
                a = line[x - channels] if x >= channels else 0
                b = prev[x]
                c = prev[x - channels] if x >= channels else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pred = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[x] = (line[x] + pred) & 0xFF
        elif ftype != 0:
            raise ValueError(f"unknown PNG filter {ftype}")
        out[y * stride:(y + 1) * stride] = line
        prev = line

    rgba = bytearray(width * height * 4)
    for index in range(width * height):
        source = index * channels
        target = index * 4
        if color_type == 6:
            rgba[target:target + 4] = out[source:source + 4]
        elif color_type == 2:
            r, g, b = out[source], out[source + 1], out[source + 2]
            rgba[target:target + 4] = bytes((r, g, b, 255))
        elif color_type == 0:
            value = out[source]
            rgba[target:target + 4] = bytes((value, value, value, 255))
        elif color_type == 4:
            value = out[source]
            alpha = out[source + 1]
            rgba[target:target + 4] = bytes((value, value, value, alpha))
        else:  # palette
            index_in_palette = out[source]
            r, g, b = palette[index_in_palette * 3:index_in_palette * 3 + 3]
            alpha = 255
            if index_in_palette < len(transparency):
                alpha = transparency[index_in_palette]
            rgba[target:target + 4] = bytes((r, g, b, alpha))
    return width, height, rgba


def encode_png(path: Path, width: int, height: int, rgba: bytes) -> None:
    """Writes an 8 bit RGBA PNG."""
    raw = bytearray()
    stride = width * 4
    for y in range(height):
        raw.append(0)  # filter: none
        raw += rgba[y * stride:(y + 1) * stride]

    def chunk(tag: bytes, body: bytes) -> bytes:
        return (struct.pack(">I", len(body)) + tag + body
                + struct.pack(">I", zlib.crc32(tag + body) & 0xFFFFFFFF))

    header = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"sRGB", b"\x00")
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )


# =============================================================================
# Image operations
# =============================================================================

def clean_fringe(rgba: bytearray, width: int, height: int) -> None:
    """Removes the magenta selection fringe of the source artwork.

    The repository artwork carries a one pixel magenta halo around the two
    squares; it would show up as a pink rim in the macOS icon.
    """
    for index in range(width * height):
        offset = index * 4
        r, g, b = rgba[offset], rgba[offset + 1], rgba[offset + 2]
        if r > 120 and b > 90 and (r - g) > 40 and (b - g) > 40:
            rgba[offset + 3] = 0


def crop_to_alpha(rgba: bytearray, width: int, height: int, threshold: int = 8):
    """Crops the buffer to the bounding box of the visible artwork."""
    min_x, min_y, max_x, max_y = width, height, -1, -1
    for y in range(height):
        row = y * width * 4
        for x in range(width):
            if rgba[row + x * 4 + 3] > threshold:
                if x < min_x:
                    min_x = x
                if x > max_x:
                    max_x = x
                if y < min_y:
                    min_y = y
                if y > max_y:
                    max_y = y
    if max_x < 0:
        return rgba, width, height
    new_width = max_x - min_x + 1
    new_height = max_y - min_y + 1
    out = bytearray(new_width * new_height * 4)
    for y in range(new_height):
        src = ((min_y + y) * width + min_x) * 4
        dst = y * new_width * 4
        out[dst:dst + new_width * 4] = rgba[src:src + new_width * 4]
    return out, new_width, new_height


def resample(src: bytes, src_w: int, src_h: int, dst_w: int, dst_h: int) -> bytearray:
    """Area averaging resample (premultiplied alpha, no fringing)."""
    dst = bytearray(dst_w * dst_h * 4)
    for dy in range(dst_h):
        y0 = dy * src_h / dst_h
        y1 = (dy + 1) * src_h / dst_h
        row_start = int(math.floor(y0))
        row_end = max(row_start + 1, int(math.ceil(y1)))
        row_weights = []
        total_weight = 0.0
        for sy in range(row_start, min(row_end, src_h)):
            overlap = min(y1, sy + 1) - max(y0, sy)
            if overlap > 0:
                row_weights.append((sy, overlap))
                total_weight += overlap
        if not row_weights:
            continue
        base = dy * dst_w * 4
        for dx in range(dst_w):
            x0 = dx * src_w / dst_w
            x1 = (dx + 1) * src_w / dst_w
            col_start = int(math.floor(x0))
            col_end = max(col_start + 1, int(math.ceil(x1)))
            r_sum = g_sum = b_sum = a_sum = 0.0
            weight_sum = 0.0
            for sy, wy in row_weights:
                row_offset = sy * src_w * 4
                for sx in range(col_start, min(col_end, src_w)):
                    wx = min(x1, sx + 1) - max(x0, sx)
                    if wx <= 0:
                        continue
                    weight = wx * wy
                    offset = row_offset + sx * 4
                    alpha = src[offset + 3]
                    r_sum += src[offset] * alpha * weight
                    g_sum += src[offset + 1] * alpha * weight
                    b_sum += src[offset + 2] * alpha * weight
                    a_sum += alpha * weight
                    weight_sum += weight
            offset = base + dx * 4
            if weight_sum <= 0 or a_sum <= 0:
                dst[offset:offset + 4] = b"\x00\x00\x00\x00"
                continue
            dst[offset] = min(255, int(round(r_sum / a_sum)))
            dst[offset + 1] = min(255, int(round(g_sum / a_sum)))
            dst[offset + 2] = min(255, int(round(b_sum / a_sum)))
            dst[offset + 3] = min(255, int(round(a_sum / weight_sum)))
    return dst


def _superellipse_value(x: float, y: float, a: float, b: float) -> float:
    return (abs(x) / a) ** SUPERELLIPSE_N + (abs(y) / b) ** SUPERELLIPSE_N


def _approximate_distance(x: float, y: float, a: float, b: float) -> float:
    """A first order approximation of the distance to the superellipse."""
    value = _superellipse_value(x, y, a, b)
    if value <= 0:
        return -min(a, b)
    n = SUPERELLIPSE_N
    gx = n * (abs(x) / a) ** (n - 1) * (1.0 if x >= 0 else -1.0) / a
    gy = n * (abs(y) / b) ** (n - 1) * (1.0 if y >= 0 else -1.0) / b
    gradient = math.hypot(gx, gy)
    if gradient <= 0:
        return 0.0
    return (value - 1.0) / gradient


def squircle_coverage(width: int, height: int, inset: float) -> bytearray:
    """The antialiased coverage of the macOS rounded rectangle.

    `inset` is the distance between the canvas edge and the shape. The shape
    is a superellipse (|x/a|^n + |y/b|^n = 1) which is what the macOS icon
    grid uses for the corner curvature.

    The coverage is computed for the left half of every row and mirrored, so
    the shape is exactly symmetric.
    """
    a = width / 2.0 - inset
    b = height / 2.0 - inset
    cx = width / 2.0
    cy = height / 2.0
    coverage = bytearray(width * height)
    half = width // 2

    for y in range(height):
        dy = y + 0.5 - cy
        row = y * width
        if abs(dy) >= b:
            continue  # the whole row is outside the shape

        # The distance from the centre to the boundary, found by bisection:
        # the superellipse is monotone in |x|.
        low, high = 0.0, a
        for _ in range(30):
            mid = (low + high) / 2.0
            if _superellipse_value(mid, dy, a, b) < 1.0:
                low = mid
            else:
                high = mid
        boundary = cx - (low + high) / 2.0

        # Only the pixels around the boundary are antialiased. Everything to
        # the left of the boundary is outside the shape, everything to the
        # right of it (up to the centre) is inside.
        start = max(0, int(boundary) - 3)
        end = min(half - 1, int(boundary) + 3)
        for x in range(0, start):
            coverage[row + x] = 0
        for x in range(start, end + 1):
            dx = x + 0.5 - cx
            distance = _approximate_distance(dx, dy, a, b)
            value = 0.5 - distance
            value = 0.0 if value < 0 else (1.0 if value > 1 else value)
            coverage[row + x] = int(round(value * 255))
        for x in range(end + 1, half):
            coverage[row + x] = 255

        # Mirror the left half onto the right half.
        for x in range(half):
            coverage[row + (width - 1 - x)] = coverage[row + x]
    return coverage


def apply_mask(rgba: bytearray, width: int, height: int, coverage: bytearray) -> None:
    for index in range(width * height):
        alpha = rgba[index * 4 + 3]
        if alpha == 0:
            # Fully transparent pixels keep no colour: some viewers would
            # otherwise show the colour of the (removed) magenta fringe.
            rgba[index * 4] = 0
            rgba[index * 4 + 1] = 0
            rgba[index * 4 + 2] = 0
            continue
        factor = coverage[index] / 255.0
        rgba[index * 4 + 3] = int(round(alpha * factor))
        if coverage[index] == 0:
            rgba[index * 4] = 0
            rgba[index * 4 + 1] = 0
            rgba[index * 4 + 2] = 0


# =============================================================================
# Driver
# =============================================================================

def build_icon_set(source: Path, output: Path) -> list[Path]:
    width, height, rgba = decode_png(source)
    print(f"source        : {source} ({width}x{height})")
    clean_fringe(rgba, width, height)
    rgba, width, height = crop_to_alpha(rgba, width, height)
    print(f"artwork       : {width}x{height} (cropped to the visible artwork)")

    # The tile behind the artwork: `--zode-ink` from packages/shared/tokens.css.
    background = (20, 20, 20)

    written: list[Path] = []
    for points, scale in ICON_SPECS:
        size = points * scale
        target = output / f"icon_{points}x{points}{'@2x' if scale == 2 else ''}.png"

        resized = resample(bytes(rgba), width, height, size, size)
        inset = size * (1.0 - ARTWORK_FRACTION) / 2.0
        coverage = squircle_coverage(size, size, inset)

        # The artwork is composited on the tile, then the whole tile is
        # masked with the macOS rounded rectangle.
        for index in range(size * size):
            offset = index * 4
            alpha = resized[offset + 3] / 255.0
            for channel in range(3):
                resized[offset + channel] = int(round(
                    resized[offset + channel] * alpha
                    + background[channel] * (1.0 - alpha)
                ))
            resized[offset + 3] = 255

        apply_mask(resized, size, size, coverage)
        encode_png(target, size, size, bytes(resized))

        # Round trip check: the file we just wrote must decode again.
        check_w, check_h, _ = decode_png(target)
        if (check_w, check_h) != (size, size):
            raise RuntimeError(f"{target} decoded as {check_w}x{check_h}")
        written.append(target)
        print(f"  {target.name:24s} {size:4d}x{size:<4d} ({points}pt @{'2' if scale == 2 else '1'}x)")

    contents = {
        "images": [
            {
                "filename": f"icon_{points}x{points}{'@2x' if scale == 2 else ''}.png",
                "idiom": "mac",
                "scale": f"{scale}x",
                "size": f"{points}x{points}",
            }
            for points, scale in ICON_SPECS
        ],
        "info": {"author": "xcode", "version": 1},
    }
    contents_path = output / "Contents.json"
    contents_path.write_text(json.dumps(contents, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    written.append(contents_path)
    print(f"  {contents_path.name:24s} (app icon set manifest)")
    return written


def main() -> int:
    parser = argparse.ArgumentParser(description="Build the Zode macOS app icon set.")
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE,
                        help="the source artwork (default: ../../icons/zode.png)")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT,
                        help="the AppIcon.appiconset folder")
    parser.add_argument("--check", action="store_true",
                        help="only verify that the icon set exists and is complete")
    args = parser.parse_args()

    try:
        import PIL  # noqa: F401
        print("Pillow detected — using it for the image pipeline")
    except ImportError:
        print("Pillow not available — using the built-in PNG codec (stdlib only)")

    if args.check:
        missing = []
        for points, scale in ICON_SPECS:
            name = f"icon_{points}x{points}{'@2x' if scale == 2 else ''}.png"
            if not (args.output / name).exists():
                missing.append(name)
        if not (args.output / "Contents.json").exists():
            missing.append("Contents.json")
        if missing:
            print("MISSING: " + ", ".join(missing))
            return 1
        print(f"app icon set is complete: {args.output}")
        return 0

    if not args.source.exists():
        print(f"error: the source artwork {args.source} does not exist", file=sys.stderr)
        return 1

    build_icon_set(args.source, args.output)
    print(f"done — {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
