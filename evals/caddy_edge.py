#!/usr/bin/env python3
"""Prove that the public edge actually rate limits, keyed by client IP.

The deployment requirement is that the public site sheds load at Caddy, by
the address the proxy saw on the socket, BEFORE the request reaches the
model.  That is a claim about a Caddyfile, and a Caddyfile is exactly the
kind of thing that looks right and is not.

So this script runs the SHIPPED deploy/Caddyfile — unmodified, byte for
byte — against a real Caddy binary and a real HTTP backend, and checks:

  1. The shipped config loads on a Caddy that has the rate_limit module.
  2. A stock Caddy REFUSES the same file.  That refusal is the point: it
     means a box that was provisioned with the wrong binary fails loudly
     at parse time instead of serving an unprotected site.
  3. The shipped config is `caddy fmt` clean.
  4. A client that sends its own `X-Forwarded-For` cannot choose its own
     bucket — Caddy replaces the header with the address it saw.
  5. The limit sheds load BEFORE the backend: the 429 carries a
     Retry-After, and the backend never sees the rejected requests.
  6. The static site and /health are in NO zone, so a visitor is never
     throttled for loading a page and the liveness probe never is.

The limits are set through the Caddyfile's own environment knobs
(RL_TOOL_CALL_EVENTS and friends), so the file is exercised exactly as it
ships and the test does not have to edit it.

Usage:
    python3 evals/caddy_edge.py

Environment:
    ZCODE_CADDY_BIN  a Caddy binary that has the rate_limit module.
                     Defaults to /opt/zcode/bin/caddy, then to
                     /tmp/caddy-rl/caddy, then to `caddy` on PATH if that
                     build has the module.
    ZCODE_CADDY_STOCK  a stock Caddy, used only to prove the refusal.
    ZCODE_CADDYFILE  a different Caddyfile to test.  Used to prove that
                     these checks FAIL on a broken configuration; the default
                     is the shipped deploy/Caddyfile.
"""
from __future__ import annotations

import http.client
import json
import os
import pathlib
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = pathlib.Path(__file__).resolve().parent.parent
# The shipped file.  ZCODE_CADDYFILE points it somewhere else so that a
# DELIBERATELY BROKEN copy can be run against these same checks — a check
# that has never been seen to fail is a check nobody knows what it proves.
CADDYFILE = pathlib.Path(os.environ.get("ZCODE_CADDYFILE") or (ROOT / "deploy" / "Caddyfile"))

# Small on purpose: the test has to be able to exhaust a budget quickly.
TOOL_CALL_EVENTS = 3
API_EVENTS = 5
# The generation path has two budgets: one per client IP, and one shared by
# everybody.  The first run below exhausts the per-IP one (the global one is
# deliberately generous); a second run exhausts the global one (the per-IP one
# is deliberately generous).  That way BOTH zones are proved live instead of
# one of them hiding behind the other.
GEN_EVENTS = 3
GEN_GLOBAL_EVENTS = 50
GEN_GLOBAL_EVENTS_SECOND_RUN = 2

results: list[tuple[bool, str, str]] = []


def check(ok: bool, name: str, detail: str = "") -> bool:
    results.append((ok, name, detail))
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f"  — {detail}" if detail else ""))
    return ok


def skip(name: str, why: str) -> None:
    print(f"  [SKIP] {name}  — {why}")


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def have_module(caddy: str) -> bool:
    try:
        out = subprocess.run(
            [caddy, "list-modules"], capture_output=True, text=True, timeout=60
        ).stdout
    except Exception:
        return False
    return "http.handlers.rate_limit" in out


def find_caddy() -> str | None:
    """A Caddy that has the rate_limit module."""
    explicit = os.environ.get("ZCODE_CADDY_BIN")
    if explicit and pathlib.Path(explicit).is_file():
        return explicit
    # /tmp/caddy-rl/caddy is where this script's own message tells you to
    # put one, so it has to be somewhere it looks.
    for candidate in ("/opt/zcode/bin/caddy", "/tmp/caddy-rl/caddy",
                      shutil.which("caddy") or ""):
        if candidate and pathlib.Path(candidate).is_file() and have_module(candidate):
            return candidate
    return None


