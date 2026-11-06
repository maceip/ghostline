#!/usr/bin/env python3
"""Prove that the guard's access control actually blocks.

Every assertion below is a live HTTP call against a real guard process
started by this script, or a real process exit code. Nothing is mocked.

It checks six things:

  1. Authentication — every route except `/health` refuses a request
     without the right bearer token.
  2. Rate limiting — a per-client ceiling that is enforced.
  3. Proxy trust — the client identity comes from the right-most
     `X-Forwarded-For` entry, so a forged entry cannot buy extra budget.
  4. No ceiling — `--rate-limit-rpm 0` means unlimited, not one request
     a minute.
  5. The safety rail — the guard refuses to bind a routable address
     without a token.
  6. Header provenance — a forwarded header from a peer that is not on
     this machine is not evidence of anything, so it cannot buy budget;
     and the explicit `--trust-proxy-any-peer` opt-in does restore it.

Usage:
    python3 evals/access_control.py

Environment:
    MODEL   the checkpoint to run with (default: Qwen2.5-0.5B-Instruct)
    PROJ    the generated guard project (default: qwen-clef-repe-guard)
"""
from __future__ import annotations

import http.client
import json
import os
import pathlib
import socket
import subprocess
import sys
import tempfile
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
PROJ = pathlib.Path(os.environ.get("PROJ", ROOT / "qwen-clef-repe-guard"))
MODEL = os.environ.get(
    "MODEL",
    "/Users/mac/.cache/huggingface/hub/models--Qwen--Qwen2.5-0.5B-Instruct/"
    "snapshots/7ae557604adf67be50417f59c2c2f167def9a775/",
)
REPE = "artifacts/repe_vectors_qwen2_5_0_5b.safetensors"
TOKEN = "access-control-test-token"

results: list[tuple[bool, str, str]] = []


def check(ok: bool, name: str, detail: str = "") -> bool:
    results.append((ok, name, detail))
    mark = "PASS" if ok else "FAIL"
    print(f"  [{mark}] {name}" + (f"  — {detail}" if detail else ""))
    return ok


def skip(name: str, detail: str = "") -> None:
    """Something this machine cannot check. Loud, but not a failure.

    A machine with no non-loopback address cannot produce the peer a
    network client would look like, so that check cannot run here.  That
    is a limitation of the host, not a defect in the guard, so it is
    reported rather than counted as a pass or a failure.
    """
    print(f"  [SKIP] {name}" + (f"  — {detail}" if detail else ""))


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def free_port_any() -> int:
    """A port free on every interface, for a guard that binds 0.0.0.0."""
    with socket.socket() as sock:
        sock.bind(("0.0.0.0", 0))
        return sock.getsockname()[1]


