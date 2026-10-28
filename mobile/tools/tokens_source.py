#!/usr/bin/env python3
"""Shared parser for `packages/shared/tokens.css`.

The mobile apps must use the SAME colours and type scale as the web app, so the
CSS custom properties are parsed here once and rendered into:

  * mobile/ios/ZodeMobile/Design/Tokens.swift        (SwiftUI)
  * mobile/android/app/src/main/java/com/zode/app/design/Tokens.kt  (Compose)

This module is stdlib-only and is imported by `generate_tokens.py`.

The parser is deliberately small but strict: it understands

    --name: value;             /* a single custom property          */
    --name: rgba(1, 2, 3, .4);  /* a colour with alpha                */
    --name: cubic-bezier(a,b,c,d);
    --name: 12px | 0.14em | 200 | 120ms | "Segoe UI", ...;

and ignores everything else (at-rules, selectors, comments).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

COMMENT_RE = re.compile(r"/\*.*?\*/", re.DOTALL)
VAR_RE = re.compile(r"--([A-Za-z0-9_-]+)\s*:\s*([^;]+);", re.DOTALL)

HEX_RE = re.compile(r"^#([0-9a-fA-F]{3,8})$")
RGB_RE = re.compile(
    r"^rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)\s*(?:,\s*([0-9.]+)\s*)?\)$"
)


@dataclass(frozen=True)
class Color:
    """An sRGB colour with straight (non-premultiplied) alpha."""

    r: int
    g: int
    b: int
    a: float = 1.0

    @property
    def hex(self) -> str:
        return "#%02x%02x%02x" % (self.r, self.g, self.b)

    @property
    def argb_hex(self) -> str:
        return "#%02x%02x%02x%02x" % (
            int(round(self.a * 255)),
            self.r,
            self.g,
            self.b,
        )

    def swift_literal(self) -> str:
        if self.a >= 1.0:
            return "Color(hex: 0x%02X%02X%02X)" % (self.r, self.g, self.b)
        return "Color(hex: 0x%02X%02X%02X, alpha: %s)" % (
            self.r,
            self.g,
            self.b,
            _swift_double(self.a),
        )

    def kotlin_literal(self) -> str:
        return (
            "Color(red = %s, green = %s, blue = %s, alpha = %s)"
            % (
                _kotlin_float(self.r / 255.0),
                _kotlin_float(self.g / 255.0),
                _kotlin_float(self.b / 255.0),
                _kotlin_float(self.a),
            )
        )


@dataclass(frozen=True)
class ShadowLayer:
    """One layer of a CSS `box-shadow`."""

    radius: float = 0.0
    offset_x: float = 0.0
    offset_y: float = 0.0
    color: Optional[Color] = None
    inset: bool = False


@dataclass(frozen=True)
class Shadow:
    """A (very) small subset of the CSS box-shadow syntax used by tokens.css."""

    raw: str
    layers: tuple = ()


@dataclass
class Tokens:
    """Parsed design tokens, keyed by the raw CSS custom-property name."""

    colors: Dict[str, Color] = field(default_factory=dict)
    lengths: Dict[str, float] = field(default_factory=dict)
    em: Dict[str, float] = field(default_factory=dict)
    weights: Dict[str, int] = field(default_factory=dict)
    milliseconds: Dict[str, float] = field(default_factory=dict)
    beziers: Dict[str, Tuple[float, float, float, float]] = field(default_factory=dict)
    shadows: Dict[str, Shadow] = field(default_factory=dict)
    fonts: Dict[str, List[str]] = field(default_factory=dict)
    raw: Dict[str, str] = field(default_factory=dict)

    def category(self, prefix: str) -> List[Tuple[str, str]]:
        """Return (css_name, value) pairs for every variable starting with prefix."""
        return [(k, v) for k, v in self.raw.items() if k.startswith(prefix)]


def _swift_double(value: float) -> str:
    text = ("%.4f" % value).rstrip("0").rstrip(".")
    return text if text else "0"


def _kotlin_float(value: float) -> str:
    """A Kotlin **Float** literal, e.g. `0.6275f`, `1f`, `0f`.

    Compose's `Color(red = …, green = …, blue = …, alpha = …)` takes Floats, so
    the `f` suffix is required -- and a bare `0` would be an Int.
    """
    text = ("%.4f" % value).rstrip("0").rstrip(".")
    if not text or text in ("-", "-0"):
        text = "0"
    if "." not in text:
        text += ".0"
    return text + "f"


def _parse_length(value: str) -> Optional[float]:
    match = re.match(r"^(-?[0-9.]+)\s*px$", value.strip())
    if match:
        return float(match.group(1))
    return None


def _parse_em(value: str) -> Optional[float]:
    match = re.match(r"^(-?[0-9.]+)\s*em$", value.strip())
    if match:
        return float(match.group(1))
    return None


def _parse_number(value: str) -> Optional[float]:
    match = re.match(r"^(-?[0-9.]+)$", value.strip())
    if match:
        return float(match.group(1))
    return None


def _parse_color(value: str) -> Optional[Color]:
    value = value.strip()
    hex_match = HEX_RE.match(value)
    if hex_match:
        digits = hex_match.group(1)
        if len(digits) == 3:
            r, g, b = (int(c * 2, 16) for c in digits)
            return Color(r, g, b)
        if len(digits) == 6:
            return Color(
                int(digits[0:2], 16), int(digits[2:4], 16), int(digits[4:6], 16)
            )
        if len(digits) == 8:
            return Color(
                int(digits[0:2], 16),
                int(digits[2:4], 16),
                int(digits[4:6], 16),
                int(digits[6:8], 16) / 255.0,
            )
        return None
    rgb_match = RGB_RE.match(value)
    if rgb_match:
        r = int(float(rgb_match.group(1)))
        g = int(float(rgb_match.group(2)))
        b = int(float(rgb_match.group(3)))
        a = float(rgb_match.group(4)) if rgb_match.group(4) is not None else 1.0
        return Color(r, g, b, a)
    return None


def _split_top_level(value: str) -> list:
    parts = []
    depth = 0
    current = ""
    for char in value:
        if char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
        if char == "," and depth == 0:
            parts.append(current.strip())
            current = ""
        else:
            current += char
    if current.strip():
        parts.append(current.strip())
    return parts


def _parse_shadow_layer(value: str) -> ShadowLayer:
    inset = "inset" in value
    body = value.replace("inset", " ").strip()
    color: Optional[Color] = None
    # Pull the colour out first (it may be rgba(...) which contains spaces).
    rgba_match = re.search(r"rgba?\([^)]*\)", body)
    if rgba_match:
        color = _parse_color(rgba_match.group(0))
        body = (body[: rgba_match.start()] + " " + body[rgba_match.end() :]).strip()
    else:
        hex_match = re.search(r"#[0-9a-fA-F]{3,8}", body)
        if hex_match:
            color = _parse_color(hex_match.group(0))
            body = (body[: hex_match.start()] + " " + body[hex_match.end() :]).strip()
    numbers = [float(n) for n in re.findall(r"-?[0-9.]+", body)]
    radius = numbers[0] if len(numbers) >= 1 else 0.0
    offset_x = numbers[1] if len(numbers) >= 2 else 0.0
    offset_y = numbers[2] if len(numbers) >= 3 else 0.0
    return ShadowLayer(
        radius=radius, offset_x=offset_x, offset_y=offset_y, color=color, inset=inset
    )


def _parse_shadow(value: str) -> Shadow:
    raw = value.strip()
    layers = tuple(_parse_shadow_layer(part) for part in _split_top_level(raw))
    return Shadow(raw=raw, layers=layers)


def _parse_font_stack(value: str) -> List[str]:
    parts: List[str] = []
    depth = 0
    current = ""
    for char in value:
        if char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
        if char == "," and depth == 0:
            parts.append(current.strip().strip('"').strip("'"))
            current = ""
        else:
            current += char
    if current.strip():
        parts.append(current.strip().strip('"').strip("'"))
    return [p for p in parts if p]


def parse_tokens(css_text: str) -> Tokens:
    """Parse a tokens.css document into a `Tokens` structure."""
    tokens = Tokens()
    stripped = COMMENT_RE.sub("", css_text)

    for name, raw_value in VAR_RE.findall(stripped):
        value = " ".join(raw_value.split())
        if name in tokens.raw:
            # First declaration wins (the `:root` block comes first).
            continue
        tokens.raw[name] = value

        lowered = value.lower()
        if lowered.startswith("cubic-bezier("):
            numbers = [float(n) for n in re.findall(r"-?[0-9.]+", value)]
            if len(numbers) == 4:
                tokens.beziers[name] = (numbers[0], numbers[1], numbers[2], numbers[3])
            continue
        if lowered.endswith("ms"):
            number = _parse_number(value[:-2])
            if number is not None:
                tokens.milliseconds[name] = number
                continue
        if lowered.endswith("em"):
            number = _parse_em(value)
            if number is not None:
                tokens.em[name] = number
                continue
        if lowered.endswith("px"):
            number = _parse_length(value)
            if number is not None:
                tokens.lengths[name] = number
                continue
        if lowered.startswith("rgba(") or lowered.startswith("rgb("):
            color = _parse_color(value)
            if color is not None:
                tokens.colors[name] = color
            continue
        if lowered.startswith("#"):
            color = _parse_color(value)
            if color is not None:
                tokens.colors[name] = color
            continue
        if lowered.startswith("0x"):
            number = _parse_number(value[2:])
            if number is not None:
                tokens.lengths[name] = number
            continue
        if name.startswith("shadow"):
            tokens.shadows[name] = _parse_shadow(value)
            continue
        if "," in value or lowered.startswith('"'):
            tokens.fonts[name] = _parse_font_stack(value)
            continue
        number = _parse_number(value)
        if number is not None:
            if name.startswith("weight"):
                tokens.weights[name] = int(number)
            else:
                tokens.lengths[name] = number
            continue
        tokens.raw[name] = value

    return tokens


def camel_case(css_name: str) -> str:
    """`--zode-orange-bright` -> `zodeOrangeBright`; `--space-1` -> `space1`."""
    parts = [p for p in re.split(r"[-_]+", css_name) if p]
    if not parts:
        return "value"
    head = parts[0]
    tail = "".join(p[:1].upper() + p[1:] for p in parts[1:])
    name = head + tail
    if name[0].isdigit():
        name = "v" + name
    return name


def swift_type_name(css_name: str) -> str:
    """`--zode-orange-bright` -> `ZodeOrangeBright`."""
    parts = [p for p in re.split(r"[-_]+", css_name) if p]
    return "".join(p[:1].upper() + p[1:] for p in parts)
