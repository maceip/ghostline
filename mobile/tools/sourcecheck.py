#!/usr/bin/env python3
"""Source-level checks shared by the iOS and Android verifiers.

Standard library only. It provides:

  * `strip_comments_and_strings()` -- removes comments and string literals
    (including the interpolations inside them) so brace counting is honest;
  * `balance()` -- the remaining (), {} and [] counts;
  * `extract_quoted()` -- every quoted string in a block of text;
  * `extract_block()` -- the text between two markers.

Nothing here parses a language; it is a sanity net, not a compiler.
"""

from __future__ import annotations

import re
from typing import Dict, List, Tuple

QUOTED_RE = re.compile(r'"((?:[^"\\]|\\.)*)"')


def _skip_interpolation(source: str, index: int, language: str) -> int:
    """Skip an interpolated expression, e.g. `\\(expr)` or `${expr}`."""
    if language == "swift":
        if source.startswith("\\(", index):
            index += 2
            depth = 1
            while index < len(source) and depth > 0:
                character = source[index]
                if character == "(":
                    depth += 1
                elif character == ")":
                    depth -= 1
                elif character == '"':
                    index = _skip_string(source, index, language)
                    continue
                index += 1
            return index
        return index

    # Kotlin: `${expr}`
    if source.startswith("${", index):
        index += 2
        depth = 1
        while index < len(source) and depth > 0:
            character = source[index]
            if character == "{":
                depth += 1
            elif character == "}":
                depth -= 1
            elif character == '"':
                index = _skip_string(source, index, language)
                continue
            index += 1
        return index
    return index


def _skip_string(source: str, index: int, language: str) -> int:
    """Skip a string literal starting at `index` (the opening quote)."""
    index += 1
    while index < len(source):
        character = source[index]
        if character == "\\":
            index += 2
            continue
        if character == '"':
            return index + 1
        if language == "swift" and character == "(" and index > 0 and source[index - 1] == "\\":
            index = _skip_interpolation(source, index - 1, language)
            continue
        if language == "kotlin" and character == "$":
            if source.startswith("${", index):
                index = _skip_interpolation(source, index, language)
                continue
            # A bare '$' (e.g. "$taskID-m0") is not an interpolation -- it is
            # just a character. Skipping it as one would loop forever.
            index += 1
            continue
        index += 1
    return index


def strip_comments_and_strings(source: str, language: str) -> str:
    """Remove comments and string literals so brackets can be counted."""
    out: List[str] = []
    index = 0
    length = len(source)

    while index < length:
        character = source[index]

        if character == "/" and index + 1 < length and source[index + 1] == "/":
            end = source.find("\n", index)
            index = length if end < 0 else end
            continue

        if character == "/" and index + 1 < length and source[index + 1] == "*":
            end = source.find("*/", index + 2)
            index = length if end < 0 else end + 2
            continue

        if character == '"':
            index = _skip_string(source, index, language)
            out.append('""')
            continue

        if character == "'" and language == "kotlin":
            # A character literal.
            end = source.find("'", index + 1)
            if end > 0 and end - index <= 4:
                index = end + 1
                out.append("''")
                continue

        out.append(character)
        index += 1

    return "".join(out)


def balance(source: str, language: str) -> Dict[str, int]:
    """The number of (), {} and [] left over in the source."""
    stripped = strip_comments_and_strings(source, language)
    return {
        "(": stripped.count("(") - stripped.count(")"),
        "{": stripped.count("{") - stripped.count("}"),
        "[": stripped.count("[") - stripped.count("]"),
    }


def extract_quoted(text: str) -> List[str]:
    """Every double-quoted string in `text`, in order."""
    return [match.group(1) for match in QUOTED_RE.finditer(text)]


def extract_block(text: str, start_marker: str, end_marker: str) -> str:
    """The text between two markers (inclusive of the markers)."""
    start = text.find(start_marker)
    if start < 0:
        raise ValueError("Missing marker %r" % start_marker)
    end = text.find(end_marker, start)
    if end < 0:
        raise ValueError("Missing marker %r" % end_marker)
    return text[start:end + len(end_marker)]


def find_all(text: str, needle: str) -> List[int]:
    """Every offset of `needle` in `text`."""
    offsets: List[int] = []
    start = text.find(needle)
    while start >= 0:
        offsets.append(start)
        start = text.find(needle, start + 1)
    return offsets


def line_of(text: str, offset: int) -> int:
    return text.count("\n", 0, offset) + 1