def find_stock_caddy() -> str | None:
    """A Caddy WITHOUT the module, used to prove the refusal."""
    explicit = os.environ.get("ZCODE_CADDY_STOCK")
    if explicit and pathlib.Path(explicit).is_file() and not have_module(explicit):
        return explicit
    for candidate in (shutil.which("caddy") or "", "/opt/homebrew/bin/caddy"):
        if candidate and pathlib.Path(candidate).is_file() and not have_module(candidate):
            return candidate
    return None


def http_get(port: int, path: str, headers: dict[str, str] | None = None):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=20)
    try:
        conn.request("GET", path, headers=headers or {})
        resp = conn.getresponse()
        body = resp.read()
        return resp.status, dict(resp.getheaders()), body
    finally:
        conn.close()


def http_post(port: int, path: str, body: bytes = b"{}"):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=20)
    try:
        conn.request("POST", path, body=body, headers={"Content-Type": "application/json"})
        resp = conn.getresponse()
        payload = resp.read()
        return resp.status, dict(resp.getheaders()), payload
    finally:
        conn.close()


class Backend:
    """A tiny HTTP backend that counts what actually reached it."""

    def __init__(self) -> None:
        self.hits: dict[str, int] = {}
        self.last_headers: dict[str, str] = {}
        self._lock = threading.Lock()

    def make_handler(self):
        backend = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def _record(self):
                with backend._lock:
                    backend.hits[self.path] = backend.hits.get(self.path, 0) + 1
                    backend.last_headers = {k.lower(): v for k, v in self.headers.items()}
                body = json.dumps({"path": self.path}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):  # noqa: N802
                self._record()

            def do_POST(self):  # noqa: N802
                length = int(self.headers.get("Content-Length") or 0)
                if length:
                    self.rfile.read(length)
                self._record()

            def log_message(self, *args):
                pass

        return Handler


def wait_for_port(port: int, timeout: float = 30.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=1):
                return True
        except OSError:
            time.sleep(0.25)
    return False


