#!/usr/bin/env python3
"""Cross-check the macOS shell against the web app it hosts.

The web app (`apps/web`) is the other half of contract v1: it decides which
request types, intent names, error codes, attachment sources and event names
exist. This script reads those lists out of the web app's
`src/bridge/contract.js` and asserts that the shell implements every single
one of them — a mismatch would be a silent, hard to debug bridge bug.

Usage:
    python3 tools/verify_against_web.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SHELL_ROOT = HERE.parent
REPO_ROOT = SHELL_ROOT.parent.parent
WEB_ROOT = REPO_ROOT
CONTRACT_JS = WEB_ROOT / "src" / "bridge" / "contract.js"

SOURCE_ROOT = SHELL_ROOT / "Zode"

# The frozen lists of the web app -> the shell file that has to implement them.
CHECKS: list[tuple[str, str, str]] = [
    ("REQUEST_TYPES", "Bridge/ZodeBridge.swift",
     "every request type of contract §3"),
    ("INTENT_NAMES", "Services/IntentRouter.swift",
     "every intent name of contract §4"),
    ("ERROR_CODES", "Bridge/ZodeEnvelope.swift",
     "every error code of contract §1.2"),
    ("ATTACHMENT_SOURCES", "Attachments/Attachment.swift",
     "every attachment source of contract §2.1"),
    ("SEARCH_RESULT_KINDS", "Services/SearchService.swift",
     "every search result kind of contract §2.1"),
    ("CAPABILITY_KEYS", "Bridge/ZodeBridge.swift",
     "every capability key of contract §2"),
    ("VIEW_NAMES", "Intents/ZodeIntents.swift",
     "every view name of contract §4 (zode.show)"),
]

# The native events the web app listens for (src/bridge/zode.js).
EVENT_NAMES = ["attachment", "intent", "search", "deepLink", "notificationAction"]


def read_list(source: str, name: str) -> list[str]:
    """Reads a frozen string array out of the web app's contract.js."""
    match = re.search(
        r"export const %s\s*=\s*Object\.freeze\(\[(.*?)\]\)" % re.escape(name),
        source,
        re.S,
    )
    if not match:
        raise SystemExit(f"error: could not find '{name}' in {CONTRACT_JS}")
    return re.findall(r"'([^']+)'", match.group(1))


def main() -> int:
    if not CONTRACT_JS.exists():
        print(f"FAIL  the web app was not found at {CONTRACT_JS}")
        return 1

    contract_source = CONTRACT_JS.read_text(encoding="utf-8")
    zode_source = (SOURCE_ROOT / "Bridge" / "ZodeBridge.swift").read_text(encoding="utf-8")
    web_bridge = "\n".join(
        path.read_text(encoding="utf-8")
        for path in sorted((WEB_ROOT / "src" / "bridge").glob("*.js"))
    )

    failures: list[str] = []
    passed = 0

    print(f"cross-checking the shell against {CONTRACT_JS.relative_to(REPO_ROOT)}")
    print()

    for name, relative, description in CHECKS:
        names = read_list(contract_source, name)
        source = (SOURCE_ROOT / relative).read_text(encoding="utf-8")
        missing = [item for item in names if item not in source]
        if missing:
            failures.append(f"{name}: the shell does not implement {missing}")
            print(f"  FAIL  {name:20s} {len(names) - len(missing)}/{len(names)} — missing {missing}")
        else:
            passed += 1
            print(f"  ok    {name:20s} {len(names)}/{len(names)} — {description}")

    # The event names the web app subscribes to.
    missing_events = [
        event for event in EVENT_NAMES
        if not (f'"{event}"' in zode_source or f"'{event}'" in zode_source)
        or not (f'"{event}"' in web_bridge or f"'{event}'" in web_bridge)
    ]
    if missing_events:
        failures.append(f"the event names {missing_events} are not implemented on both sides")
        print(f"  FAIL  {'EVENT_NAMES':20s} missing {missing_events}")
    else:
        passed += 1
        print(f"  ok    {'EVENT_NAMES':20s} {len(EVENT_NAMES)}/{len(EVENT_NAMES)} — "
              f"attachment, intent, search, deepLink, notificationAction")

    # The script message handler name (contract §1.1).
    if 'handlerName = "zode"' not in zode_source:
        failures.append("the script message handler is not named 'zode'")
        print("  FAIL  handler name")
    elif "messageHandlers.zode" not in web_bridge:
        failures.append("the web app does not post to 'webkit.messageHandlers.zode'")
        print("  FAIL  handler name")
    else:
        passed += 1
        print("  ok    {'handler name':20s} the handler is called 'zode' on both sides")

    # The origin: the bridge modules must only use relative imports so they work
    # under the `zode://app/` scheme.
    absolute = []
    for path in list((WEB_ROOT / "src" / "bridge").rglob("*.js")):
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if re.search(r"""(?:src|href)\s*=\s*["']/""", line):
                absolute.append(f"{path.name}:{number}")
    if absolute:
        failures.append(f"the web bridge uses absolute paths ({absolute[:3]}) — they break under zode://app/")
        print(f"  FAIL  {'relative paths':20s} {absolute[:3]}")
    else:
        passed += 1
        print(f"  ok    {'relative paths':20s} the web bridge only uses relative paths (zode://app/ works)")

    # The drag zone height (contract §5.3) must be the same everywhere.
    tokens = (REPO_ROOT / "packages" / "shared" / "tokens.css").read_text(encoding="utf-8")
    token_height = re.search(r"--drag-zone-height:\s*(\d+)px", tokens)
    web_height = re.search(r"DRAG_ZONE_HEIGHT\s*=\s*(\d+)", contract_source)
    if not token_height or not web_height or token_height.group(1) != web_height.group(1):
        failures.append("the drag zone height differs between tokens.css and the web app")
        print("  FAIL  {'drag zone':20s} the heights differ")
    else:
        passed += 1
        print(f"  ok    {'drag zone':20s} --drag-zone-height = {token_height.group(1)}px on both sides")

    print()
    if failures:
        for failure in failures:
            print(f"  FAIL  {failure}")
        print(f"\n{len(failures)} problem(s) found")
        return 1
    print(f"all {passed} cross-checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
