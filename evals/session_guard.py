#!/usr/bin/env python3
"""Prove that the guard's device-bound sessions actually admit and refuse.

Every assertion below is a live HTTP call against a real guard process
started by this script. Nothing is mocked.

It checks five things:

  1. Admission — a visitor gets a session with no account and no sign-in.
  2. Device binding — the session cookie only works together with the
     device cookie and the user-agent it was minted with.
  3. Forgery — a session cookie that was not minted by this guard is
     refused.
  4. The operator's bearer token still works, with or without a session.
  5. Local mode — with no token configured nothing is required, so the
     benchmark harnesses and the local workflow are unaffected.

Usage:
    python3 evals/session_guard.py

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
TOKEN = "the-operator-bearer-token"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) SessionTest/1.0"
OTHER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) SomeoneElse/2.0"

results: list[tuple[bool, str, str]] = []


def check(ok: bool, name: str, detail: str = "") -> bool:
    results.append((ok, name, detail))
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f"  — {detail}" if detail else ""))
    return ok


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def request(port: int, path: str, method: str = "GET", token: str | None = None,
            cookie: str | None = None, user_agent: str | None = None,
            body: dict | None = None) -> tuple[int, dict[str, str], bytes]:
    """One HTTP request. Returns the status, the headers and the body."""
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=30)
    headers = {}
    if token is not None:
        headers["Authorization"] = f"Bearer {token}"
    if cookie is not None:
        headers["Cookie"] = cookie
    headers["User-Agent"] = user_agent if user_agent is not None else UA
    payload = None
    if body is not None:
        payload = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    try:
        conn.request(method, path, body=payload, headers=headers)
        response = conn.getresponse()
        raw = response.read()
        # The guard sets two cookies, so the Set-Cookie headers have to be
        # kept apart — a dict keyed on the header name would keep only the
        # last one.
        collected: dict[str, str] = {}
        set_cookies: list[str] = []
        for name, value in response.getheaders():
            lower = name.lower()
            if lower == "set-cookie":
                set_cookies.append(value)
            elif lower in collected:
                collected[lower] = f"{collected[lower]}\n{value}"
            else:
                collected[lower] = value
        if set_cookies:
            collected["set-cookie"] = "\n".join(set_cookies)
        return response.status, collected, raw
    finally:
        conn.close()


def cookies_from(headers: dict[str, str]) -> dict[str, str]:
    """The guard's cookies out of the Set-Cookie headers."""
    out = {}
    for value in headers.get("set-cookie", "").split("\n"):
        if not value:
            continue
        name, _, rest = value.partition("=")
        out[name.strip()] = rest.split(";")[0]
    return out


def start_guard(port: int, token_file: str | None, extra: list[str]) -> subprocess.Popen:
    cmd = [
        str(PROJ / "target/debug/qwen-clef-repe-guard"),
        "--host", "127.0.0.1",
        "--port", str(port),
        "--upstream", "http://127.0.0.1:8123",
        "--model", MODEL,
        "--repe", REPE,
        "--mode", "enforce",
    ]
    if token_file is not None:
        cmd += ["--auth-token-file", token_file]
    cmd += extra
    log = open(f"/tmp/session_guard_{port}.log", "w")
    return subprocess.Popen(cmd, cwd=PROJ, stdout=log, stderr=subprocess.STDOUT)