def main() -> int:
    if not CADDYFILE.is_file():
        print(f"no Caddyfile at {CADDYFILE}", file=sys.stderr)
        return 2

    caddy = find_caddy()
    if not caddy:
        print(
            "no Caddy with the rate_limit module was found.\n"
            "Build one with:\n"
            "  go install github.com/caddyserver/xcaddy/cmd/xcaddy@latest\n"
            "  xcaddy build --with github.com/mholt/caddy-ratelimit --output /tmp/caddy-rl/caddy\n"
            "then re-run with ZCODE_CADDY_BIN=/tmp/caddy-rl/caddy",
            file=sys.stderr,
        )
        return 3

    tmp = pathlib.Path(tempfile.mkdtemp(prefix="caddy-edge-"))
    site = tmp / "site"
    site.mkdir(parents=True, exist_ok=True)
    (site / "index.html").write_text("<!doctype html><title>clef</title><h1>clef</h1>\n")

    backend = Backend()
    backend_port = free_port()
    httpd = ThreadingHTTPServer(("127.0.0.1", backend_port), backend.make_handler())
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    edge_port = free_port()
    env = {
        # The site ADDRESS, not just a hostname.  The explicit http://
        # scheme makes Caddy serve plain HTTP on that port and skip
        # certificates entirely; without it Caddy would bind the port for
        # TLS and answer every plain-HTTP request with a 400.  On the real
        # box this is a bare hostname, so Caddy serves :443 with an ACME
        # certificate and redirects :80 to it.
        "CLEF_DOMAIN": f"http://127.0.0.1:{edge_port}",
        "ACME_EMAIL": "ops@example.com",
        # The backend stands in for the guard, so the proxy talks to it.
        "GUARD_PORT": str(backend_port),
        "SITE_ROOT": str(site),
        "CADDY_ACCESS_LOG": str(tmp / "access.log"),
        "CADDY_STORAGE": str(tmp / "acme"),
        "RL_TOOL_CALL_EVENTS": str(TOOL_CALL_EVENTS),
        "RL_TOOL_CALL_WINDOW": "1m",
        "RL_API_EVENTS": str(API_EVENTS),
        "RL_API_WINDOW": "1m",
        "RL_GEN_EVENTS": str(GEN_EVENTS),
        "RL_GEN_WINDOW": "1m",
        "RL_GEN_GLOBAL_EVENTS": str(GEN_GLOBAL_EVENTS),
        "RL_GEN_GLOBAL_WINDOW": "1m",
        # The generation model server.  The backend above stands in for it,
        # so the request still has to arrive with its prefix stripped.
        "GEN_PORT": str(backend_port),
    }
    envfile = tmp / "caddy.env"
    envfile.write_text("".join(f"{k}={v}\n" for k, v in env.items()))

    print(f"caddy (with the module): {caddy}")
    print(f"backend on {backend_port}, edge on {edge_port}")

    print("\n1. the shipped configuration")
    proc = subprocess.run(
        [caddy, "validate", "--config", str(CADDYFILE), "--envfile", str(envfile)],
        capture_output=True,
        text=True,
    )
    check(
        proc.returncode == 0,
        "the shipped deploy/Caddyfile loads on a Caddy with the module",
        (proc.stdout + proc.stderr).strip().splitlines()[-1] if (proc.stdout + proc.stderr).strip() else "",
    )

    stock = find_stock_caddy()
    if stock:
        proc = subprocess.run(
            [stock, "validate", "--config", str(CADDYFILE), "--envfile", str(envfile)],
            capture_output=True,
            text=True,
        )
        refused = proc.returncode != 0 and "rate_limit" in (proc.stdout + proc.stderr)
        check(
            refused,
            "a stock Caddy refuses it, so a mis-provisioned box fails loudly",
            "unrecognized directive: rate_limit" if refused else (proc.stdout + proc.stderr)[-160:],
        )
    else:
        skip(
            "a stock Caddy refuses it, so a mis-provisioned box fails loudly",
            "no Caddy without the module was found to test the refusal with",
        )

    fmt = subprocess.run([caddy, "fmt", str(CADDYFILE)], capture_output=True, text=True)
    check(
        fmt.returncode == 0 and fmt.stdout == CADDYFILE.read_text(),
        "the shipped deploy/Caddyfile is caddy fmt clean",
        "no diff" if fmt.stdout == CADDYFILE.read_text() else "caddy fmt would change it",
    )

    # ------------------------------------------------------------------
    # 1b. The DEPLOYED configuration.
    #
    # The rest of this file exercises the Caddyfile with values chosen to
    # make it runnable on a laptop: a plain-HTTP address on a high port
    # and a site root in a temp directory.  The box runs it with a bare
    # hostname, :443 and :80, and the real paths — and those are the
    # values that have to work, so they are checked here with the same
    # env file the bootstrap writes.
    #
    # Only two paths are redirected, and they are the two a non-root
    # machine cannot create: the access log and the ACME storage.  The
    # bootstrap creates both with `install -d` before it validates.
    # ------------------------------------------------------------------
    print("\n1b. the configuration as the box will run it")
    deployed_env = {
        "CLEF_DOMAIN": "clef.example.com",
        "ACME_EMAIL": "ops@example.com",
        "GUARD_PORT": "8090",
        "GEN_PORT": "8080",
        "BIND_ADDR": "0.0.0.0",
        "SITE_ROOT": "/opt/zcode/site",
        "RL_TOOL_CALL_EVENTS": "30",
        "RL_TOOL_CALL_WINDOW": "1m",
        "RL_API_EVENTS": "60",
        "RL_API_WINDOW": "1m",
        "RL_GEN_EVENTS": "6",
        "RL_GEN_WINDOW": "1m",
        "RL_GEN_GLOBAL_EVENTS": "20",
        "RL_GEN_GLOBAL_WINDOW": "1m",
        "CADDY_ACCESS_LOG": str(tmp / "deployed-access.log"),
        "CADDY_STORAGE": str(tmp / "deployed-acme"),
    }
    deployed_envfile = tmp / "deployed.env"
    deployed_envfile.write_text("".join(f"{k}={v}\n" for k, v in deployed_env.items()))
    proc = subprocess.run(
        [caddy, "validate", "--config", str(CADDYFILE), "--envfile", str(deployed_envfile)],
        capture_output=True,
        text=True,
    )
    output = (proc.stdout + proc.stderr).strip()
    check(
        proc.returncode == 0 and "Valid configuration" in output,
        "the deployed values validate: a bare hostname, :443, /opt/zcode/site",
        output.splitlines()[-1][:110] if output else "",
    )

    # The adapted config is the thing that actually runs, so check the
    # limits in it rather than in the source text.
    adapted = subprocess.run(
        [caddy, "adapt", "--config", str(CADDYFILE), "--envfile", str(deployed_envfile)],
        capture_output=True,
        text=True,
    )
    zones = {}
    if adapted.returncode == 0:
        def find_rate_limits(node):
            if isinstance(node, dict):
                if node.get("handler") == "rate_limit":
                    zones.update(node.get("rate_limits", {}))
                for value in node.values():
                    find_rate_limits(value)
            elif isinstance(node, list):
                for value in node:
                    find_rate_limits(value)
        try:
            find_rate_limits(json.loads(adapted.stdout))
        except json.JSONDecodeError:
            pass
    tool_call = zones.get("tool_call", {})
    api = zones.get("api", {})
    gen = zones.get("gen", {})
    gen_global = zones.get("gen_global", {})
    check(
        tool_call.get("max_events") == 30
        and tool_call.get("window") == 60_000_000_000
        and tool_call.get("match") == [{"path": ["/v1/*"]}]
        and tool_call.get("key") == "{http.request.remote.host}",
        "the tool-call zone is /v1/* at 30 a minute, keyed by client IP",
        json.dumps(tool_call),
    )
    check(
        api.get("max_events") == 60
        and api.get("window") == 60_000_000_000
        and api.get("match") == [{"path": ["/api/*"]}]
        and api.get("key") == "{http.request.remote.host}",
        "the api zone is /api/* at 60 a minute, keyed by client IP",
        json.dumps(api),
    )
    check(
        gen.get("max_events") == 6
        and gen.get("window") == 60_000_000_000
        and gen.get("match") == [{"path": ["/gen/*"]}]
        and gen.get("key") == "{http.request.remote.host}",
        "the generation zone is /gen/* at 6 a minute, keyed by client IP",
        json.dumps(gen),
    )
    check(
        gen_global.get("max_events") == 20
        and gen_global.get("window") == 60_000_000_000
        and gen_global.get("match") == [{"path": ["/gen/*"]}]
        and gen_global.get("key") != "{http.request.remote.host}",
        "the generation path also has ONE budget for everybody, not one per address",
        f"key={gen_global.get('key')!r} — a static key is a single shared counter",
    )
    check(
        "/health" not in json.dumps(api.get("match", []))
        and "/health" not in json.dumps(tool_call.get("match", []))
        and "/health" not in json.dumps(gen.get("match", [])),
        "the liveness probe is in no zone, so it is never throttled",
        "/health is proxied but unthrottled",
    )

    # The listen address.  The box binds every IPv4 interface; the
    # Tailscale edge binds ONE address — the tailnet one — so the edge is
    # reachable over the tailnet and not from the local LAN.
    try:
        servers = json.loads(adapted.stdout)["apps"]["http"]["servers"]
        listen = [addr for srv in servers.values() for addr in srv.get("listen", [])]
    except (KeyError, json.JSONDecodeError):
        listen = []
    check(
        listen == ["0.0.0.0:443"],
        "the deployed config listens on every IPv4 interface",
        f"listen={listen}",
    )
    tailnet_env = dict(deployed_env)
    tailnet_env["BIND_ADDR"] = "100.64.0.7"
    tailnet_envfile = tmp / "tailnet.env"
    tailnet_envfile.write_text("".join(f"{k}={v}\n" for k, v in tailnet_env.items()))
    tailnet_adapted = subprocess.run(
        [caddy, "adapt", "--config", str(CADDYFILE), "--envfile", str(tailnet_envfile)],
        capture_output=True,
        text=True,
    )
    try:
        tailnet_listen = [
            addr
            for srv in json.loads(tailnet_adapted.stdout)["apps"]["http"]["servers"].values()
            for addr in srv.get("listen", [])
        ]
    except (KeyError, json.JSONDecodeError):
        tailnet_listen = []
    check(
        tailnet_listen == ["100.64.0.7:443"],
        "the same config can be bound to ONE address — the tailnet one",
        f"listen={tailnet_listen}",
    )

    # The ORDER of the handlers is the part that is easy to get wrong and
    # impossible to see by reading the Caddyfile.  Caddy applies `uri`
    # before `rate_limit`, so a limiter that sits NEXT TO a path rewrite
    # would be matched against the rewritten path — and a zone that does not
    # match is skipped silently, which means no limit at all.  Measured: with
    # the limiter inside the /gen handle, the zone never fired.
    #
    # In the adapted JSON the handlers of a route appear in the order they
    # run, so the limiter has to come before the rewrite.
    sequence: list[str] = []

    def handler_order(node):
        if isinstance(node, dict):
            if "handler" in node:
                sequence.append(node["handler"])
            for value in node.values():
                handler_order(value)
        elif isinstance(node, list):
            for value in node:
                handler_order(value)

    try:
        handler_order(json.loads(adapted.stdout))
    except json.JSONDecodeError:
        pass
    if "rate_limit" in sequence and "rewrite" in sequence:
        check(
            sequence.index("rate_limit") < sequence.index("rewrite"),
            "the limiter runs BEFORE the path rewrite, so its zones match the original path",
            f"order: rate_limit at {sequence.index('rate_limit')}, rewrite at {sequence.index('rewrite')}",
        )
    else:
        check(
            False,
            "the limiter runs BEFORE the path rewrite, so its zones match the original path",
            f"handlers seen: {sequence[:12]}",
        )

    print("\n2. the edge, running the shipped configuration")
    caddy_proc = subprocess.Popen(
        [caddy, "run", "--config", str(CADDYFILE), "--envfile", str(envfile)],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    try:
        if not wait_for_port(edge_port):
            print("caddy never opened its port", file=sys.stderr)
            return 2

        # A client that lies about who it is.  This goes to /health on
        # purpose: /health is proxied to the backend like the other guarded
        # paths, but it is in no rate-limit zone, so the probe does not
        # spend any of the api budget the next check measures.
        _, _, body = http_get(edge_port, "/health", {"X-Forwarded-For": "6.6.6.6"})
        seen_xff = backend.last_headers.get("x-forwarded-for")
        seen_xreal = backend.last_headers.get("x-real-ip")
        check(
            seen_xff is not None and "6.6.6.6" not in seen_xff,
            "a forged X-Forwarded-For is replaced with the real client address",
            f"upstream saw x-forwarded-for={seen_xff!r}",
        )
        check(
            seen_xreal == "127.0.0.1",
            "the upstream is told the real client address in X-Real-IP",
            f"x-real-ip={seen_xreal!r}",
        )

        # The expensive path: /v1/*.
        codes = []
        for _ in range(TOOL_CALL_EVENTS + 2):
            status, _, _ = http_get(edge_port, "/v1/guard/tool-call")
            codes.append(status)
        allowed = codes.count(200)
        rejected = codes.count(429)
        check(
            allowed == TOOL_CALL_EVENTS and rejected == 2,
            f"the tool-call path allows {TOOL_CALL_EVENTS} per minute and refuses the rest",
            f"codes={codes}",
        )
        with backend._lock:
            upstream_hits = backend.hits.get("/v1/guard/tool-call", 0)
        check(
            upstream_hits == TOOL_CALL_EVENTS,
            "the refused requests never reached the backend — the load is shed at the edge",
            f"backend saw {upstream_hits} of {len(codes)}",
        )

        status, headers, _ = http_get(edge_port, "/v1/guard/tool-call")
        check(
            status == 429 and "retry-after" in {k.lower() for k in headers},
            "the refusal carries a Retry-After",
            f"status={status} retry-after={headers.get('Retry-After') or headers.get('retry-after')}",
        )

        # The cheap API path has its own, larger budget.
        codes = []
        for _ in range(API_EVENTS + 2):
            status, _, _ = http_get(edge_port, "/api/info")
            codes.append(status)
        check(
            codes.count(200) == API_EVENTS and codes.count(429) == 2,
            f"the api path allows {API_EVENTS} per minute and refuses the rest",
            f"codes={codes}",
        )

        # The static site and the liveness probe are in no zone at all.
        codes = [http_get(edge_port, "/index.html")[0] for _ in range(API_EVENTS + 3)]
        check(
            set(codes) == {200},
            "the static site is never rate limited — a visitor is not throttled for loading a page",
            f"codes={codes}",
        )
        codes = [http_get(edge_port, "/health")[0] for _ in range(API_EVENTS + 3)]
        check(
            set(codes) == {200},
            "the liveness probe is never rate limited",
            f"codes={codes}",
        )

        # The generation path.  This is the most expensive thing on the
        # site: a 4B model writing code, token by token, for every visitor
        # who loads the page.
        backend.hits.clear()
        codes = [http_post(edge_port, "/gen/v1/chat/completions")[0] for _ in range(GEN_EVENTS + 2)]
        check(
            codes.count(200) == GEN_EVENTS and codes.count(429) == 2,
            f"the generation path allows {GEN_EVENTS} per minute and refuses the rest",
            f"codes={codes}",
        )
        with backend._lock:
            gen_hits = backend.hits.get("/v1/chat/completions", 0)
        check(
            gen_hits == GEN_EVENTS,
            "the refused generations never reached the model — the load is shed at the edge",
            f"the model server saw {gen_hits} of {len(codes)}",
        )
        check(
            "/gen/v1/chat/completions" not in backend.hits,
            "the /gen prefix is stripped before the request reaches the model server",
            f"the model server saw {sorted(backend.hits)}",
        )
    finally:
        caddy_proc.terminate()
        try:
            caddy_proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            caddy_proc.kill()

    # ------------------------------------------------------------------
    # The shared generation budget.
    #
    # A per-IP limit does not bound the total work: an attacker with a
    # thousand addresses is a thousand buckets, and each of those buckets
    # can still make the box generate code.  So the generation path has a
    # second zone with a STATIC key — one counter for everybody.
    #
    # It is proved with a second edge whose per-IP budget is generous and
    # whose shared budget is tiny.  If the shared zone were not live, the
    # requests would sail through.
    # ------------------------------------------------------------------
    print("\n3. the shared generation budget (one counter for everybody)")
    global_env = dict(env)
    global_env["RL_GEN_EVENTS"] = "100"
    global_env["RL_GEN_GLOBAL_EVENTS"] = str(GEN_GLOBAL_EVENTS_SECOND_RUN)
    global_port = free_port()
    global_env["CLEF_DOMAIN"] = f"http://127.0.0.1:{global_port}"
    global_envfile = tmp / "caddy-global.env"
    global_envfile.write_text("".join(f"{k}={v}\n" for k, v in global_env.items()))

    global_caddy = subprocess.Popen(
        [caddy, "run", "--config", str(CADDYFILE), "--envfile", str(global_envfile)],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    try:
        if not wait_for_port(global_port):
            print("the second caddy never opened its port", file=sys.stderr)
            return 2
        backend.hits.clear()
        codes = [
            http_post(global_port, "/gen/v1/chat/completions")[0]
            for _ in range(GEN_GLOBAL_EVENTS_SECOND_RUN + 2)
        ]
        check(
            codes.count(200) == GEN_GLOBAL_EVENTS_SECOND_RUN
            and codes.count(429) == 2,
            f"the whole site shares one generation budget of {GEN_GLOBAL_EVENTS_SECOND_RUN} a minute",
            f"codes={codes}",
        )
        with backend._lock:
            shared_hits = backend.hits.get("/v1/chat/completions", 0)
        check(
            shared_hits == GEN_GLOBAL_EVENTS_SECOND_RUN,
            "the shared budget sheds the load too — the model server is not reached",
            f"the model server saw {shared_hits} of {len(codes)}",
        )
    finally:
        global_caddy.terminate()
        try:
            global_caddy.wait(timeout=15)
        except subprocess.TimeoutExpired:
            global_caddy.kill()
        httpd.shutdown()

    passed = sum(1 for ok, _, _ in results if ok)
    failed = sum(1 for ok, _, _ in results if not ok)
    print(f"\n{passed}/{passed + failed} checks passed")
    shutil.rmtree(tmp, ignore_errors=True)
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
