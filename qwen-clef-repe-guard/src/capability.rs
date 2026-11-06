//! Capability tokens: short-lived, Ed25519-signed authorizations for one tool call.
//!
//! A capability token says *"this exact tool call, with this exact argument
//! digest, was approved"*. The guard verifies tokens **offline** — no network,
//! no keychain round-trip — using only the issuer's public key and a clock.
//!
//! # Wire format
//!
//! ```text
//! {"v":1,"claims":{...},"sig":"<base64 Ed25519 signature>"}
//! ```
//!
//! The signature covers the canonical JSON bytes of `{"claims":…,"v":…}`.
//! Canonical JSON is: object keys sorted recursively, no insignificant
//! whitespace, strings escaped like `serde_json`, and numbers rendered by the
//! rules in [`canonical_json`]. The Rust signer and the independent Python
//! verifier (`tools/capability_check.py`) implement the same rules, so a
//! digest computed by one is byte-identical to the digest computed by the
//! other.
//!
//! # Where the approval came from
//!
//! * **Human step-up** — `tools/touchid_stepup.swift` performs a Touch ID
//!   gesture through LocalAuthentication and returns
//!   `STEPUP_OK <unix> <nonce>`. A human-approved token carries
//!   `subject = "human:touchid"`.
//! * **Policy-signed fallback** — biometrics are frequently unavailable (no
//!   enrolled Touch ID, a headless CLI, no GUI session). A trusted automated
//!   policy component may then mint the token itself with
//!   `subject = "policy:<name>"`. The guard must only accept subjects from
//!   its allowlist; a policy token is *not* a human approval and must never
//!   be reported as one.
//!
//! The subject lives inside the signed claims, so it cannot be rewritten by
//! anyone who does not hold the signing key.

#![allow(dead_code)]

use ring::rand::{SecureRandom, SystemRandom};
use ring::signature::{self, Ed25519KeyPair, KeyPair, UnparsedPublicKey};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

/// Current capability-token wire version.
pub const TOKEN_VERSION: u32 = 1;

/// Length of the per-token nonce, in bytes.
pub const NONCE_LEN: usize = 16;

/// The authorization carried by one capability token.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CapabilityClaims {
    /// Tool the approval applies to (for example `fs.write`).
    pub tool: String,
    /// SHA-256 (lowercase hex) of the canonical JSON of the tool arguments.
    pub arg_digest_hex: String,
    /// Unix seconds at which the token was minted.
    pub issued_at_unix: i64,
    /// Lifetime in seconds, counted from `issued_at_unix`.
    pub ttl_secs: i64,
    /// Random per-token nonce; hex-encoded on the wire.
    #[serde(with = "hex_nonce")]
    pub nonce: [u8; NONCE_LEN],
    /// Who authorized the call (`human:touchid`, `policy:<name>`, …).
    pub subject: String,
}

/// Structured failure modes for token verification.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CapabilityError {
    /// The token is not well-formed JSON, or its fields are malformed.
    InvalidJson(String),
    /// The Ed25519 signature does not match the claims.
    BadSignature(String),
    /// The token's lifetime has elapsed.
    Expired(String),
    /// The token was issued in the future relative to the verifier's clock.
    NotYetValid(String),
    /// The supplied public key is unusable (not hex, or not 32 bytes).
    UnknownKey(String),
}

impl std::fmt::Display for CapabilityError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CapabilityError::InvalidJson(m) => write!(f, "invalid token json: {m}"),
            CapabilityError::BadSignature(m) => write!(f, "bad signature: {m}"),
            CapabilityError::Expired(m) => write!(f, "token expired: {m}"),
            CapabilityError::NotYetValid(m) => write!(f, "token not yet valid: {m}"),
            CapabilityError::UnknownKey(m) => write!(f, "unknown public key: {m}"),
        }
    }
}

impl std::error::Error for CapabilityError {}

/// An Ed25519 key pair able to mint capability tokens.
pub struct CapabilitySigner {
    key: Ed25519KeyPair,
}

impl CapabilitySigner {
    /// Generates a fresh key pair. The PKCS#8 encoding is discarded; use
    /// [`CapabilitySigner::generate_with_pkcs8`] when it must be exported.
    pub fn generate() -> Result<Self, String> {
        Self::generate_with_pkcs8().map(|(signer, _pkcs8)| signer)
    }

