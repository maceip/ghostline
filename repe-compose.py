#!/usr/bin/env python3
"""Compose upgrade_generic_viz.sh from the durable module workspace.

The generator script is the shipped, self-contained source of truth. This
composer is the editing surface: module sources live in `repe-mods/` (inside
the repo, safe from /tmp wipes), and `repe-compose.py` re-assembles them into
`upgrade_generic_viz.sh`.

Layout:
  repe-mods/_generator.template   shell scaffolding with @@NAME@@ markers
  repe-mods/<path>                one file per generated file

Usage:
  python3 repe-compose.py            # rebuild upgrade_generic_viz.sh
  python3 repe-compose.py --check    # verify the generator is up to date
"""
import argparse
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent
MODS = ROOT / "repe-mods"
TEMPLATE = MODS / "_generator.template"
OUT = ROOT / "upgrade_generic_viz.sh"

HEREDOC = re.compile(
    r"^cat << '([A-Z_0-9]+)' > \"\$PROJ/([^\"]+)\"\n(.*?)\n\1\n",
    re.MULTILINE | re.DOTALL,
)


def parse_generator(text):
    """Split a generator script into (prefix, [(name, path, body)], suffix)."""
    sections = []
    pos = 0
    prefix = None
    suffix = None
    for m in HEREDOC.finditer(text):
        name, path, body = m.group(1), m.group(2), m.group(3)
        if prefix is None:
            prefix = text[: m.start()]
        else:
            sections.append((name, path, body))
        pos = m.end()
    # The last heredoc body must be followed by the suffix; sections collected
    # above skip the first match (used to derive `prefix`), so recompute.
    sections = []
    for m in HEREDOC.finditer(text):
        sections.append((m.group(1), m.group(2), m.group(3)))
    suffix = text[pos:]
    return prefix, sections, suffix


def build():
    if not TEMPLATE.exists():
        sys.exit(f"missing template: {TEMPLATE}")
    mapping = json.loads((MODS / "_sections.json").read_text())
    tpl = TEMPLATE.read_text()
    used = set()

    def repl(m):
        name = m.group(1)
        used.add(name)
        p = MODS / mapping[name]
        if not p.exists():
            sys.exit(f"module missing for @@{name}@@: {p}")
        body = p.read_text()
        # Module files are stored as BODY + "\n"; the heredoc delimiter line
        # supplies the other newline, so strip exactly one here.
        if body.endswith("\n"):
            body = body[:-1]
        return body

    out = re.sub(r"@@([A-Z_0-9]+)@@", repl, tpl)
    missing = set(re.findall(r"@@([A-Z_0-9]+)@@", tpl)) - used
    if missing:
        sys.exit(f"template markers never resolved: {sorted(missing)}")
    out = emit_extra_sections(out)
    return drop_absent_bins(out)


BIN_BLOCK = re.compile(
    r'\[\[bin\]\]\nname = "([^"]+)"\npath = "([^"]+)"\n')

# Modules added after the generator's original 23 sections. Each entry is
# (section header, heredoc name, module path inside repe-mods/, project
# target inside $PROJ). They are emitted in this order, just before the
# archive step.
EXTRA_SECTIONS = [
    ("src/whiten.rs", "WHITEN", "src/whiten.rs", "src/whiten.rs"),
    ("src/trajectory.rs", "TRAJECTORY", "src/trajectory.rs", "src/trajectory.rs"),
    ("src/bin/whiten_check.rs", "WHITEN_CHECK", "src/bin/whiten_check.rs",
     "src/bin/whiten_check.rs"),
    ("tools/whiten_reference.py", "WHITEN_REF", "tools/whiten_reference.py",
     "tools/whiten_reference.py"),
    ("src/capability.rs", "CAPABILITY", "src/capability.rs", "src/capability.rs"),
    ("src/bin/capability_tool.rs", "CAPABILITY_TOOL",
     "src/bin/capability_tool.rs", "src/bin/capability_tool.rs"),
    ("tools/touchid_stepup.swift", "TOUCHID", "tools/touchid_stepup.swift",
     "tools/touchid_stepup.swift"),
    ("tools/capability_runner.sh", "CAPABILITY_RUNNER",
     "tools/capability_runner.sh", "tools/capability_runner.sh"),
    ("tools/capability_check.py", "CAPABILITY_CHECK",
     "tools/capability_check.py", "tools/capability_check.py"),
    ("src/site_calibration.rs", "SITE_CALIBRATION",
     "src/site_calibration.rs", "src/site_calibration.rs"),
    ("src/bin/site_calibrate.rs", "SITE_CALIBRATE",
     "src/bin/site_calibrate.rs", "src/bin/site_calibrate.rs"),
    ("src/rollback.rs", "ROLLBACK", "src/rollback.rs", "src/rollback.rs"),
    ("src/bin/rollback_probe.rs", "ROLLBACK_PROBE",
     "src/bin/rollback_probe.rs", "src/bin/rollback_probe.rs"),
    ("src/access.rs", "ACCESS", "src/access.rs", "src/access.rs"),
]

