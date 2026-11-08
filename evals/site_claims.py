#!/usr/bin/env python3
"""Check that every number the exhibit states in its static copy is backed.

Live numbers come from the guard at request time and the scoreboard is rendered
from clef-site/data/heldout.json, so the page itself should carry only a few
static claims. Each one is recomputed here from its source:

  * "Tested on N commands"  <- len(heldout.json rows)
  * "N pairs of commands"   <- len(HARM_CONTRASTIVE_PAIRS) in extract_repe_vectors.py
  * "24 layers"             <- heldout.json engine.num_layers
  * no hardcoded "a/b" scoreboard ratios in index.html

Usage: python3 evals/site_claims.py
"""
import ast, json, pathlib, re, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
INDEX = (ROOT / "clef-site" / "index.html").read_text()
HELD = json.loads((ROOT / "clef-site" / "data" / "heldout.json").read_text())
SRC = (ROOT / "extract_repe_vectors.py").read_text()

pairs = None
for node in ast.parse(SRC).body:
    target = getattr(node, "target", None) or (getattr(node, "targets", [None])[0])
    if getattr(target, "id", None) == "HARM_CONTRASTIVE_PAIRS":
        pairs = len(node.value.elts)

checks = []
def check(ok, what):
    checks.append(ok)
    print(("PASS " if ok else "FAIL ") + what)

n_rows = len(HELD["rows"])
check(f"Tested on {n_rows} commands" in INDEX, f"page says 'Tested on {n_rows} commands'")
check(f"{n_rows} real commands" in INDEX, f"page says '{n_rows} real commands' on the alarm line")
check(pairs is not None and f"{pairs} pairs of commands" in INDEX, f"page says '{pairs} pairs of commands'")
layers = HELD["engine"]["num_layers"]
check(f"climbs through {layers} layers" in INDEX, f"page says 'climbs through {layers} layers'")
check(not re.search(r"\b\d{1,3}\s*/\s*\d{1,3}\b", re.sub(r"https?://\S+", "", INDEX)),
      "no hardcoded a/b ratios in index.html (the scoreboard renders from heldout.json)")
r = HELD["repe"]
check(r["harmful_total"] + r["benign_total"] == n_rows, "heldout.json totals add up")
check("calibrated" in HELD["engine"].get("calibration_mode", ""), "held-out run used calibrated vectors")

sys.exit(0 if all(checks) else 1)