    /// Generates a fresh key pair and returns it with its PKCS#8 encoding.
    ///
    /// The document ring produces is PKCS#8 v2 (it carries the public key), so
    /// it round-trips through [`CapabilitySigner::from_pkcs8`].
    pub fn generate_with_pkcs8() -> Result<(Self, Vec<u8>), String> {
        let rng = SystemRandom::new();
        let document = Ed25519KeyPair::generate_pkcs8(&rng)
            .map_err(|e| format!("ed25519 key generation failed: {e}"))?;
        let pkcs8 = document.as_ref().to_vec();
        let key = Ed25519KeyPair::from_pkcs8(&pkcs8)
            .map_err(|e| format!("freshly generated pkcs#8 was rejected: {e}"))?;
        Ok((Self { key }, pkcs8))
    }

    /// Loads a signer from a PKCS#8 v2 Ed25519 private key.
    pub fn from_pkcs8(bytes: &[u8]) -> Result<Self, String> {
        let key = Ed25519KeyPair::from_pkcs8(bytes)
            .map_err(|e| format!("invalid pkcs#8 ed25519 private key: {e}"))?;
        Ok(Self { key })
    }

    /// Loads a signer from a 32-byte seed (deterministic key).
    pub fn from_seed(seed: &[u8; 32]) -> Result<Self, String> {
        let key = Ed25519KeyPair::from_seed_unchecked(seed)
            .map_err(|e| format!("invalid ed25519 seed: {e}"))?;
        Ok(Self { key })
    }

    /// Hex-encoded public key; this is what a verifier needs.
    pub fn public_key_hex(&self) -> String {
        hex_encode(self.key.public_key().as_ref())
    }

    /// Signs `claims` and returns the compact token JSON.
    pub fn sign(&self, claims: &CapabilityClaims) -> String {
        let body = signing_body(TOKEN_VERSION, claims);
        let signature = self.key.sign(body.as_bytes());
        let token = json!({
            "v": TOKEN_VERSION,
            "claims": claims,
            "sig": base64_encode(signature.as_ref()),
        });
        serde_json::to_string(&token).expect("capability token is serializable")
    }

    /// Verifies a token against this signer's own public key, using the
    /// current clock.
    pub fn verify_token(&self, token: &str) -> Result<CapabilityClaims, String> {
        verify(token, &self.public_key_hex())
    }
}

/// Canonical bytes that the Ed25519 signature covers: `{"claims":…,"v":…}`.
fn signing_body(version: u32, claims: &CapabilityClaims) -> String {
    let body = json!({
        "v": version,
        "claims": serde_json::to_value(claims).expect("claims are serializable"),
    });
    canonical_json(&body)
}

/// Verifies a token against `public_key_hex` using the current clock.
pub fn verify(token: &str, public_key_hex: &str) -> Result<CapabilityClaims, String> {
    parse_and_verify(token, public_key_hex, now_unix()).map_err(|e| e.to_string())
}

/// Verifies a token against `public_key_hex` at an explicit time.
///
/// The token is rejected when it has expired (`issued_at + ttl <= now`) or
/// when it was issued in the future (`now < issued_at`).
pub fn verify_at(
    token: &str,
    public_key_hex: &str,
    now_unix: i64,
) -> Result<CapabilityClaims, String> {
    parse_and_verify(token, public_key_hex, now_unix).map_err(|e| e.to_string())
}

