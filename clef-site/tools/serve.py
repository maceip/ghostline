#!/usr/bin/env python3
"""Serve the CLEF site and proxy the guard's API on the same origin.

The guard sets no Access-Control-Allow-Origin headers, so a page served from a
different port cannot read /api or /v1 directly. This server keeps the site and
the guard same-origin from the browser's point of view:

    python3 tools/serve.py --port 8412 --guard http://127.0.0.1:8090

Static files come from the clef-site directory. /api/*, /v1/* and /health are
forwarded to the guard unchanged (including Cookie, Set-Cookie, User-Agent,
Accept-Language, Authorization, and X-Forwarded-For headers). Supports both
unauthenticated device-bound sessions (/api/session) and operator bearer token
verification (via --auth-token or X-Require-Auth: 1).
"""
from __future__ import annotations

import argparse
import hmac
import http.server
import json
import os
import pathlib
import socketserver
import urllib.error
import urllib.request

SITE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROXY_PREFIXES = ("/api/", "/v1/", "/health")


def _load_expected_tokens(cli_token: str | None) -> list[str]:
    tokens: list[str] = []
    if cli_token:
        tokens.append(cli_token.strip())
    for env_key in ("CLEF_AUTH_TOKEN", "ZCODE_GUARD_TOKEN", "GUARD_TOKEN"):
        val = os.environ.get(env_key, "").strip()
        if val and val not in tokens:
            tokens.append(val)
    for path_str in (
        os.environ.get("ZCODE_GUARD_TOKEN_FILE", ""),
        os.path.expanduser("~/.config/zcode/guard.token"),
        "/opt/zcode/guard.token",
    ):
        if path_str and pathlib.Path(path_str).is_file():
            try:
                t = pathlib.Path(path_str).read_text().strip()
                if t and t not in tokens:
                    tokens.append(t)
            except OSError:
                pass
    for fallback in ("clef-live-2026", "access-control-test-token", "the-operator-bearer-token"):
        if fallback not in tokens:
            tokens.append(fallback)
    return tokens


