#!/usr/bin/env python3
"""Shared icon art helpers for the Zode launcher icons.

The product icon (`icons/zode.png`) is an orange plate with the Zune "bracket"
mark burned into it, overlapped by a dark square. These helpers pull the mark
out cleanly so the Android and iOS icons can be built from the same art.

Standard library only.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Dict, List, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parent))

import pnglib  # noqa: E402

# The ink used for the bracket mark.
INK = (0x1F, 0x1F, 0x1F, 255)

# The fallback brand orange.
BRAND_ORANGE = (0xFF, 0x4E, 0x00)


def is_orange(rgba) -> bool:
    r, g, b, a = rgba
    return a > 200 and r > 190 and 40 < g < 160 and b < 120


def is_ink(rgba) -> bool:
    r, g, b, a = rgba
    return a > 200 and r < 110 and g < 110 and b < 110


def orange_bounds(image: pnglib.Image) -> Tuple[int, int, int, int]:
    return pnglib.bounds_of(image, lambda x, y, rgba: is_orange(rgba))


def build_art(image: pnglib.Image) -> Tuple[pnglib.Image, pnglib.Image]:
    """Return (plate, glyph) cropped from the product icon.

    `plate` is the orange square with the bracket burned into it. `glyph` is
    the bracket alone on transparency.

    The product icon overlaps a dark square on the right hand edge, so the
    glyph is extracted with a flood fill from the plate border: every dark
    pixel connected to the border belongs to the background, everything left
    over is the bracket mark. Small leftover components are then dropped.
    """
    left, top, width, height = orange_bounds(image)
    if width == 0:
        raise ValueError("Could not find the orange plate")

    plate = image.crop(left, top, width, height)

    background = set()
    stack = []
    for x in range(width):
        stack.append((x, 0))
        stack.append((x, height - 1))
    for y in range(height):
        stack.append((0, y))
        stack.append((width - 1, y))

    while stack:
        x, y = stack.pop()
        if (x, y) in background:
            continue
        if x < 0 or y < 0 or x >= width or y >= height:
            continue
        r, g, b, a = plate.pixel(x, y)
        if not is_ink((r, g, b, a)):
            continue
        background.add((x, y))
        stack.append((x + 1, y))
        stack.append((x - 1, y))
        stack.append((x, y + 1))
        stack.append((x, y - 1))

    glyph = pnglib.Image(width, height, bytearray(width * height * 4))
    for y in range(height):
        for x in range(width):
            r, g, b, a = plate.pixel(x, y)
            if is_ink((r, g, b, a)) and (x, y) not in background:
                glyph.set_pixel(x, y, INK)

    return plate, keep_main_components(glyph, min_height_ratio=0.2)


def keep_main_components(image: pnglib.Image, min_height_ratio: float) -> pnglib.Image:
    """Drop the small/thin connected components of a mark."""
    width, height = image.width, image.height
    seen = bytearray(width * height)
    components: List[List[Tuple[int, int]]] = []

    for y in range(height):
        for x in range(width):
            index = y * width + x
            if seen[index]:
                continue
            if image.pixel(x, y)[3] == 0:
                seen[index] = 1
                continue
            stack = [(x, y)]
            pixels: List[Tuple[int, int]] = []
            while stack:
                cx, cy = stack.pop()
                cindex = cy * width + cx
                if seen[cindex] or cx < 0 or cy < 0 or cx >= width or cy >= height:
                    continue
                if image.pixel(cx, cy)[3] == 0:
                    seen[cindex] = 1
                    continue
                seen[cindex] = 1
                pixels.append((cx, cy))
                stack.append((cx + 1, cy))
                stack.append((cx - 1, cy))
                stack.append((cx, cy + 1))
                stack.append((cx, cy - 1))
            components.append(pixels)

    if not components:
        return image

    heights = []
    for pixels in components:
        ys = [p[1] for p in pixels]
        heights.append(max(ys) - min(ys) + 1)
    tallest = max(heights)

    result = pnglib.Image(width, height, bytearray(width * height * 4))
    for pixels, component_height in zip(components, heights):
        if component_height < tallest * min_height_ratio:
            continue
        for px, py in pixels:
            result.set_pixel(px, py, image.pixel(px, py))
    return result


def orange_sample(plate: pnglib.Image) -> Tuple[int, int, int]:
    """The orange used by the plate, found as the most common orange pixel."""
    counts: Dict[Tuple[int, int, int], int] = {}
    step_x = max(1, plate.width // 96)
    step_y = max(1, plate.height // 96)
    for y in range(0, plate.height, step_y):
        for x in range(0, plate.width, step_x):
            r, g, b, a = plate.pixel(x, y)
            if is_orange((r, g, b, a)):
                key = (r, g, b)
                counts[key] = counts.get(key, 0) + 1
    if not counts:
        return BRAND_ORANGE
    return max(counts.items(), key=lambda item: item[1])[0]


def mark_bounds(glyph: pnglib.Image) -> Tuple[int, int, int, int]:
    return pnglib.bounds_of(glyph, lambda x, y, rgba: rgba[3] > 0)


def legacy_icon(plate: pnglib.Image, glyph: pnglib.Image, size: int) -> pnglib.Image:
    """A flat square in the brand orange with the bracket mark centred on it."""
    sample = orange_sample(plate)
    icon = pnglib.Image(
        size, size, bytearray(bytes((sample[0], sample[1], sample[2], 255)) * (size * size))
    )

    left, top, width, height = mark_bounds(glyph)
    if width == 0:
        return icon
    mark = glyph.crop(left, top, width, height)

    # The mark occupies 30% of the icon, exactly as in the product icon.
    target_width = max(1, int(round(size * 0.30)))
    target_height = max(1, int(round(height * target_width / width)))
    mark = mark.resized(target_width, target_height)

    icon.paste(mark, (size - target_width) // 2, (size - target_height) // 2)
    return icon
