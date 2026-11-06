//! Device-bound sessions for the guard's public surface.
//!
//! A session here is **not an identity**. Nobody signs in, there is no
//! account, no email and no personal data — the guard learns nothing about
//! who the visitor is. A session is a server-issued capability that says
//! "this device was admitted to the demo", and it is bound to the device in
//! two ways:
//!
//! * the cookie carries the device hash and is signed with an HMAC over a
//!   server secret, so it cannot be forged, edited, or pointed at
//!   somebody else's session;
//! * the device hash mixes a second, device-only cookie with the
//!   request's user-agent, so a session cookie copied into another browser
//!   does not work on its own — the pair has to travel together, from the
//!   same browser.
//!
//! The session is **stateless**. The cookie carries its own claims
//! (id, device hash, issue time, expiry) and the signature over them, so
//! the guard keeps no session table and a restart does not end every
//! session. Revocation is therefore coarse: rotating the signing secret
//! ends every session at once, and `SessionIssuer::revoke` ends one.
//!
//! What this defends against: a shared or replayed cookie, a session
//! aimed at another visitor's record, and a client that never went through
//! the admission step at all.
//!
//! What this does **not** defend against: an attacker who holds both
//! cookies and presents the same user-agent, or an attacker who drives a
//! real browser themselves. It is an admission step and an accounting
//! mechanism, not an identity system.
//!
//! The rate limiting that protects a public deployment lives at the edge —
//! at Caddy, keyed by client IP. See `deploy/README.md`.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use ring::hmac;
use ring::rand::{SecureRandom, SystemRandom};

/// The cookie that carries the signed session.
pub const DEFAULT_SESSION_COOKIE: &str = "zcode_sid";

/// The cookie that carries the device binding value.
pub const DEFAULT_DEVICE_COOKIE: &str = "zcode_dev";

/// How long a device cookie lives. Long on purpose: it is the device
/// half of the binding, and it is not a credential by itself.
pub const DEVICE_COOKIE_MAX_AGE_SECS: u64 = 60 * 60 * 24 * 365;

/// How the session machinery is configured.
#[derive(Debug, Clone)]
pub struct SessionConfig {
    /// The cookie carrying the signed session.
    pub session_cookie: String,
    /// The cookie carrying the device binding value.
    pub device_cookie: String,
    /// How long a session lives.
    pub ttl: Duration,
    /// The HMAC key. Sessions only survive a restart when this is stable,
    /// which is why it can be supplied from a file.
    pub secret: Vec<u8>,
    /// Whether sessions can be minted at all. When this is off, the
    /// bearer token is the only way in — which is the private-deployment
    /// posture.
    pub enabled: bool,
    /// Whether the cookies carry the `Secure` attribute.
    ///
    /// True by default: the public deployment is behind TLS. Browsers
    /// accept `Secure` cookies on `http://localhost`, so a local run does
    /// not need to turn it off.
    pub cookie_secure: bool,
}

impl Default for SessionConfig {
    fn default() -> Self {
        Self {
            session_cookie: DEFAULT_SESSION_COOKIE.to_string(),
            device_cookie: DEFAULT_DEVICE_COOKIE.to_string(),
            ttl: Duration::from_secs(3600),
            secret: random_bytes(32),
            enabled: true,
            cookie_secure: true,
        }
    }
}

/// What a session cookie says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionClaims {
    /// A random id. It identifies the session; it is not a secret on its
    /// own.
    pub id: String,
    /// The device hash this session is bound to.
    pub device_hash: String,
    /// When the session was minted, in Unix seconds.
    pub issued_at: u64,
    /// When the session expires, in Unix seconds.
    pub expires_at: u64,
}

impl SessionClaims {
    /// How many seconds are left, as of `now`.
    pub fn expires_in_secs(&self, now: u64) -> u64 {
        self.expires_at.saturating_sub(now)
    }
}

/// The outcome of resolving a session cookie.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionLookup {
    /// The session is live and the device matches.
    Active(SessionClaims),
    /// No session cookie was presented.
    Missing,
    /// The cookie was malformed, the signature did not match, or the
    /// session was revoked.
    Invalid,
    /// The signature was good but the device does not match — the cookie
    /// was replayed into a different browser.
    WrongDevice,
    /// The session was real but has expired.
    Expired,
}

