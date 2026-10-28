#!/usr/bin/env python3
"""A tiny, dependency-free PNG reader/writer.

Only what the icon generators need:

  * read 8-bit RGB / RGBA / grey / grey+alpha, non-interlaced PNGs
  * write 8-bit RGBA PNGs
  * crop, resample (box filter) and composite

Standard library only (`zlib` + `struct`), so the icon tools run on a bare
Python 3 install.
"""

from __future__ import annotations

import struct
import zlib
from typing import List, Tuple

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


class Image:
    """An 8-bit RGBA image."""

    def __init__(self, width: int, height: int, pixels: bytearray) -> None:
        self.width = width
        self.height = height
        self.pixels = pixels  # RGBA, row major

    # -- pixel helpers --------------------------------------------------
    def pixel(self, x: int, y: int) -> Tuple[int, int, int, int]:
        index = (y * self.width + x) * 4
        data = self.pixels
        return data[index], data[index + 1], data[index + 2], data[index + 3]

    def set_pixel(self, x: int, y: int, rgba: Tuple[int, int, int, int]) -> None:
        index = (y * self.width + x) * 4
        self.pixels[index:index + 4] = bytes(rgba)

    def crop(self, left: int, top: int, width: int, height: int) -> "Image":
        out = bytearray(width * height * 4)
        for y in range(height):
            source = ((top + y) * self.width + left) * 4
            target = y * width * 4
            out[target:target + width * 4] = self.pixels[source:source + width * 4]
        return Image(width, height, out)

    def resized(self, width: int, height: int) -> "Image":
        """Box-filter resample. Fast enough for icon work."""
        out = bytearray(width * height * 4)
        source = self.pixels
        target = out
        x_ratio = self.width / width
        y_ratio = self.height / height
        for y in range(height):
            y0 = int(y * y_ratio)
            y1 = max(y0 + 1, int((y + 1) * y_ratio))
            y1 = min(y1, self.height)
            for x in range(width):
                x0 = int(x * x_ratio)
                x1 = max(x0 + 1, int((x + 1) * x_ratio))
                x1 = min(x1, self.width)
                r = g = b = a = 0
                count = 0
                for sy in range(y0, y1):
                    row = sy * self.width
                    for sx in range(x0, x1):
                        index = (row + sx) * 4
                        r += source[index]
                        g += source[index + 1]
                        b += source[index + 2]
                        a += source[index + 3]
                        count += 1
                index = (y * width + x) * 4
                target[index] = r // count
                target[index + 1] = g // count
                target[index + 2] = b // count
                target[index + 3] = a // count
        return Image(width, height, out)

    def filled(self, width: int, height: int, rgba: Tuple[int, int, int, int]) -> "Image":
        return Image(width, height, bytearray(bytes(rgba) * (width * height)))

    def paste(self, other: "Image", left: int, top: int) -> None:
        """Alpha-composite `other` over this image at (left, top)."""
        for y in range(other.height):
            target_y = top + y
            if target_y < 0 or target_y >= self.height:
                continue
            for x in range(other.width):
                target_x = left + x
                if target_x < 0 or target_x >= self.width:
                    continue
                r, g, b, a = other.pixel(x, y)
                if a == 0:
                    continue
                if a == 255:
                    self.set_pixel(target_x, target_y, (r, g, b, 255))
                    continue
                br, bg, bb, ba = self.pixel(target_x, target_y)
                alpha = a / 255.0
                inv = 1.0 - alpha
                self.set_pixel(
                    target_x,
                    target_y,
                    (
                        int(r * alpha + br * inv),
                        int(g * alpha + bg * inv),
                        int(b * alpha + bb * inv),
                        max(ba, a),
                    ),
                )

    def is_opaque(self) -> bool:
        return all(self.pixels[3::4][i] == 255 for i in range(0, len(self.pixels) // 4, 97))


# ----------------------------------------------------------------------
# Reading


def _unfilter(raw: bytes, width: int, height: int, channels: int) -> bytearray:
    stride = width * channels
    out = bytearray(stride * height)
    previous = bytearray(stride)
    position = 0
    for y in range(height):
        filter_type = raw[position]
        position += 1
        line = bytearray(raw[position:position + stride])
        position += stride

        if filter_type == 0:
            pass
        elif filter_type == 1:
            for i in range(channels, stride):
                line[i] = (line[i] + line[i - channels]) & 0xFF
        elif filter_type == 2:
            for i in range(stride):
                line[i] = (line[i] + previous[i]) & 0xFF
        elif filter_type == 3:
            for i in range(stride):
                left = line[i - channels] if i >= channels else 0
                line[i] = (line[i] + ((left + previous[i]) >> 1)) & 0xFF
        elif filter_type == 4:
            for i in range(stride):
                left = line[i - channels] if i >= channels else 0
                up = previous[i]
                up_left = previous[i - channels] if i >= channels else 0
                p = left + up - up_left
                pa = p - left
                if pa < 0:
                    pa = -pa
                pb = p - up
                if pb < 0:
                    pb = -pb
                pc = p - up_left
                if pc < 0:
                    pc = -pc
                if pa <= pb and pa <= pc:
                    predictor = left
                elif pb <= pc:
                    predictor = up
                else:
                    predictor = up_left
                line[i] = (line[i] + predictor) & 0xFF
        else:
            raise ValueError("Unsupported PNG filter %d" % filter_type)

        out[y * stride:(y + 1) * stride] = line
        previous = line
    return out


def read_png(path: str) -> Image:
    with open(path, "rb") as handle:
        data = handle.read()

    if data[:8] != PNG_SIGNATURE:
        raise ValueError("%s is not a PNG" % path)

    position = 8
    idat = bytearray()
    width = height = 0
    bit_depth = color_type = 0
    interlace = 0
    palette = b""

    while position < len(data):
        length = struct.unpack(">I", data[position:position + 4])[0]
        chunk_type = data[position + 4:position + 8]
        chunk = data[position + 8:position + 8 + length]
        position += 12 + length

        if chunk_type == b"IHDR":
            width, height, bit_depth, color_type, _compression, _filter, interlace = struct.unpack(
                ">IIBBBBB", chunk
            )
        elif chunk_type == b"PLTE":
            palette = chunk
        elif chunk_type == b"IDAT":
            idat += chunk
        elif chunk_type == b"IEND":
            break

    if bit_depth != 8:
        raise ValueError("Only 8-bit PNGs are supported (got %d)" % bit_depth)
    if interlace != 0:
        raise ValueError("Interlaced PNGs are not supported")

    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}.get(color_type)
    if channels is None:
        raise ValueError("Unsupported colour type %d" % color_type)

    raw = zlib.decompress(bytes(idat))
    flat = _unfilter(raw, width, height, channels)

    pixels = bytearray(width * height * 4)
    for index in range(width * height):
        source = index * channels
        target = index * 4
        if color_type == 6:
            pixels[target:target + 4] = flat[source:source + 4]
        elif color_type == 2:
            pixels[target] = flat[source]
            pixels[target + 1] = flat[source + 1]
            pixels[target + 2] = flat[source + 2]
            pixels[target + 3] = 255
        elif color_type == 0:
            value = flat[source]
            pixels[target] = value
            pixels[target + 1] = value
            pixels[target + 2] = value
            pixels[target + 3] = 255
        elif color_type == 4:
            value = flat[source]
            alpha = flat[source + 1]
            pixels[target] = value
            pixels[target + 1] = value
            pixels[target + 2] = value
            pixels[target + 3] = alpha
        elif color_type == 3:
            entry = flat[source] * 3
            pixels[target:target + 3] = palette[entry:entry + 3]
            pixels[target + 3] = 255

    return Image(width, height, pixels)


# ----------------------------------------------------------------------
# Writing


def _chunk(chunk_type: bytes, payload: bytes) -> bytes:
    return (
        struct.pack(">I", len(payload))
        + chunk_type
        + payload
        + struct.pack(">I", zlib.crc32(chunk_type + payload) & 0xFFFFFFFF)
    )


def write_png(path: str, image: Image) -> None:
    raw = bytearray()
    stride = image.width * 4
    for y in range(image.height):
        raw.append(0)
        raw += image.pixels[y * stride:(y + 1) * stride]

    header = struct.pack(">IIBBBBB", image.width, image.height, 8, 6, 0, 0, 0)
    body = (
        PNG_SIGNATURE
        + _chunk(b"IHDR", header)
        + _chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + _chunk(b"IEND", b"")
    )
    with open(path, "wb") as handle:
        handle.write(body)


def hex_to_rgba(value: str, alpha: int = 255) -> Tuple[int, int, int, int]:
    value = value.lstrip("#")
    return (
        int(value[0:2], 16),
        int(value[2:4], 16),
        int(value[4:6], 16),
        alpha,
    )


def bounds_of(
    image: Image, predicate
) -> Tuple[int, int, int, int]:
    """The bounding box of the pixels that satisfy `predicate(x, y, rgba)`."""
    left = image.width
    top = image.height
    right = -1
    bottom = -1
    for y in range(image.height):
        for x in range(image.width):
            if predicate(x, y, image.pixel(x, y)):
                if x < left:
                    left = x
                if x > right:
                    right = x
                if y < top:
                    top = y
                if y > bottom:
                    bottom = y
    if right < 0:
        return (0, 0, 0, 0)
    return (left, top, right - left + 1, bottom - top + 1)
