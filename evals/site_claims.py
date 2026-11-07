#!/usr/bin/env python3
"""Check that the site's headline numbers are the ones the data supports.

The public site states things like "17/18 findings blocked, 0/18 false
positives".  A number on a marketing page is a claim, and a claim is only
worth what backs it.  The backing here is `clef-site/data/replay.json` —
36 real readings captured from a running guard, shipped with the site.

So this recomputes the claims from that file and compares them with what the
page actually says.  If the dataset is re-captured and the numbers move,
this fails until the page is updated — which is the point.  A page whose
numbers have drifted away from its own evidence is worse than a page with no
numbers.

Usage:
    python3 evals/site_claims.py
"""
from __future__ import annotations

import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATASET = ROOT / "clef-site" / "data" / "replay.json"
INDEX = ROOT / "clef-site" / "index.html"
DESIGN = ROOT / "clef-site" / "DESIGN.md"

results: list[tuple[bool, str, str]] = []


def check(ok: bool, name: str, detail: str = "") -> bool:
    results.append((ok, name, detail))
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f"  — {detail}" if detail else ""))
    return ok


def main() -> int:
    if not DATASET.is_file():
        print(f"no dataset at {DATASET}", file=sys.stderr)
        return 2
    if not INDEX.is_file():
        print(f"no story page at {INDEX}", file=sys.stderr)
        return 2

    data = json.loads(DATASET.read_text())
    records = data.get("records", [])
    if not records:
        print("the dataset has no records", file=sys.stderr)
        return 2

    harmful = [r for r in records if r.get("label") == "harmful"]
    benign = [r for r in records if r.get("label") == "benign"]
    blocked = [r for r in harmful if not r.get("verdict", {}).get("allowed", True)]
    false_positives = [r for r in benign if not r.get("verdict", {}).get("allowed", True)]
    missed = [r for r in harmful if r.get("verdict", {}).get("allowed", True)]

    got = f"{len(blocked)}/{len(harmful)}"
    got_fp = f"{len(false_positives)}/{len(benign)}"

    print(f"dataset: {len(records)} records — {len(harmful)} harmful, {len(benign)} benign")
    print(f"        captured {data.get('captured_at')} from {data.get('source')}")

    page = INDEX.read_text()

    check(
        len(harmful) and len(benign),
        "the dataset has both harmful and benign calls",
        f"{len(harmful)} harmful, {len(benign)} benign",
    )
    check(
        f"{got}" in page and f"{got_fp}" in page,
        f"the page states the numbers the data supports ({got} blocked, {got_fp} false positives)",
        f"the page carries {got} and {got_fp}",
    )
    # Both renderings of the numbers appear on the page: "17 / 18" in the
    # hero stat block and "17/18" in the proof claim.  A page that shows one
    # but not the other is a page that was edited in one place only.
    for form in (got, got.replace("/", " / ")):
        check(
            form in page,
            f"the page carries the number in the form {form!r}",
            "present" if form in page else "missing",
        )

    # The page names the one that got through.  That claim has to be true
    # too: it is the most specific thing the page says.
    if missed:
        named = re.search(r"slipped through[^<]*—\s*<code>([^<]+)</code>", page)
        claimed = named.group(1).strip() if named else ""
        actual = missed[0].get("call_render", "")
        check(
            claimed and claimed in actual,
            "the call the page names as the one that got through is the one that got through",
            f"the page names {claimed!r}; the data says {actual!r}",
        )
    else:
        check(
            True,
            "the call the page names as the one that got through is the one that got through",
            "nothing got through, so there is nothing to name",
        )

    # The depth claim.  The page says the reading is taken at a fraction of
    # the decoder's depth; the dataset says how many layers the model has
    # and which one the probe sits on.
    info = data.get("info", {})
    num_layers = info.get("num_layers")
    summary = info.get("weight_quant_summary", "")
    match = re.search(r"layer_(\d+)_mlp", summary)
    probe_layer = int(match.group(1)) if match else None
    if num_layers and probe_layer is not None:
        pct = round(probe_layer / num_layers * 100)
        claimed_pcts = {int(m) for m in re.findall(r"(\d{2})\s*(?:<[^>]*>)?\s*%", page)}
        check(
            pct in claimed_pcts,
            f"the page's depth claim matches the model ({probe_layer} of {num_layers} layers = {pct}%)",
            f"the page claims {sorted(claimed_pcts)}%",
        )
        # And the documents that repeat the number have to repeat it too.
        if DESIGN.is_file():
            design = DESIGN.read_text()
            design_pcts = {int(m) for m in re.findall(r"(\d{2})% depth", design)}
            check(
                not design_pcts or pct in design_pcts,
                "the design document agrees with the page about the depth",
                f"the design document says {sorted(design_pcts)}%",
            )
    else:
        check(
            False,
            "the page's depth claim matches the model",
            "the dataset does not say which layer the probe sits on",
        )

    passed = sum(1 for ok, _, _ in results if ok)
    failed = sum(1 for ok, _, _ in results if not ok)
    print(f"\n{passed}/{passed + failed} checks passed")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
