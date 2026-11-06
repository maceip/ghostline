#!/usr/bin/env python3
"""Independent verifier for Qwen RepE capability tokens.

This is a second implementation of the checks in ``src/capability.rs``: it
verifies the Ed25519 signature, the validity window, and — when the tool
arguments are supplied — recomputes the SHA-256 argument digest from scratch.
It never shells out to the Rust binary, so agreement between the two is
evidence that the wire format is pinned down rather than circular.

Usage:

    uv run --python 3.12 --with cryptography python3 tools/capability_check.py \
        verify --token <tok> --public-key <hex> [--args-json <json>] [--now <unix>]

Exit codes: 0 valid, 1 invalid, 2 usage error.

The canonical JSON rules below are a deliberate mirror of the Rust
implementation (``canonical_json`` in ``src/capability.rs``): object keys are
sorted recursively, there is no insignificant whitespace, strings are escaped
like ``json.dumps(..., ensure_ascii=False)``, integers are decimal, and floats
are rendered with 17 fractional digits in scientific notation with a
normalized exponent. Both implementations must agree byte for byte, because
the argument digest is a SHA-256 over exactly those bytes.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import time
from typing import Any, Tuple

TOKEN_VERSION = 1
NONCE_LEN = 16

# The `openssl pkeyutl` fallback needs a DER SubjectPublicKeyInfo for Ed25519:
# SEQUENCE { SEQUENCE { OID 1.3.101.112 }, BIT STRING (32 raw bytes) }.
ED25519_SPKI_PREFIX = bytes.fromhex("302a300506032b6570032100")


# --- canonical JSON -----------------------------------------------------------


def canonical_json(value: Any) -> str:
    """Render `value` as canonical JSON (sorted keys, no padding)."""
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int):
        # Rust stores integers as i64/u64; anything wider becomes a float on
        # the Rust side, so mirror that here to stay byte-identical.
        if -(2 ** 63) <= value < 2 ** 64:
            return str(value)
        return canonical_float(float(value))
    if isinstance(value, float):
        return canonical_float(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, list):
        return "[" + ",".join(canonical_json(item) for item in value) + "]"
    if isinstance(value, dict):
        items = sorted(value.items(), key=lambda pair: pair[0])
        return (
            "{"
            + ",".join(
                json.dumps(key, ensure_ascii=False) + ":" + canonical_json(item)
                for key, item in items
            )
            + "}"
        )
    raise TypeError(f"cannot canonicalize {type(value).__name__}")


def canonical_float(value: float) -> str:
    text = f"{value:.17e}"
    mantissa, _, exponent = text.partition("e")
    return f"{mantissa}e{normalize_exponent(exponent)}"


def normalize_exponent(exponent: str) -> str:
    sign = ""
    digits = exponent
    if digits.startswith("-"):
        sign, digits = "-", digits[1:]
    elif digits.startswith("+"):
        digits = digits[1:]
    digits = digits.lstrip("0") or "0"
    return f"{sign}{digits}"


def arg_digest_hex(args_json: str) -> str:
    """SHA-256 (hex) of the canonical JSON of the tool arguments."""
    arguments = json.loads(args_json)
    return hashlib.sha256(canonical_json(arguments).encode("utf-8")).hexdigest()


# --- Ed25519 verification backends ------------------------------------------


def verify_with_cryptography(public_key: bytes, signature: bytes, message: bytes) -> bool:
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

    try:
        Ed25519PublicKey.from_public_bytes(public_key).verify(signature, message)
        return True
    except InvalidSignature:
        return False


def verify_with_nacl(public_key: bytes, signature: bytes, message: bytes) -> bool:
    import nacl.exceptions
    import nacl.signing

    try:
        nacl.signing.VerifyKey(public_key).verify(message, signature)
        return True
    except nacl.exceptions.BadSignatureError:
        return False


def verify_with_openssl(public_key: bytes, signature: bytes, message: bytes) -> bool:
    with tempfile.TemporaryDirectory(prefix="capability-check-") as workdir:
        key_path = os.path.join(workdir, "public.der")
        sig_path = os.path.join(workdir, "signature.bin")
        msg_path = os.path.join(workdir, "message.bin")
        with open(key_path, "wb") as handle:
            handle.write(ED25519_SPKI_PREFIX + public_key)
        with open(sig_path, "wb") as handle:
            handle.write(signature)
        with open(msg_path, "wb") as handle:
            handle.write(message)
        result = subprocess.run(
            [
                "openssl",
                "pkeyutl",
                "-verify",
                "-pubin",
                "-inkey",
                key_path,
                "-rawin",
                "-in",
                msg_path,
                "-sigfile",
                sig_path,
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
    return result.returncode == 0


def verify_signature(public_key: bytes, signature: bytes, message: bytes) -> Tuple[bool, str]:
    """Verify an Ed25519 signature, reporting which backend was used."""
    try:
        import cryptography  # noqa: F401
    except ImportError:
        pass
    else:
        return verify_with_cryptography(public_key, signature, message), "cryptography"

    try:
        import nacl  # noqa: F401
    except ImportError:
        pass
    else:
        return verify_with_nacl(public_key, signature, message), "pynacl"

    return verify_with_openssl(public_key, signature, message), "openssl"


# --- verification -------------------------------------------------------------


class Invalid(Exception):
    """A verification failure with a human-readable reason."""


def parse_token(token: str) -> Tuple[int, dict, bytes]:
    try:
        document = json.loads(token)
    except json.JSONDecodeError as error:
        raise Invalid(f"invalid token json: {error}") from error
    if not isinstance(document, dict):
        raise Invalid("invalid token json: token must be a JSON object")

    version = document.get("v")
    if not isinstance(version, int) or isinstance(version, bool):
        raise Invalid("invalid token json: missing integer field `v`")
    if version != TOKEN_VERSION:
        raise Invalid(f"invalid token json: unsupported token version {version}")

    claims = document.get("claims")
    if not isinstance(claims, dict):
        raise Invalid("invalid token json: missing object field `claims`")
    for field in ("tool", "arg_digest_hex", "subject"):
        if not isinstance(claims.get(field), str):
            raise Invalid(f"invalid token json: claims.{field} must be a string")
    for field in ("issued_at_unix", "ttl_secs"):
        value = claims.get(field)
        if not isinstance(value, int) or isinstance(value, bool):
            raise Invalid(f"invalid token json: claims.{field} must be an integer")
    nonce = claims.get("nonce")
    if not isinstance(nonce, str) or len(nonce) != NONCE_LEN * 2:
        raise Invalid(f"invalid token json: claims.nonce must be {NONCE_LEN * 2} hex digits")

    signature_b64 = document.get("sig")
    if not isinstance(signature_b64, str):
        raise Invalid("invalid token json: missing string field `sig`")
    try:
        signature = base64.b64decode(signature_b64, validate=True)
    except (binascii.Error, ValueError) as error:
        raise Invalid(f"invalid token json: signature is not valid base64: {error}") from error
    if len(signature) != 64:
        raise Invalid(f"invalid token json: signature must be 64 bytes, got {len(signature)}")

    return version, claims, signature


def verify(
    token: str,
    public_key_hex: str,
    now: int,
    args_json: str | None = None,
) -> Tuple[bool, str, str, dict]:
    """Verify a token; returns (valid, backend, reason, claims)."""
    version, claims, signature = parse_token(token)

    try:
        public_key = bytes.fromhex(public_key_hex)
    except ValueError as error:
        raise Invalid(f"unknown public key: not hex: {error}") from error
    if len(public_key) != 32:
        raise Invalid(f"unknown public key: must be 32 bytes, got {len(public_key)}")

    body = canonical_json({"claims": claims, "v": version}).encode("utf-8")
    valid, backend = verify_signature(public_key, signature, body)
    if not valid:
        raise Invalid("bad signature: ed25519 signature does not cover the claims")

    issued_at = claims["issued_at_unix"]
    ttl = claims["ttl_secs"]
    if now < issued_at:
        raise Invalid(f"token not yet valid: issued_at {issued_at} is in the future (now {now})")
    if issued_at + ttl <= now:
        raise Invalid(f"token expired: issued_at {issued_at} + ttl {ttl} <= now {now}")

    if args_json is not None:
        try:
            digest = arg_digest_hex(args_json)
        except json.JSONDecodeError as error:
            raise Invalid(f"invalid arguments json: {error}") from error
        if digest != claims["arg_digest_hex"]:
            raise Invalid(
                "argument digest mismatch: "
                f"recomputed {digest}, claims say {claims['arg_digest_hex']}"
            )

    return True, backend, "", claims


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        description="Verify a Qwen RepE capability token without the Rust binary.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    verify_parser = subparsers.add_parser("verify", help="verify a capability token")
    verify_parser.add_argument("--token", required=True, help="the compact token JSON")
    verify_parser.add_argument("--public-key", required=True, help="issuer public key, hex")
    verify_parser.add_argument(
        "--args-json",
        default=None,
        help="tool arguments; their SHA-256 digest is recomputed and compared",
    )
    verify_parser.add_argument(
        "--now",
        type=int,
        default=None,
        help="verify at this unix time instead of now",
    )

    arguments = parser.parse_args(argv)
    now = arguments.now if arguments.now is not None else int(time.time())

    try:
        valid, backend, reason, claims = verify(
            arguments.token, arguments.public_key, now, arguments.args_json
        )
    except Invalid as error:
        print(f"INVALID: {error}")
        return 1

    if not valid:  # pragma: no cover - verify() raises instead
        print(f"INVALID: {reason}")
        return 1

    print("VALID")
    print(f"backend={backend}")
    if arguments.args_json is not None:
        print(f"arg_digest_match=yes ({claims['arg_digest_hex']})")
    print("claims=" + json.dumps(claims, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