/// A freshly minted session, ready to be handed to the client.
#[derive(Debug, Clone)]
pub struct IssuedSession {
    /// The claims the cookie carries.
    pub claims: SessionClaims,
    /// The signed cookie value.
    pub cookie_value: String,
}

/// Mints and verifies sessions.
///
/// The session table is only a list of revoked ids — the sessions
/// themselves live in their own signed cookies.
#[derive(Debug)]
pub struct SessionIssuer {
    config: SessionConfig,
    revoked: Mutex<HashSet<String>>,
}

impl SessionIssuer {
    /// An issuer with the given configuration.
    pub fn new(config: SessionConfig) -> Self {
        Self {
            config,
            revoked: Mutex::new(HashSet::new()),
        }
    }

    /// The configuration in force.
    pub fn config(&self) -> &SessionConfig {
        &self.config
    }

    /// Whether sessions can be minted.
    pub fn enabled(&self) -> bool {
        self.config.enabled
    }

    /// Mint a session bound to `device_hash`.
    pub fn issue(&self, device_hash: &str) -> IssuedSession {
        let now = unix_now();
        let claims = SessionClaims {
            id: random_hex(16),
            device_hash: device_hash.to_string(),
            issued_at: now,
            expires_at: now + self.config.ttl.as_secs(),
        };
        let cookie_value = format!(
            "{}.{}.{}.{}.{}",
            claims.id,
            claims.device_hash,
            claims.issued_at,
            claims.expires_at,
            sign(&self.config.secret, &claims)
        );
        IssuedSession {
            claims,
            cookie_value,
        }
    }

    /// Resolve a session cookie against the device that presented it.
    pub fn lookup(
        &self,
        cookie_value: Option<&str>,
        device_hash: &str,
        now: u64,
    ) -> SessionLookup {
        let Some(raw) = cookie_value else {
            return SessionLookup::Missing;
        };
        let parts: Vec<&str> = raw.split('.').collect();
        if parts.len() != 5 {
            return SessionLookup::Invalid;
        }
        let (id, stored_hash, issued_at, expires_at, signature) =
            (parts[0], parts[1], parts[2], parts[3], parts[4]);

        let (Ok(issued_at), Ok(expires_at)) =
            (issued_at.parse::<u64>(), expires_at.parse::<u64>())
        else {
            return SessionLookup::Invalid;
        };
        if id.is_empty() || stored_hash.is_empty() {
            return SessionLookup::Invalid;
        }

        let claims = SessionClaims {
            id: id.to_string(),
            device_hash: stored_hash.to_string(),
            issued_at,
            expires_at,
        };

        // The signature covers the device hash, so a cookie minted for one
        // device cannot be re-pointed at another. Verify it against the
        // hash the cookie carries, then compare that hash with the one
        // recomputed from this request — that way a genuine cookie used on
        // the wrong browser is reported as such rather than as forged.
        if !verify(&self.config.secret, &claims, signature) {
            return SessionLookup::Invalid;
        }
        if self.is_revoked(id) {
            return SessionLookup::Invalid;
        }
        if claims.expires_at <= now {
            return SessionLookup::Expired;
        }
        if claims.device_hash != device_hash {
            return SessionLookup::WrongDevice;
        }
        SessionLookup::Active(claims)
    }

    /// End one session.
    pub fn revoke(&self, id: &str) {
        let mut revoked = self.revoked.lock().unwrap_or_else(|e| e.into_inner());
        revoked.insert(id.to_string());
    }

    /// How many sessions have been revoked.
    pub fn revoked_count(&self) -> usize {
        self.revoked.lock().unwrap_or_else(|e| e.into_inner()).len()
    }

    /// Whether a session id has been revoked.
    fn is_revoked(&self, id: &str) -> bool {
        self.revoked
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains(id)
    }
}

