#!/usr/bin/env python3
"""make_ico.py — dependency-free PNG -> ICO converter for the Zode Windows shell.

Pure Python 3 standard library only (zlib + struct).  PIL/Pillow is NOT
required, which matters because the build machine for the shell is allowed to
be a bare Windows box with nothing but the .NET SDK installed.

The source image is a 1600x1600 8-bit RGBA PNG.  We decode it by hand
(IHDR + IDAT + un-filtering) and then emit a classic multi-resolution .ico
containing 16 / 32 / 48 / 64 / 128 / 256 px entries, each stored as a
32-bit BGRA "DIB" (BITMAPINFOHEADER + XOR bitmap + AND mask), which every
Windows version understands (unlike PNG-compressed entries, which need
Vista+ for full shell support).

Usage:
    python3 tools/make_ico.py [source.png] [dest.ico]
"""

from __future__ import annotations

import struct
import sys
import zlib
from pathlib import Path

SIZES = (16, 32, 48, 64, 128, 256)

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


# --------------------------------------------------------------------------
# PNG decoding
# --------------------------------------------------------------------------
class PngError(RuntimeError):
    pass


def _read_chunks(data: bytes):
    if data[:8] != PNG_SIGNATURE:
        raise PngError("not a PNG file")
    pos = 8
    idat = bytearray()
    header = None
    palette = b""
    trns = b""
    while pos + 8 <= len(data):
        (length,) = struct.unpack(">I", data[pos : pos + 4])
        ctype = data[pos + 4 : pos + 8]
        body = data[pos + 8 : pos + 8 + length]
        pos += 12 + length  # length + type + data + crc
        if ctype == b"IHDR":
            header = struct.unpack(">IIBBBBB", body)
        elif ctype == b"IDAT":
            idat += body
        elif ctype == b"PLTE":
            palette = body
        elif ctype == b"tRNS":
            trns = body
        elif ctype == b"IEND":
            break
    if header is None:
        raise PngError("PNG has no IHDR chunk")
    return header, bytes(idat), palette, trns


def _unfilter(raw: bytes, width: int, height: int, bpp: int) -> bytearray:
    """Undo the per-scanline PNG filters (types 0..4)."""
    stride = width * bpp
    out = bytearray(stride * height)
    prev = bytearray(stride)
    pos = 0
    for y in range(height):
        ftype = raw[pos]
        pos += 1
        line = bytearray(raw[pos : pos + stride])
        if len(line) != stride:
            raise PngError("truncated PNG image data")
        pos += stride
        if ftype == 0:
            pass
        elif ftype == 1:  # Sub
            for i in range(bpp, stride):
                line[i] = (line[i] + line[i - bpp]) & 0xFF
        elif ftype == 2:  # Up
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif ftype == 3:  # Average
            for i in range(stride):
                left = line[i - bpp] if i >= bpp else 0
                line[i] = (line[i] + ((left + prev[i]) >> 1)) & 0xFF
        elif ftype == 4:  # Paeth
            for i in range(stride):
                left = line[i - bpp] if i >= bpp else 0
                up = prev[i]
                upleft = prev[i - bpp] if i >= bpp else 0
                p = left + up - upleft
                pa, pb, pc = abs(p - left), abs(p - up), abs(p - upleft)
                if pa <= pb and pa <= pc:
                    pred = left
                elif pb <= pc:
                    pred = up
                else:
                    pred = upleft
                line[i] = (line[i] + pred) & 0xFF
        else:
            raise PngError(f"unsupported PNG filter type {ftype}")
        out[y * stride : (y + 1) * stride] = line
        prev = line
    return out


def decode_png(path: Path) -> tuple[int, int, bytearray]:
    """Return (width, height, RGBA bytes) for a non-interlaced PNG."""
    header, idat, palette, trns = _read_chunks(path.read_bytes())
    width, height, depth, color, _comp, _filt, interlace = header
    if interlace:
        raise PngError("interlaced PNGs are not supported")
    if depth != 8:
        raise PngError(f"only 8-bit PNGs are supported (got {depth}-bit)")

    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}.get(color)
    if channels is None:
        raise PngError(f"unsupported PNG colour type {color}")

    raw = zlib.decompress(idat)
    bpp = channels
    pixels = _unfilter(raw, width, height, bpp)

    rgba = bytearray(width * height * 4)
    for i in range(width * height):
        src = i * bpp
        if color == 6:  # RGBA
            rgba[i * 4 : i * 4 + 4] = pixels[src : src + 4]
        elif color == 2:  # RGB
            rgba[i * 4 : i * 4 + 3] = pixels[src : src + 3]
            rgba[i * 4 + 3] = 255
        elif color == 0:  # greyscale
            g = pixels[src]
            rgba[i * 4 : i * 4 + 3] = bytes((g, g, g))
            rgba[i * 4 + 3] = 255
        elif color == 4:  # grey + alpha
            g = pixels[src]
            rgba[i * 4 : i * 4 + 3] = bytes((g, g, g))
            rgba[i * 4 + 3] = pixels[src + 1]
        elif color == 3:  # palette
            idx = pixels[src]
            rgba[i * 4 : i * 4 + 3] = palette[idx * 3 : idx * 3 + 3]
            rgba[i * 4 + 3] = trns[idx] if idx < len(trns) else 255
    return width, height, rgba


