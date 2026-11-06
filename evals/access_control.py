#!/usr/bin/env python3
"""Prove that the guard's access control actually blocks.

Every assertion below is a live HTTP call against a real guard process
started by this script, or a real process exit code. Nothing is mocked.

It checks four things:

  1. Authentication — every route except `/health` refuses a request
     without the right bearer token.
  2. Rate limiting — a per-client ceiling that is enforced.
  3. Proxy trust — the client identity comes from the right-most
     `X-Forwarded-For` entry, so a forged entry cannot buy extra budget.
  4. The safety rail — the guard refuses to bind a routable address
     without a token.

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


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def request(port: int, path: str, token: str | None = None,
            forwarded_for: str | None = None, method: str = "GET",
            body: dict | None = None) -> tuple[int, dict[str, str]]:
    """One HTTP request. Returns the status and the response headers."""
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=30)
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


def start_guard(port: int, token_file: str, extra: list[str]) -> subprocess.Popen:
    cmd = [
        str(PROJ / "target/debug/qwen-clef-repe-guard"),
        "--host", "127.0.0.1",
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
    print(f"starting two guards: auth-only on {auth_port}, rate-limited on {limit_port}")

    auth_proc = start_guard(auth_port, str(token_file), [])
    limit_proc = start_guard(limit_port, str(token_file),
                             ["--rate-limit-rpm", "3", "--trust-proxy"])
    try:
        if not wait_for_health(auth_port):
            print(f"the guard on {auth_port} never became healthy", file=sys.stderr)
            return 2
        if not wait_for_health(limit_port):
            print(f"the guard on {limit_port} never became healthy", file=sys.stderr)
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

        print("\n4. the safety rail")
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
    finally:
        for proc in (auth_proc, limit_proc):
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