/// The hash that ties a session to a device.
///
/// It mixes the device cookie with the request's user-agent and
/// accept-language. The device cookie is the server's own random value,
/// so two browsers on the same machine still get different bindings; the
/// user-agent means the same cookie replayed from a different client does
/// not line up either.
pub fn device_hash(device_cookie: &str, user_agent: &str, accept_language: &str) -> String {
    let mut buf =
        Vec::with_capacity(device_cookie.len() + user_agent.len() + accept_language.len() + 2);
    buf.extend_from_slice(device_cookie.as_bytes());
    buf.push(0);
    buf.extend_from_slice(user_agent.as_bytes());
    buf.push(0);
    buf.extend_from_slice(accept_language.as_bytes());
    hex(&sha256(&buf))
}

/// Sign a set of claims.
fn sign(secret: &[u8], claims: &SessionClaims) -> String {
    let key = hmac::Key::new(hmac::HMAC_SHA256, secret);
    hex(hmac::sign(&key, &claims_bytes(claims)).as_ref())
}

/// Check a signature over a set of claims.
fn verify(secret: &[u8], claims: &SessionClaims, signature: &str) -> bool {
    let Some(signature) = hex_decode(signature) else {
        return false;
    };
    let key = hmac::Key::new(hmac::HMAC_SHA256, secret);
    hmac::verify(&key, &claims_bytes(claims), &signature).is_ok()
}

/// The bytes the signature covers.
fn claims_bytes(claims: &SessionClaims) -> Vec<u8> {
    let mut buf = Vec::with_capacity(claims.id.len() + claims.device_hash.len() + 32);
    buf.extend_from_slice(claims.id.as_bytes());
    buf.push(0);
    buf.extend_from_slice(claims.device_hash.as_bytes());
    buf.push(0);
    buf.extend_from_slice(claims.issued_at.to_string().as_bytes());
    buf.push(0);
    buf.extend_from_slice(claims.expires_at.to_string().as_bytes());
    buf
}

/// The current time in Unix seconds.
pub fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// A SHA-256 digest.
fn sha256(data: &[u8]) -> Vec<u8> {
    ring::digest::digest(&ring::digest::SHA256, data).as_ref().to_vec()
}

/// Cryptographically random bytes.
fn random_bytes(n: usize) -> Vec<u8> {
    let mut buf = vec![0u8; n];
    let rng = SystemRandom::new();
    // `SystemRandom::fill` only fails if the OS RNG is broken, in which
    // case there is nothing sensible to do but refuse to continue.
    rng.fill(&mut buf).expect("the OS random number generator failed");
    buf
}

/// Random bytes as lowercase hex.
pub fn random_hex(n_bytes: usize) -> String {
    hex(&random_bytes(n_bytes))
}

/// Lowercase hex.
pub fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(DIGITS[(byte >> 4) as usize] as char);
        out.push(DIGITS[(byte & 0x0f) as usize] as char);
    }
    out
}

/// Decode lowercase or uppercase hex.
pub fn hex_decode(text: &str) -> Option<Vec<u8>> {
    if text.len() % 2 != 0 {
        return None;
    }
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(text.len() / 2);
    for pair in bytes.chunks(2) {
        let hi = (pair[0] as char).to_digit(16)?;
        let lo = (pair[1] as char).to_digit(16)?;
        out.push(((hi << 4) | lo) as u8);
    }
    Some(out)
}

/// Parse a `Cookie` header into its name/value pairs.
///
/// A tiny hand-rolled parser: the header is a flat list of `name=value`
/// pairs separated by `;`, and adding a dependency for it would be
/// silly.
pub fn parse_cookies(header: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for part in header.split(';') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        let Some((name, value)) = part.split_once('=') else {
            continue;
        };
        let name = name.trim();
        if name.is_empty() {
            continue;
        }
        out.insert(name.to_string(), value.trim().to_string());
    }
    out
}

