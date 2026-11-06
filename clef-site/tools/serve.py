#!/usr/bin/env python3
"""Serve the CLEF site and proxy the guard's API on the same origin.

The guard sets no Access-Control-Allow-Origin headers, so a page served from a
different port cannot read /api or /v1 directly. This server keeps the site and
the guard same-origin from the browser's point of view:

    python3 tools/serve.py --port 8412 --guard http://127.0.0.1:8090

Static files come from the clef-site directory. /api/*, /v1/* and /health are
forwarded to the guard unchanged. Point --guard at whichever engine is running;
nothing here invents data.
"""
from __future__ import annotations

import argparse
import http.server
import os
import socketserver
import urllib.error
import urllib.request

SITE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROXY_PREFIXES = ("/api/", "/v1/", "/health")


class Handler(http.server.SimpleHTTPRequestHandler):
    guard = "http://127.0.0.1:8090"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=SITE_ROOT, **kwargs)

    def log_message(self, fmt, *args):  # quieter than the default
        if "/api/" not in (args[0] if args else ""):
            super().log_message(fmt, *args)

    def _wants_proxy(self, path: str) -> bool:
        return path == "/health" or path.startswith(PROXY_PREFIXES)

    def _proxy(self, method: str) -> None:
        url = self.guard.rstrip("/") + self.path
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        req = urllib.request.Request(url, data=body, method=method)
        ctype = self.headers.get("Content-Type")
        if ctype:
            req.add_header("Content-Type", ctype)
        try:
            with urllib.request.urlopen(req, timeout=300) as resp:
                payload = resp.read()
                self.send_response(resp.status)
                for key, value in resp.headers.items():
                    if key.lower() in ("transfer-encoding", "connection"):
                        continue
                    self.send_header(key, value)
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(payload)
        except urllib.error.HTTPError as exc:
            payload = exc.read()
            self.send_response(exc.code)
            self.send_header("Content-Type", exc.headers.get("Content-Type", "text/plain"))
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(payload)
        except Exception as exc:  # noqa: BLE001 — surface the failure honestly
            msg = f"guard unreachable at {self.guard}: {exc}".encode()
            self.send_response(502)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(msg)))
            self.end_headers()
            self.wfile.write(msg)

    def do_GET(self):  # noqa: N802
        if self._wants_proxy(self.path.split("?")[0]):
            self._proxy("GET")
        else:
            super().do_GET()

    def do_POST(self):  # noqa: N802
        if self._wants_proxy(self.path.split("?")[0]):
            self._proxy("POST")
        else:
            self.send_error(405)

    def do_OPTIONS(self):  # noqa: N802
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8412)
    ap.add_argument("--bind", default="127.0.0.1")
    ap.add_argument("--guard", default="http://127.0.0.1:8090")
    args = ap.parse_args()

    Handler.guard = args.guard
    with Server((args.bind, args.port), Handler) as httpd:
        print(
            f"CLEF site on http://{args.bind}:{args.port}/ "
            f"(guard proxy → {args.guard})"
        )
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