# --------------------------------------------------------------------------
# Scaling + ICO packing
# --------------------------------------------------------------------------
def resize_rgba(
    src: bytes, src_w: int, src_h: int, dst_w: int, dst_h: int
) -> bytes:
    """Box-filter downscale (or nearest upscale) of an RGBA buffer."""
    dst = bytearray(dst_w * dst_h * 4)
    for y in range(dst_h):
        y0 = (y * src_h) // dst_h
        y1 = max(y0 + 1, ((y + 1) * src_h) // dst_h)
        for x in range(dst_w):
            x0 = (x * src_w) // dst_w
            x1 = max(x0 + 1, ((x + 1) * src_w) // dst_w)
            r = g = b = a = 0
            n = 0
            for sy in range(y0, y1):
                row = sy * src_w
                for sx in range(x0, x1):
                    o = (row + sx) * 4
                    r += src[o]
                    g += src[o + 1]
                    b += src[o + 2]
                    a += src[o + 3]
                    n += 1
            o = (y * dst_w + x) * 4
            dst[o] = r // n
            dst[o + 1] = g // n
            dst[o + 2] = b // n
            dst[o + 3] = a // n
    return bytes(dst)


def resample_chain(
    rgba: bytes, width: int, height: int, sizes=SIZES
) -> dict[int, bytes]:
    """Progressively resample the source down to every requested size.

    Downscaling 1600x1600 straight to 16x16 in one box filter loses too much
    detail, so we walk the sizes through a halving chain (1600 -> 512 -> 256 ->
    128 -> ...) and derive every entry from the next larger one.
    """
    chain = sorted({*sizes, 512}, reverse=True)
    out: dict[int, bytes] = {}
    current, cur_w, cur_h = rgba, width, height
    for size in chain:
        if size > cur_w:
            continue
        current = resize_rgba(current, cur_w, cur_h, size, size)
        cur_w = cur_h = size
        out[size] = current
    for size in sizes:
        if size not in out:
            out[size] = resize_rgba(current, cur_w, cur_h, size, size)
    return out


def _dib_entry(rgba: bytes, size: int) -> bytes:
    """Build a 32-bit BGRA 'DIB' (BITMAPINFOHEADER + XOR + AND mask)."""
    header = struct.pack(
        "<IiiHHIIiiII",
        40,  # biSize
        size,  # biWidth
        size * 2,  # biHeight (XOR + AND mask stacked)
        1,  # biPlanes
        32,  # biBitCount
        0,  # biCompression = BI_RGB
        size * size * 4,  # biSizeImage
        0,
        0,
        0,
        0,
    )
    xor = bytearray()
    for y in range(size - 1, -1, -1):  # bottom-up
        row = y * size * 4
        for x in range(size):
            o = row + x * 4
            xor += bytes((rgba[o + 2], rgba[o + 1], rgba[o], rgba[o + 3]))
    mask_stride = ((size + 31) // 32) * 4  # 1bpp rows padded to 4 bytes
    mask = bytearray()
    for y in range(size - 1, -1, -1):
        bits = bytearray(mask_stride)
        row = y * size * 4
        for x in range(size):
            if rgba[row + x * 4 + 3] < 128:
                bits[x >> 3] |= 0x80 >> (x & 7)
        mask += bits
    return header + bytes(xor) + bytes(mask)


def build_ico(scaled: dict[int, bytes], sizes=SIZES) -> bytes:
    images = []
    for size in sizes:
        images.append((size, _dib_entry(scaled[size], size)))
    out = bytearray(struct.pack("<HHH", 0, 1, len(images)))
    offset = 6 + 16 * len(images)
    for size, data in images:
        out += struct.pack(
            "<BBBBHHII",
            size if size < 256 else 0,
            size if size < 256 else 0,
            0,  # palette size (0 = truecolour)
            0,  # reserved
            1,  # colour planes
            32,  # bits per pixel
            len(data),
            offset,
        )
        offset += len(data)
    for _size, data in images:
        out += data
    return bytes(out)


def main(argv: list[str]) -> int:
    root = Path(__file__).resolve().parents[3]
    src = Path(argv[1]) if len(argv) > 1 else root / "icons" / "zode.png"
    dst = Path(argv[2]) if len(argv) > 2 else Path(__file__).resolve().parents[1] / "icons" / "zode.ico"
    if not src.is_file():
        print(f"ERROR: source PNG not found: {src}", file=sys.stderr)
        return 2
    width, height, rgba = decode_png(src)
    print(f"decoded {src} -> {width}x{height} RGBA")
    scaled = resample_chain(rgba, width, height)
    for size in SIZES:
        print(f"  resampled -> {size}x{size}")
    blob = build_ico(scaled, SIZES)
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_bytes(blob)
    print(f"wrote {dst} ({len(blob)} bytes, sizes: {', '.join(map(str, SIZES))})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