/// Build a `Set-Cookie` header value.
pub fn set_cookie(name: &str, value: &str, max_age_secs: u64, secure: bool) -> String {
    let mut out =
        format!("{name}={value}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age_secs}");
    if secure {
        out.push_str("; Secure");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn issuer() -> SessionIssuer {
        SessionIssuer::new(SessionConfig {
            secret: b"a-test-secret-that-is-long-enough".to_vec(),
            ..SessionConfig::default()
        })
    }

    #[test]
    fn a_minted_session_resolves_for_its_own_device() {
        let issuer = issuer();
        let hash = device_hash("dev-1", "Mozilla/5.0", "en");
        let issued = issuer.issue(&hash);
        match issuer.lookup(Some(&issued.cookie_value), &hash, unix_now()) {
            SessionLookup::Active(claims) => {
                assert_eq!(claims.id, issued.claims.id);
                assert_eq!(claims.device_hash, hash);
            }
            other => panic!("expected an active session, got {other:?}"),
        }
    }

    #[test]
    fn a_session_replayed_into_another_device_is_refused() {
        let issuer = issuer();
        let hash = device_hash("dev-1", "Mozilla/5.0", "en");
        let issued = issuer.issue(&hash);
        let other = device_hash("dev-2", "Mozilla/5.0", "en");
        assert_eq!(
            issuer.lookup(Some(&issued.cookie_value), &other, unix_now()),
            SessionLookup::WrongDevice
        );
    }

    #[test]
    fn a_session_replayed_with_another_user_agent_is_refused() {
        let issuer = issuer();
        let hash = device_hash("dev-1", "Mozilla/5.0", "en");
        let issued = issuer.issue(&hash);
        let other = device_hash("dev-1", "curl/8.0", "en");
        assert_eq!(
            issuer.lookup(Some(&issued.cookie_value), &other, unix_now()),
            SessionLookup::WrongDevice
        );
    }

    #[test]
    fn a_forged_cookie_is_refused() {
        let issuer = issuer();
        let hash = device_hash("dev-1", "Mozilla/5.0", "en");
        let forged = format!("{}.{}.{}.{}.{}", "a".repeat(32), hash, 0, 0, "00".repeat(32));
        assert_eq!(
            issuer.lookup(Some(&forged), &hash, unix_now()),
            SessionLookup::Invalid
        );
        // A real session id with a mangled signature.
        let issued = issuer.issue(&hash);
        let mangled = issued
            .cookie_value
            .split('.')
            .enumerate()
            .map(|(i, part)| {
                if i == 4 {
                    "ff".repeat(32)
                } else {
                    part.to_string()
                }
            })
            .collect::<Vec<_>>()
            .join(".");
        assert_eq!(
            issuer.lookup(Some(&mangled), &hash, unix_now()),
            SessionLookup::Invalid
        );
        assert_eq!(
            issuer.lookup(Some("not-a-cookie"), &hash, unix_now()),
            SessionLookup::Invalid
        );
        assert_eq!(
            issuer.lookup(None, &hash, unix_now()),
            SessionLookup::Missing
        );
    }

    #[test]
    fn a_signature_does_not_transfer_to_another_session_id() {
        let issuer = issuer();
        let hash = device_hash("dev-1", "Mozilla/5.0", "en");
        let first = issuer.issue(&hash);
        let second = issuer.issue(&hash);
        let parts: Vec<&str> = first.cookie_value.split('.').collect();
        let swapped = format!(
            "{}.{}.{}.{}.{}",
            second.claims.id, parts[1], parts[2], parts[3], parts[4]
        );
        assert_eq!(
            issuer.lookup(Some(&swapped), &hash, unix_now()),
            SessionLookup::Invalid
        );
    }

    #[test]
    fn a_signature_does_not_transfer_to_another_device_hash() {
        let issuer = issuer();
        let hash = device_hash("dev-1", "Mozilla/5.0", "en");
        let other = device_hash("dev-2", "Mozilla/5.0", "en");
        let issued = issuer.issue(&hash);
        let parts: Vec<&str> = issued.cookie_value.split('.').collect();
        let swapped = format!(
            "{}.{}.{}.{}.{}",
            parts[0], other, parts[2], parts[3], parts[4]
        );
        assert_eq!(
            issuer.lookup(Some(&swapped), &other, unix_now()),
            SessionLookup::Invalid
        );
    }

    #[test]
    fn an_expired_session_is_refused() {
        let issuer = issuer();
        let hash = device_hash("dev-1", "Mozilla/5.0", "en");
        let issued = issuer.issue(&hash);
        let later = issued.claims.expires_at + 1;
        assert_eq!(
            issuer.lookup(Some(&issued.cookie_value), &hash, later),
            SessionLookup::Expired
        );
    }

    #[test]
    fn a_revoked_session_is_refused() {
        let issuer = issuer();
        let hash = device_hash("dev-1", "Mozilla/5.0", "en");
        let issued = issuer.issue(&hash);
        issuer.revoke(&issued.claims.id);
        assert_eq!(
            issuer.lookup(Some(&issued.cookie_value), &hash, unix_now()),
            SessionLookup::Invalid
        );
        assert_eq!(issuer.revoked_count(), 1);
    }

    #[test]
    fn a_session_survives_a_restart_when_the_secret_is_stable() {
        // Two issuers with the same secret are what a restart looks like:
        // the second knows nothing about the first's sessions, so the
        // session has to be self-describing.
        let config = SessionConfig {
            secret: b"stable".to_vec(),
            ..SessionConfig::default()
        };
        let before = SessionIssuer::new(config.clone());
        let hash = device_hash("dev-1", "Mozilla/5.0", "en");
        let issued = before.issue(&hash);

        let after = SessionIssuer::new(config);
        assert!(matches!(
            after.lookup(Some(&issued.cookie_value), &hash, unix_now()),
            SessionLookup::Active(_)
        ));
    }

    #[test]
    fn a_session_does_not_survive_a_restart_that_rotates_the_secret() {
        let before = SessionIssuer::new(SessionConfig {
            secret: b"old".to_vec(),
            ..SessionConfig::default()
        });
        let hash = device_hash("dev-1", "Mozilla/5.0", "en");
        let issued = before.issue(&hash);

        let after = SessionIssuer::new(SessionConfig {
            secret: b"new".to_vec(),
            ..SessionConfig::default()
        });
        assert_eq!(
            after.lookup(Some(&issued.cookie_value), &hash, unix_now()),
            SessionLookup::Invalid
        );
    }

    #[test]
    fn the_device_hash_separates_devices_and_browsers() {
        let a = device_hash("dev-1", "Mozilla/5.0", "en");
        let b = device_hash("dev-2", "Mozilla/5.0", "en");
        let c = device_hash("dev-1", "curl/8.0", "en");
        assert_ne!(a, b);
        assert_ne!(a, c);
        assert_eq!(a, device_hash("dev-1", "Mozilla/5.0", "en"));
    }

    #[test]
    fn cookies_are_parsed() {
        let parsed = parse_cookies("zcode_sid=abc.def; zcode_dev=1234; other=");
        assert_eq!(parsed.get("zcode_sid").map(String::as_str), Some("abc.def"));
        assert_eq!(parsed.get("zcode_dev").map(String::as_str), Some("1234"));
        assert_eq!(parsed.get("other").map(String::as_str), Some(""));
        assert!(parse_cookies("").is_empty());
        assert!(parse_cookies("garbage").is_empty());
    }

    #[test]
    fn hex_round_trips() {
        let bytes = vec![0u8, 1, 15, 16, 255];
        let text = hex(&bytes);
        assert_eq!(text, "00010f10ff");
        assert_eq!(hex_decode(&text).unwrap(), bytes);
        assert!(hex_decode("xyz").is_none());
        assert!(hex_decode("abc").is_none());
    }

    #[test]
    fn the_set_cookie_header_carries_the_right_flags() {
        let header = set_cookie("zcode_sid", "abc", 60, true);
        assert!(header.starts_with("zcode_sid=abc"));
        assert!(header.contains("HttpOnly"));
        assert!(header.contains("SameSite=Lax"));
        assert!(header.contains("Max-Age=60"));
        assert!(header.contains("Secure"));
        let insecure = set_cookie("zcode_sid", "abc", 60, false);
        assert!(!insecure.contains("Secure"));
    }

    #[test]
    fn two_issuers_with_different_secrets_do_not_accept_each_other_sessions() {
        let a = SessionIssuer::new(SessionConfig {
            secret: b"secret-a".to_vec(),
            ..SessionConfig::default()
        });
        let b = SessionIssuer::new(SessionConfig {
            secret: b"secret-b".to_vec(),
            ..SessionConfig::default()
        });
        let hash = device_hash("dev-1", "Mozilla/5.0", "en");
        let issued = a.issue(&hash);
        assert_eq!(
            b.lookup(Some(&issued.cookie_value), &hash, unix_now()),
            SessionLookup::Invalid
        );
    }
}