/// Verifies a token and reports why it failed.
pub fn parse_and_verify(
    token: &str,
    public_key_hex: &str,
    now_unix: i64,
) -> Result<CapabilityClaims, CapabilityError> {
    let raw: Value = serde_json::from_str(token)
        .map_err(|e| CapabilityError::InvalidJson(format!("{e}")))?;
    let object = raw
        .as_object()
        .ok_or_else(|| CapabilityError::InvalidJson("token must be a JSON object".into()))?;

    let version = object
        .get("v")
        .and_then(Value::as_u64)
        .ok_or_else(|| CapabilityError::InvalidJson("missing integer field `v`".into()))?;
    if version != u64::from(TOKEN_VERSION) {
        return Err(CapabilityError::InvalidJson(format!(
            "unsupported token version {version}"
        )));
    }

    let claims_value = object
        .get("claims")
        .ok_or_else(|| CapabilityError::InvalidJson("missing field `claims`".into()))?;
    let claims: CapabilityClaims = serde_json::from_value(claims_value.clone())
        .map_err(|e| CapabilityError::InvalidJson(format!("invalid claims: {e}")))?;

    let signature_b64 = object
        .get("sig")
        .and_then(Value::as_str)
        .ok_or_else(|| CapabilityError::InvalidJson("missing string field `sig`".into()))?;
    let signature_bytes = base64_decode(signature_b64)
        .map_err(|e| CapabilityError::InvalidJson(format!("invalid base64 signature: {e}")))?;

    let public_key = hex_decode(public_key_hex)
        .map_err(|e| CapabilityError::UnknownKey(format!("public key is not hex: {e}")))?;
    if public_key.len() != 32 {
        return Err(CapabilityError::UnknownKey(format!(
            "public key must be 32 bytes, got {}",
            public_key.len()
        )));
    }

    // The signed bytes are rebuilt from the *parsed* claims, so any field the
    // issuer did not sign (an injected claim, a re-ordered object) changes
    // the bytes and fails the signature check.
    let body = canonical_json(&json!({ "v": version, "claims": claims_value }));
    UnparsedPublicKey::new(&signature::ED25519, &public_key)
        .verify(body.as_bytes(), &signature_bytes)
        .map_err(|_| {
            CapabilityError::BadSignature(
                "ed25519 signature does not cover the claims".into(),
            )
        })?;

    if now_unix < claims.issued_at_unix {
        return Err(CapabilityError::NotYetValid(format!(
            "issued_at {} is in the future (now {now_unix})",
            claims.issued_at_unix
        )));
    }
    if claims.issued_at_unix.saturating_add(claims.ttl_secs) <= now_unix {
        return Err(CapabilityError::Expired(format!(
            "issued_at {} + ttl {} <= now {now_unix}",
            claims.issued_at_unix, claims.ttl_secs
        )));
    }

    Ok(claims)
}

/// SHA-256 (lowercase hex) of the canonical JSON of the given arguments.
pub fn arg_digest_hex(args_json: &str) -> Result<String, String> {
    let value: Value =
        serde_json::from_str(args_json).map_err(|e| format!("arguments are not valid JSON: {e}"))?;
    Ok(sha256_hex(canonical_json(&value).as_bytes()))
}

/// SHA-256 (lowercase hex) of arbitrary bytes.
pub fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hex_encode(&hasher.finalize())
}

/// A fresh random nonce.
pub fn random_nonce() -> Result<[u8; NONCE_LEN], String> {
    let mut nonce = [0u8; NONCE_LEN];
    SystemRandom::new()
        .fill(&mut nonce)
        .map_err(|_| "system random number generator is unavailable".to_string())?;
    Ok(nonce)
}

/// Current unix time in seconds.
pub fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Canonical JSON: object keys sorted recursively, no insignificant whitespace.
///
/// Number rules (kept identical in `tools/capability_check.py`):
///
/// * integers are rendered in decimal; integers outside the `i64`/`u64`
///   range fall back to the float rule;
/// * floats are rendered as `mantissa e exponent` with 17 fractional digits
///   (correctly rounded, half-to-even) and a normalized exponent — no `+`
///   sign, no leading zeros — so Rust and Python agree byte for byte.
pub fn canonical_json(value: &Value) -> String {
    let mut out = String::new();
    write_canonical(value, &mut out);
    out
}

fn write_canonical(value: &Value, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(number) => out.push_str(&canonical_number(number)),
        Value::String(text) => out.push_str(&serde_json::to_string(text).expect("string serializes")),
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_canonical(item, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            out.push('{');
            for (index, key) in keys.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(key.as_str()).expect("key serializes"));
                out.push(':');
                write_canonical(&map[*key], out);
            }
            out.push('}');
        }
    }
}