def local_address() -> str | None:
    """This machine's own non-loopback address.

    A guard that is reachable from the network sees a peer that is not on
    loopback.  To reproduce that in a test, the client binds this address
    as its source, so the guard's socket peer is the machine's LAN address
    rather than 127.0.0.1.
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("8.8.8.8", 53))
        addr = sock.getsockname()[0]
    except OSError:
        return None
    finally:
        sock.close()
    if addr.startswith("127."):
        return None
    return addr


def request(port: int, path: str, token: str | None = None,
            forwarded_for: str | None = None, method: str = "GET",
            body: dict | None = None, host: str = "127.0.0.1",
            source_address: str | None = None) -> tuple[int, dict[str, str]]:
    """One HTTP request. Returns the status and the response headers."""
    if isinstance(source_address, str):
        source_address = (source_address, 0)
    conn = http.client.HTTPConnection(
        host, port, timeout=30, source_address=source_address)
    headers = {}
    if token is not None:
        headers["Authorization"] = f"Bearer {token}"
    if forwarded_for is not None:
        headers["X-Forwarded-For"] = forwarded_for
    payload = None
    if body is not None:
        payload = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    try:
        conn.request(method, path, body=payload, headers=headers)
        response = conn.getresponse()
        response.read()
        return response.status, {k.lower(): v for k, v in response.getheaders()}
    finally:
        conn.close()


def start_guard(port: int, token_file: str, extra: list[str],
                host: str = "127.0.0.1") -> subprocess.Popen:
    cmd = [
        str(PROJ / "target/debug/qwen-clef-repe-guard"),
        "--host", host,
        "--port", str(port),
        "--upstream", "http://127.0.0.1:8123",
        "--model", MODEL,
        "--repe", REPE,
        "--mode", "enforce",
        "--auth-token-file", token_file,
    ] + extra
    log = open(f"/tmp/access_control_guard_{port}.log", "w")
    return subprocess.Popen(cmd, cwd=PROJ, stdout=log, stderr=subprocess.STDOUT)


def wait_for_health(port: int, timeout: float = 90.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            status, _ = request(port, "/health")
            if status == 200:
                return True
        except OSError:
            pass
        time.sleep(1.0)
    return False


def main() -> int:
    binary = PROJ / "target/debug/qwen-clef-repe-guard"
    if not binary.exists():
        print(f"the guard binary is missing: {binary}\nbuild it first", file=sys.stderr)
        return 2
    if not pathlib.Path(MODEL).exists():
        print(f"the checkpoint is missing: {MODEL}", file=sys.stderr)
        return 2

    tmp = pathlib.Path(tempfile.mkdtemp(prefix="access-control-"))
    token_file = tmp / "guard.token"
    token_file.write_text(TOKEN + "\n")
    token_file.chmod(0o600)

    auth_port = free_port()
    limit_port = free_port()
    open_port = free_port()
    print(f"starting three guards: auth-only on {auth_port}, rate-limited on "
          f"{limit_port}, unlimited on {open_port}")

    auth_proc = start_guard(auth_port, str(token_file), [])
    limit_proc = start_guard(limit_port, str(token_file),
                             ["--rate-limit-rpm", "3", "--trust-proxy"])
    open_proc = start_guard(open_port, str(token_file), ["--rate-limit-rpm", "0"])
    try:
        if not wait_for_health(auth_port):
            print(f"the guard on {auth_port} never became healthy", file=sys.stderr)
            return 2
        if not wait_for_health(limit_port):
            print(f"the guard on {limit_port} never became healthy", file=sys.stderr)
            return 2
        if not wait_for_health(open_port):
            print(f"the guard on {open_port} never became healthy", file=sys.stderr)
            return 2

        print("\n1. authentication")
        status, _ = request(auth_port, "/health")
        check(status == 200, "/health is reachable without a token",
              f"status={status}")
        status, _ = request(auth_port, "/api/info")
        check(status == 401, "/api/info refuses a missing token", f"status={status}")
        status, _ = request(auth_port, "/api/info", token="not-the-token")
        check(status == 401, "/api/info refuses a wrong token", f"status={status}")
        status, _ = request(auth_port, "/api/info", token=TOKEN)
        check(status == 200, "/api/info accepts the right token", f"status={status}")
        status, _ = request(auth_port, "/")
        check(status == 401, "the dashboard refuses a missing token", f"status={status}")
        status, _ = request(auth_port, "/", token=TOKEN)
        check(status == 200, "the dashboard accepts the right token", f"status={status}")
        status, _ = request(
            auth_port, "/v1/guard/tool-call", method="POST",
            body={"prompt": "ls", "tool_name": "shell", "tool_args": {"cmd": "ls"}},
        )
        check(status == 401, "the tool-call route refuses a missing token",
              f"status={status}")
        status, _ = request(
            auth_port, "/v1/guard/tool-call", token=TOKEN, method="POST",
            body={"prompt": "ls", "tool_name": "shell", "tool_args": {"cmd": "ls"}},
        )
        check(status == 200, "the tool-call route accepts the right token",
              f"status={status}")

        print("\n2. rate limiting")
        codes = [request(limit_port, "/api/info", token=TOKEN)[0] for _ in range(3)]
        check(codes == [200, 200, 200], "the first three requests pass",
              f"codes={codes}")
        status, headers = request(limit_port, "/api/info", token=TOKEN)
        check(status == 429, "the fourth request is refused", f"status={status}")
        check("retry-after" in headers, "the refusal carries a Retry-After header",
              f"retry-after={headers.get('retry-after')}")

        print("\n3. proxy trust")
        status, headers = request(
            limit_port, "/api/info", token=TOKEN, forwarded_for="203.0.113.77")
        check(status == 200, "a different client IP gets its own budget",
              f"status={status} remaining={headers.get('x-ratelimit-remaining')}")
        forged = []
        for _ in range(3):
            status, _ = request(
                limit_port, "/api/info", token=TOKEN,
                forwarded_for="198.51.100.9, 203.0.113.88")
            forged.append(status)
        check(forged == [200, 200, 200],
              "a forged left-most entry does not reset the right-most bucket",
              f"codes={forged}")
        status, _ = request(
            limit_port, "/api/info", token=TOKEN,
            forwarded_for="198.51.100.9, 203.0.113.88")
        check(status == 429,
              "the right-most entry is the bucket, and it is exhausted",
              f"status={status}")

        print("\n4. no ceiling")
        codes = [request(open_port, "/api/info", token=TOKEN)[0] for _ in range(10)]
        check(codes == [200] * 10,
              "--rate-limit-rpm 0 means no ceiling, not one request a minute",
              f"codes={codes}")
        status, headers = request(open_port, "/api/info", token=TOKEN)
        check("x-ratelimit-limit" not in headers,
              "an unlimited guard reports no limit header",
              f"headers={sorted(k for k in headers if 'ratelimit' in k)}")

        print("\n5. the safety rail")
        proc = subprocess.run(
            [str(binary), "--host", "0.0.0.0", "--port", str(free_port()),
             "--model", MODEL, "--repe", REPE],
            cwd=PROJ, capture_output=True, text=True, timeout=300,
        )
        check(proc.returncode != 0,
              "a routable bind without a token refuses to start",
              f"exit={proc.returncode}")
        check("refusing to bind" in (proc.stderr + proc.stdout),
              "the refusal explains itself",
              (proc.stderr + proc.stdout).strip().splitlines()[-1][:90]
              if (proc.stderr + proc.stdout).strip() else "")

        # ------------------------------------------------------------------
        # 6. A forwarded header is only evidence when it comes from a proxy
        #    this guard can vouch for.
        # ------------------------------------------------------------------
        print("\n6. a forwarded header from the network is not evidence")
        lan = local_address()
        if lan is None:
            skip("a forwarded header from the network is not evidence",
                 "this machine has no non-loopback address to test with")
        else:
            net_port = free_port_any()
            opt_port = free_port_any()
            print(f"  (the client will look like {lan} to the guard)")
            net_proc = start_guard(
                net_port, str(token_file),
                ["--rate-limit-rpm", "3", "--trust-proxy"],
                host="0.0.0.0")
            opt_proc = start_guard(
                opt_port, str(token_file),
                ["--rate-limit-rpm", "3", "--trust-proxy",
                 "--trust-proxy-any-peer"],
                host="0.0.0.0")
            try:
                if not wait_for_health(net_port):
                    print("  the network-facing guard never became healthy",
                          file=sys.stderr)
                    return 2
                if not wait_for_health(opt_port):
                    print("  the opted-in guard never became healthy",
                          file=sys.stderr)
                    return 2

                def net_request(port: int, forwarded: str | None = None) -> int:
                    return request(port, "/api/info", token=TOKEN,
                                   forwarded_for=forwarded, host=lan,
                                   source_address=lan)[0]

                codes = [net_request(net_port, "6.6.6.6") for _ in range(3)]
                check(codes == [200, 200, 200],
                      "a network client gets its own budget", f"codes={codes}")
                status = net_request(net_port, "6.6.6.6")
                check(status == 429, "that budget runs out", f"status={status}")
                status = net_request(net_port, "9.9.9.9")
                check(status == 429,
                      "rotating the forwarded header buys no new budget",
                      f"status={status}")
                status = net_request(net_port, "203.0.113.200")
                check(status == 429,
                      "a third forwarded address is still the same bucket",
                      f"status={status}")

                # The explicit opt-in is what a proxy on another host needs.
                codes = [net_request(opt_port, "6.6.6.6") for _ in range(3)]
                check(codes == [200, 200, 200],
                      "--trust-proxy-any-peer lets the header speak",
                      f"codes={codes}")
                status = net_request(opt_port, "6.6.6.6")
                check(status == 429, "that budget runs out too", f"status={status}")
                status = net_request(opt_port, "9.9.9.9")
                check(status == 200,
                      "and then a rotated header does move the bucket",
                      f"status={status}")
            finally:
                for proc in (net_proc, opt_proc):
                    proc.terminate()
                    try:
                        proc.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        proc.kill()
    finally:
        for proc in (auth_proc, limit_proc, open_proc):
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()

    failed = [name for ok, name, _ in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
    if failed:
        print("failed:")
        for name in failed:
            print(f"  - {name}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