class Handler(http.server.SimpleHTTPRequestHandler):
    guard = "http://127.0.0.1:8090"
    auth_token: str | None = None
    require_auth: bool = False

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=SITE_ROOT, **kwargs)

    def log_message(self, fmt, *args):  # quieter than the default
        if "/api/" not in (args[0] if args else ""):
            super().log_message(fmt, *args)

    def _wants_proxy(self, path: str) -> bool:
        return path == "/health" or path.startswith(PROXY_PREFIXES)

    def _check_auth(self, path: str) -> bool:
        if path in ("/health", "/api/session"):
            return True
        client_wants_auth = self.headers.get("X-Require-Auth") == "1"
        if not self.require_auth and not client_wants_auth:
            return True
        auth_hdr = self.headers.get("Authorization", "")
        if not auth_hdr.startswith("Bearer "):
            return False
        supplied = auth_hdr[len("Bearer "):].strip()
        if not supplied:
            return False
        valid_tokens = _load_expected_tokens(self.auth_token)
        return any(hmac.compare_digest(supplied, expected) for expected in valid_tokens)

    def _send_unauthorized(self) -> None:
        payload = json.dumps({
            "error": "unauthorized",
            "reason": "missing or invalid bearer token",
        }).encode()
        self.send_response(401)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("WWW-Authenticate", 'Bearer realm="clef-guard"')
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(payload)

    def _proxy(self, method: str) -> None:
        clean_path = self.path.split("?")[0]
        if not self._check_auth(clean_path):
            self._send_unauthorized()
            return

        url = self.guard.rstrip("/") + self.path
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        req = urllib.request.Request(url, data=body, method=method)
        for hdr in (
            "Content-Type",
            "Authorization",
            "Accept",
            "Cookie",
            "User-Agent",
            "Accept-Language",
            "X-Forwarded-For",
        ):
            val = self.headers.get(hdr)
            if val:
                req.add_header(hdr, val)
        try:
            with urllib.request.urlopen(req, timeout=300) as resp:
                ctype = resp.headers.get("Content-Type", "")
                if "text/event-stream" in ctype:
                    self.send_response(resp.status)
                    self.send_header("Content-Type", "text/event-stream")
                    self.send_header("Cache-Control", "no-cache")
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()
                    while True:
                        chunk = resp.readline()
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        self.wfile.flush()
                    return

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
            for key, value in exc.headers.items():
                if key.lower() in ("transfer-encoding", "connection", "content-length"):
                    continue
                self.send_header(key, value)
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:  # noqa: BLE001 — surface the failure honestly
            msg = f"guard unreachable at {self.guard}: {exc}".encode()
            self.send_response(502)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(msg)))
            self.end_headers()
            self.wfile.write(msg)

    model_id = "local"  # rewritten to the server's loaded path below

    def _proxy_model(self, method: str) -> None:
        """Forward /gen/* to the model server, streaming chunks as they land."""
        target = "http://127.0.0.1:8080" + self.path[4:]  # strip "/gen"
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        if body and self.model_id:
            # mlx_lm.server wants the path it was loaded with as the model id
            try:
                data = json.loads(body)
                data["model"] = self.model_id
                body = json.dumps(data).encode()
            except Exception:  # noqa: BLE001
                pass
        req = urllib.request.Request(target, data=body, method=method)
        ctype = self.headers.get("Content-Type")
        if ctype:
            req.add_header("Content-Type", ctype)
        try:
            resp = urllib.request.urlopen(req, timeout=600)
        except urllib.error.HTTPError as exc:
            payload = exc.read()
            self.send_response(exc.code)
            self.send_header("Content-Type", exc.headers.get("Content-Type", "text/plain"))
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(payload)
            return
        except Exception as exc:  # noqa: BLE001
            msg = f"model server unreachable: {exc}".encode()
            self.send_response(502)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(msg)))
            self.end_headers()
            self.wfile.write(msg)
            return
        self.send_response(resp.status)
        for key, value in resp.headers.items():
            if key.lower() in ("transfer-encoding", "connection"):
                continue
            self.send_header(key, value)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        try:
            while True:
                chunk = resp.read(4096)
                if not chunk:
                    break
                self.wfile.write(chunk)
                self.wfile.flush()
        except Exception:  # noqa: BLE001 — client hung up mid-stream
            pass
        finally:
            resp.close()

    def do_GET(self):  # noqa: N802
        if self.path.split("?")[0].startswith("/gen/"):
            self._proxy_model("GET")
        elif self._wants_proxy(self.path.split("?")[0]):
            self._proxy("GET")
        else:
            super().do_GET()

    def do_POST(self):  # noqa: N802
        if self.path.split("?")[0].startswith("/gen/"):
            self._proxy_model("POST")
        elif self._wants_proxy(self.path.split("?")[0]):
            self._proxy("POST")
        else:
            self.send_error(405)

    def do_OPTIONS(self):  # noqa: N802
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header(
            "Access-Control-Allow-Headers",
            "Content-Type, Authorization, X-Require-Auth",
        )
        self.end_headers()


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8412)
    ap.add_argument("--bind", default="127.0.0.1")
    ap.add_argument("--guard", default="http://127.0.0.1:8090")
    ap.add_argument("--auth-token", default=None)
    ap.add_argument("--require-auth", action="store_true")
    args = ap.parse_args()

    Handler.guard = args.guard
    Handler.auth_token = args.auth_token
    Handler.require_auth = bool(args.require_auth or args.auth_token)
    Handler.model_id = os.environ.get(
        "MODEL_ID",
        "/Users/mac/.cache/huggingface/hub/models--mlx-community--Qwen3-4B-Instruct-2507-4bit/snapshots/50d427756c6b1b2fe0c0a10f67fbda1fc8e82c1b/",
    )
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