def wait_for_health(port: int, timeout: float = 90.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            status, _, _ = request(port, "/health")
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

    tmp = pathlib.Path(tempfile.mkdtemp(prefix="session-guard-"))
    token_file = tmp / "guard.token"
    token_file.write_text(TOKEN + "\n")
    token_file.chmod(0o600)
    secret_file = tmp / "session.secret"
    secret_file.write_text("a-stable-session-secret\n")
    secret_file.chmod(0o600)

    protected_port = free_port()
    open_port = free_port()
    nosession_port = free_port()
    print(f"starting three guards: protected on {protected_port}, "
          f"open on {open_port}, sessions-off on {nosession_port}")

    protected = start_guard(protected_port, str(token_file),
                             ["--session-secret-file", str(secret_file)])
    opened = start_guard(open_port, None, [])
    nosession = start_guard(nosession_port, str(token_file), ["--no-sessions"])
    try:
        for port in (protected_port, open_port, nosession_port):
            if not wait_for_health(port):
                print(f"the guard on {port} never became healthy", file=sys.stderr)
                return 2

        print("\n1. admission — no account, no sign-in")
        status, headers, raw = request(protected_port, "/api/session", method="POST")
        check(status == 200, "a visitor can mint a session without a credential",
              f"status={status}")
        jar = cookies_from(headers)
        check("zcode_sid" in jar and "zcode_dev" in jar,
              "the guard sets a session cookie and a device cookie",
              f"cookies={sorted(jar)}")
        check("HttpOnly" in headers.get("set-cookie", ""),
              "the cookies are HttpOnly", "")
        session_cookie = f"zcode_sid={jar.get('zcode_sid')}; zcode_dev={jar.get('zcode_dev')}"

        print("\n2. device binding")
        status, _, _ = request(protected_port, "/api/info", cookie=session_cookie)
        check(status == 200, "the session works with its device cookie and user-agent",
              f"status={status}")
        status, _, raw = request(
            protected_port, "/api/info",
            cookie=f"zcode_sid={jar.get('zcode_sid')}")
        check(status == 401, "the session cookie alone is refused",
              f"status={status}")
        status, _, raw = request(
            protected_port, "/api/info",
            cookie=f"zcode_sid={jar.get('zcode_sid')}; zcode_dev={'0' * 64}")
        check(status == 401, "a different device cookie is refused", f"status={status}")
        status, _, raw = request(
            protected_port, "/api/info", cookie=session_cookie, user_agent=OTHER_UA)
        check(status == 401, "a different user-agent is refused", f"status={status}")
        try:
            reason = json.loads(raw).get("reason", "")
        except Exception:
            reason = ""
        check("device" in reason,
              "the refusal says the session belongs to another device",
              f"reason={reason!r}")

        print("\n3. forgery")
        forged = f"zcode_sid={'a' * 32}.{'b' * 64}; zcode_dev={jar.get('zcode_dev')}"
        status, _, _ = request(protected_port, "/api/info", cookie=forged)
        check(status == 401, "a forged session cookie is refused", f"status={status}")
        # A real session id with a mangled signature.
        mangled = f"zcode_sid={jar.get('zcode_sid')}.{'f' * 64}; zcode_dev={jar.get('zcode_dev')}"
        status, _, _ = request(protected_port, "/api/info", cookie=mangled)
        check(status == 401, "a real session id with a bad signature is refused",
              f"status={status}")

        print("\n4. the expensive routes")
        probe = {"prompt": "Refactor the parser.", "tool_name": "shell",
                 "tool_args": {"cmd": "ls"}, "questions": []}
        status, _, raw = request(protected_port, "/v1/guard/tool-call",
                                 method="POST", body=probe)
        check(status == 401, "the tool-call route refuses a caller with no credential",
              f"status={status}")
        status, _, raw = request(protected_port, "/v1/guard/tool-call", method="POST",
                                 cookie=session_cookie, body=probe)
        check(status == 200, "the tool-call route answers a session",
              f"status={status}")
        if status == 200:
            verdict = json.loads(raw)
            check("allowed" in verdict,
                  "the session gets a real verdict, not a stub",
                  f"allowed={verdict.get('allowed')}")
        status, _, _ = request(protected_port, "/v1/guard/tool-call", method="POST",
                               token=TOKEN, body=probe)
        check(status == 200, "the operator's bearer token works with no session",
              f"status={status}")

        print("\n5. the operator's token")
        status, _, _ = request(protected_port, "/api/info", token=TOKEN)
        check(status == 200, "the bearer token opens every route", f"status={status}")
        status, _, _ = request(protected_port, "/api/info")
        check(status == 401, "without the token and without a session, nothing opens",
              f"status={status}")

        print("\n6. sessions turned off")
        status, _, _ = request(nosession_port, "/api/session", method="POST")
        check(status == 403, "a deployment with --no-sessions refuses to mint",
              f"status={status}")
        status, _, _ = request(nosession_port, "/api/info", token=TOKEN)
        check(status == 200, "the bearer token is still the way in",
              f"status={status}")
        status, _, _ = request(nosession_port, "/api/info")
        check(status == 401, "and nothing else is", f"status={status}")

        print("\n7. local mode is unchanged")
        status, _, _ = request(open_port, "/api/info")
        check(status == 200, "with no token configured, /api/info needs nothing",
              f"status={status}")
        status, _, raw = request(open_port, "/v1/guard/tool-call", method="POST",
                                 body=probe)
        check(status == 200, "with no token configured, the tool-call route needs nothing",
              f"status={status}")
        status, _, _ = request(open_port, "/api/session", method="POST")
        check(status == 200, "a local guard still issues a session when asked",
              f"status={status}")

        print("\n8. a session survives a restart")
        # The session is stateless: the cookie carries its own signed
        # claims, so a restart does not end it — as long as the signing
        # secret did not change.
        restart_port = free_port()
        restart_secret = tmp / "restart.secret"
        restart_secret.write_text("a-stable-secret-across-restarts\n")
        restart_secret.chmod(0o600)
        first = start_guard(restart_port, str(token_file),
                            ["--session-secret-file", str(restart_secret)])
        try:
            if not wait_for_health(restart_port):
                print("the guard never became healthy", file=sys.stderr)
                return 2
            status, headers, _ = request(restart_port, "/api/session", method="POST")
            check(status == 200, "a session is minted before the restart",
                  f"status={status}")
            jar = cookies_from(headers)
            keep = f"zcode_sid={jar.get('zcode_sid')}; zcode_dev={jar.get('zcode_dev')}"
            status, _, _ = request(restart_port, "/api/info", cookie=keep)
            check(status == 200, "the session works before the restart",
                  f"status={status}")
        finally:
            first.terminate()
            try:
                first.wait(timeout=10)
            except subprocess.TimeoutExpired:
                first.kill()

        # Bring it back on the same port with the same secret.
        second = start_guard(restart_port, str(token_file),
                             ["--session-secret-file", str(restart_secret)])
        try:
            if not wait_for_health(restart_port):
                print("the guard never came back", file=sys.stderr)
                return 2
            status, _, _ = request(restart_port, "/api/info", cookie=keep)
            check(status == 200, "the session still works after a restart",
                  f"status={status}")

            # And a restart that rotates the secret ends every session.
            rotated = tmp / "rotated.secret"
            rotated.write_text("a-different-secret\n")
            rotated.chmod(0o600)
            second.terminate()
            try:
                second.wait(timeout=10)
            except subprocess.TimeoutExpired:
                second.kill()
            third = start_guard(restart_port, str(token_file),
                                ["--session-secret-file", str(rotated)])
            try:
                if not wait_for_health(restart_port):
                    print("the guard never came back", file=sys.stderr)
                    return 2
                status, _, _ = request(restart_port, "/api/info", cookie=keep)
                check(status == 401, "a restart that rotates the secret ends the session",
                      f"status={status}")
            finally:
                third.terminate()
                try:
                    third.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    third.kill()
        finally:
            if second.poll() is None:
                second.terminate()
                try:
                    second.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    second.kill()
    finally:
        for proc in (protected, opened, nosession):
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
