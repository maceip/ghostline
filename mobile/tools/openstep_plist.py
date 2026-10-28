#!/usr/bin/env python3
"""A minimal OpenStep property list parser (the format Xcode uses).

`plistlib` only understands XML and binary plists, and `plutil` is not
available on Linux, so the `project.pbxproj` parser lives here.

Supported:
  * dictionaries   { key = value; ... }
  * arrays         ( value, value, ... )
  * quoted strings "..." with \\ escapes
  * bare strings   [A-Za-z0-9_$/:.-]+
  * comments       /* ... */ and // ...

Standard library only.
"""

from __future__ import annotations

from typing import Any, Dict, List, Tuple

BARE_CHARS = set(
    "abcdefghijklmnopqrstuvwxyz"
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    "0123456789"
    "_$./:-"
)


class ParseError(ValueError):
    pass


class _Parser:
    def __init__(self, text: str) -> None:
        self.text = text
        self.position = 0

    # -- helpers -------------------------------------------------------
    def error(self, message: str) -> ParseError:
        line = self.text.count("\n", 0, self.position) + 1
        return ParseError("%s (line %d, offset %d)" % (message, line, self.position))

    def skip_whitespace(self) -> None:
        text = self.text
        while self.position < len(text):
            character = text[self.position]
            if character in " \t\r\n":
                self.position += 1
                continue
            if text.startswith("/*", self.position):
                end = text.find("*/", self.position + 2)
                if end < 0:
                    raise self.error("Unterminated comment")
                self.position = end + 2
                continue
            if text.startswith("//", self.position):
                end = text.find("\n", self.position)
                self.position = len(text) if end < 0 else end
                continue
            break

    def peek(self) -> str:
        if self.position >= len(self.text):
            return ""
        return self.text[self.position]

    # -- values -------------------------------------------------------
    def parse_value(self) -> Any:
        self.skip_whitespace()
        character = self.peek()
        if character == "{":
            return self.parse_dict()
        if character == "(":
            return self.parse_array()
        if character == '"':
            return self.parse_quoted()
        if character == "":
            raise self.error("Unexpected end of input")
        return self.parse_bare()

    def parse_dict(self) -> Dict[str, Any]:
        assert self.peek() == "{"
        self.position += 1
        result: Dict[str, Any] = {}
        while True:
            self.skip_whitespace()
            character = self.peek()
            if character == "}":
                self.position += 1
                return result
            if character == "":
                raise self.error("Unterminated dictionary")
            key = self.parse_value()
            self.skip_whitespace()
            if self.peek() != "=":
                raise self.error("Expected '=' after key %r" % (key,))
            self.position += 1
            value = self.parse_value()
            self.skip_whitespace()
            # The semicolon is NOT optional.  Xcode refuses to open a
            # project whose dictionary is missing one, and it reports it as
            # a parse error rather than pointing at the real cause -- an
            # unquoted `$(...)` in a build setting, for instance, is read
            # as the bare string `$` followed by a stray parenthesis.
            if self.peek() != ";":
                raise self.error("Missing ';' after the value of %r" % (key,))
            self.position += 1
            result[key] = value

    def parse_array(self) -> List[Any]:
        assert self.peek() == "("
        self.position += 1
        result: List[Any] = []
        while True:
            self.skip_whitespace()
            character = self.peek()
            if character == ")":
                self.position += 1
                return result
            if character == "":
                raise self.error("Unterminated array")
            result.append(self.parse_value())
            self.skip_whitespace()
            if self.peek() == ",":
                self.position += 1

    def parse_quoted(self) -> str:
        assert self.peek() == '"'
        self.position += 1
        chunks: List[str] = []
        while True:
            if self.position >= len(self.text):
                raise self.error("Unterminated string")
            character = self.text[self.position]
            if character == "\\":
                self.position += 1
                if self.position >= len(self.text):
                    raise self.error("Unterminated escape")
                escape = self.text[self.position]
                mapping = {
                    "n": "\n",
                    "t": "\t",
                    "r": "\r",
                    '"': '"',
                    "\\": "\\",
                    "U": "\\U",
                }
                chunks.append(mapping.get(escape, escape))
                self.position += 1
                continue
            if character == '"':
                self.position += 1
                return "".join(chunks)
            chunks.append(character)
            self.position += 1

    def parse_bare(self) -> str:
        start = self.position
        chunks: List[str] = []
        while self.position < len(self.text):
            character = self.text[self.position]
            if character in BARE_CHARS:
                chunks.append(character)
                self.position += 1
                continue
            break
        if not chunks:
            raise self.error("Unexpected character %r" % self.peek())
        return "".join(chunks)


def loads(text: str) -> Dict[str, Any]:
    """Parse an OpenStep property list document."""
    # The Xcode header comment `// !$*UTF8*$!` is handled by skip_whitespace.
    parser = _Parser(text)
    value = parser.parse_value()
    parser.skip_whitespace()
    if parser.position != len(parser.text):
        raise parser.error("Trailing content")
    if not isinstance(value, dict):
        raise ParseError("The root object must be a dictionary")
    return value


def walk_strings(value: Any) -> List[str]:
    """Every string inside a parsed document, in document order."""
    found: List[str] = []
    if isinstance(value, str):
        found.append(value)
    elif isinstance(value, list):
        for item in value:
            found.extend(walk_strings(item))
    elif isinstance(value, dict):
        for key, item in value.items():
            found.append(key)
            found.extend(walk_strings(item))
    return found