ARCHIVE_ANCHOR = "# 24. Archive"


def emit_extra_sections(generator: str) -> str:
    """Insert the extra module sections before the archive step."""
    blocks = []
    for index, (header, name, module_rel, target) in enumerate(EXTRA_SECTIONS, start=25):
        path = MODS / module_rel
        if not path.exists():
            continue
        body = path.read_text().rstrip("\n")
        # A heredoc creates the file 0644; scripts that are meant to be run
        # directly need their executable bit back.
        chmod = ""
        if target.endswith(".sh") or target.endswith(".py"):
            chmod = f'chmod +x "$PROJ/{target}"\n'
        blocks.append(
            f"# ------------------------------------------------------------------------------\n"
            f"# {index}. {header}\n"
            f"# ------------------------------------------------------------------------------\n"
            f"cat << '{name}' > \"$PROJ/{target}\"\n"
            f"{body}\n"
            f"{name}\n"
            f"{chmod}\n"
        )
    if not blocks:
        return generator
    marker = ARCHIVE_ANCHOR
    idx = generator.find(marker)
    if idx < 0:
        sys.exit("cannot find the archive anchor in the template")
    # Insert before the rule comment line that precedes the anchor.
    rule = generator.rfind("# ---", 0, idx)
    if rule < 0:
        rule = idx
    return generator[:rule] + "".join(blocks) + generator[rule:]


def drop_absent_bins(generator: str) -> str:
    """Remove [[bin]] entries whose source module is not in the workspace.

    A binary that has not been written yet must not break the build of
    everything else, so the entry is dropped until its source appears.
    """
    def repl(m):
        if (MODS / m.group(2)).exists():
            return m.group(0)
        return ""
    return BIN_BLOCK.sub(repl, generator)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--init-template", action="store_true",
                    help="(re)build the template from the current generator")
    args = ap.parse_args()

    if args.init_template:
        gen = OUT.read_text()
        MODS.mkdir(parents=True, exist_ok=True)
        prefix, sections, suffix = parse_generator(gen)
        if not sections:
            sys.exit("no heredoc sections found in generator")
        # Prefix + suffix are the shared scaffolding; the per-section comment
        # blocks live between sections, so rebuild the template by replacing
        # each heredoc body with a marker and keeping everything else.
        tpl = HEREDOC.sub(
            lambda m: f"cat << '{m.group(1)}' > \"$PROJ/{m.group(2)}\"\n@@{m.group(1)}@@\n{m.group(1)}\n",
            gen,
        )
        TEMPLATE.write_text(tpl)
        MODS.mkdir(parents=True, exist_ok=True)
        mapping = {}
        for name, path, body in sections:
            # The template keeps the original write target (e.g. the Python
            # extractor lives at $PROJ/../extract_repe_vectors.py), but the
            # editable module copy always lives inside repe-mods/.
            module_rel = path.lstrip("./") if path.startswith("../") else path
            dest = MODS / module_rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_text(body + "\n")
            mapping[name] = module_rel
        (MODS / "_sections.json").write_text(
            json.dumps(mapping, indent=1, sort_keys=True) + "\n")
        print(f"template + {len(sections)} modules written to {MODS}")
        return

    out = build()
    if args.check:
        cur = OUT.read_text() if OUT.exists() else ""
        if cur == out:
            print("generator up to date")
            return
        print("generator is STALE (re-run without --check)", file=sys.stderr)
        sys.exit(1)

    OUT.write_text(out)
    print(f"wrote {OUT} ({len(out)} bytes)")


if __name__ == "__main__":
    main()