fn canonical_number(number: &serde_json::Number) -> String {
    if let Some(value) = number.as_u64() {
        return value.to_string();
    }
    if let Some(value) = number.as_i64() {
        return value.to_string();
    }
    canonical_float(number.as_f64().unwrap_or(0.0))
}

fn canonical_float(value: f64) -> String {
    let text = format!("{value:.17e}");
    match text.split_once('e') {
        Some((mantissa, exponent)) => format!("{mantissa}e{}", normalize_exponent(exponent)),
        None => text,
    }
}

fn normalize_exponent(exponent: &str) -> String {
    let (sign, digits) = match exponent.strip_prefix('-') {
        Some(rest) => ("-", rest),
        None => ("", exponent.strip_prefix('+').unwrap_or(exponent)),
    };
    let trimmed = digits.trim_start_matches('0');
    let digits = if trimmed.is_empty() { "0" } else { trimmed };
    format!("{sign}{digits}")
}

const BASE64_ALPHABET: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Standard base64 with padding.
pub fn base64_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(BASE64_ALPHABET[((triple >> 18) & 0x3f) as usize] as char);
        out.push(BASE64_ALPHABET[((triple >> 12) & 0x3f) as usize] as char);
        out.push(if chunk.len() > 1 {
            BASE64_ALPHABET[((triple >> 6) & 0x3f) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            BASE64_ALPHABET[(triple & 0x3f) as usize] as char
        } else {
            '='
        });
    }
    out
}

/// Decodes standard base64 with padding.
pub fn base64_decode(text: &str) -> Result<Vec<u8>, String> {
    let mut accumulator: u32 = 0;
    let mut bits: u32 = 0;
    let mut padding = 0usize;
    let mut out = Vec::with_capacity(text.len() * 3 / 4 + 3);
    for character in text.chars() {
        if character == '=' {
            padding += 1;
            continue;
        }
        if padding > 0 {
            return Err("base64: data after padding".into());
        }
        let value = match character {
            'A'..='Z' => character as u32 - 'A' as u32,
            'a'..='z' => character as u32 - 'a' as u32 + 26,
            '0'..='9' => character as u32 - '0' as u32 + 52,
            '+' => 62,
            '/' => 63,
            other => return Err(format!("base64: invalid character {other:?}")),
        };
        accumulator = (accumulator << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((accumulator >> bits) & 0xff) as u8);
            accumulator &= (1u32 << bits) - 1;
        }
    }
    if bits >= 6 {
        return Err("base64: truncated input".into());
    }
    Ok(out)
}

/// Lowercase hex encoding.
pub fn hex_encode(data: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(data.len() * 2);
    for byte in data {
        out.push(DIGITS[(byte >> 4) as usize] as char);
        out.push(DIGITS[(byte & 0x0f) as usize] as char);
    }
    out
}

/// Hex decoding (case-insensitive).
pub fn hex_decode(text: &str) -> Result<Vec<u8>, String> {
    if text.len() % 2 != 0 {
        return Err("hex: odd number of digits".into());
    }
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len() / 2);
    for pair in bytes.chunks(2) {
        let high = hex_value(pair[0])?;
        let low = hex_value(pair[1])?;
        out.push((high << 4) | low);
    }
    Ok(out)
}

fn hex_value(byte: u8) -> Result<u8, String> {
    match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'a'..=b'f' => Ok(byte - b'a' + 10),
        b'A'..=b'F' => Ok(byte - b'A' + 10),
        other => Err(format!("hex: invalid character {:?}", other as char)),
    }
}

/// Serde helper: the nonce travels as lowercase hex.
mod hex_nonce {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(
        bytes: &[u8; super::NONCE_LEN],
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&super::hex_encode(bytes))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<[u8; super::NONCE_LEN], D::Error> {
        let text = String::deserialize(deserializer)?;
        let raw = super::hex_decode(&text).map_err(serde::de::Error::custom)?;
        if raw.len() != super::NONCE_LEN {
            return Err(serde::de::Error::custom(format!(
                "nonce must be {} bytes, got {}",
                super::NONCE_LEN,
                raw.len()
            )));
        }
        let mut nonce = [0u8; super::NONCE_LEN];
        nonce.copy_from_slice(&raw);
        Ok(nonce)
    }
}
