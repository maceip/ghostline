//! Access control for the guard's HTTP surface.
//!
//! Two independent layers, both **off by default** so that a local run and
//! the benchmark harnesses behave exactly as they did before:
//!
//! * **Bearer authentication** — every route except `/health` requires
//!   `Authorization: Bearer <token>`. The comparison runs over SHA-256
//!   digests in constant time, so neither the token nor its length leaks
//!   through the response time.
//! * **Rate limiting** — a sliding one-minute window per client. This is
//!   the layer that actually protects a publicly reachable guard, because
//!   the expensive part is the LLM inference behind `/v1/chat/completions`,
//!   not the token check.
//!
//! The client identity is taken from the socket peer, unless the guard is
//! told to trust a reverse proxy, in which case the **right-most**
//! `X-Forwarded-For` entry is used. The right-most entry is the one the
//! nearest proxy actually observed; everything to its left was supplied by
//! the client and can be forged.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

/// The window the rate limiter counts over.
pub const RATE_WINDOW: Duration = Duration::from_secs(60);

/// How many distinct clients the limiter tracks before it starts evicting.
/// Without a bound, an attacker could grow the map without limit by
/// rotating source addresses.
const MAX_TRACKED_CLIENTS: usize = 4096;

/// What the guard is willing to accept.
#[derive(Debug, Clone, Default)]
pub struct AccessConfig {
    /// The bearer token. `None` disables authentication entirely.
    pub token: Option<String>,
    /// Requests per client per minute. `None` disables rate limiting.
    pub rate_limit_per_minute: Option<u32>,
    /// Whether `X-Forwarded-For` may be used for client identity.
    pub trust_proxy: bool,
    /// Whether the forwarded header is trusted from a NON-loopback peer too.
    ///
    /// Off by default.  See [`client_key`] for why the header is only
    /// trusted from this machine unless this is turned on.
    pub trust_any_peer: bool,
}

impl AccessConfig {
    /// Whether any access control is active at all.
    pub fn is_enabled(&self) -> bool {
        self.token.is_some() || self.rate_limit_per_minute.is_some()
    }

    /// The token, if one is configured.
    pub fn token(&self) -> Option<&str> {
        self.token.as_deref()
    }
}

/// The result of checking an `Authorization` header.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthOutcome {
    /// The bearer token matched.
    Ok,
    /// No `Authorization` header was sent.
    Missing,
    /// The header was present but was not a bearer credential.
    Malformed,
    /// A bearer token was sent but it was not the expected one.
    Mismatch,
}

impl AuthOutcome {
    /// The HTTP status this outcome is served with.
    pub fn status(&self) -> u16 {
        match self {
            AuthOutcome::Ok => 200,
            _ => 401,
        }
    }

    /// A short reason for the response body. It never echoes the token.
    pub fn reason(&self) -> &'static str {
        match self {
            AuthOutcome::Ok => "ok",
            AuthOutcome::Missing => "missing bearer token",
            AuthOutcome::Malformed => "malformed authorization header",
            AuthOutcome::Mismatch => "bearer token mismatch",
        }
    }
}

/// Compare two secrets without leaking their contents through timing.
///
/// Both sides are hashed first, so the comparison runs over two fixed-size
/// digests: the length of the secret never shows up in the runtime, and
/// the loop does not exit early on the first differing byte.
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    let da = Sha256::digest(a);
    let db = Sha256::digest(b);
    let mut diff = 0u8;
    for (x, y) in da.iter().zip(db.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Check an `Authorization` header against the expected bearer token.
pub fn check_bearer(header: Option<&str>, expected: &str) -> AuthOutcome {
    let Some(raw) = header else {
        return AuthOutcome::Missing;
    };
    let raw = raw.trim();
    let Some(token) = raw
        .strip_prefix("Bearer ")
        .or_else(|| raw.strip_prefix("bearer "))
    else {
        return AuthOutcome::Malformed;
    };
    let token = token.trim();
    if constant_time_eq(token.as_bytes(), expected.as_bytes()) {
        AuthOutcome::Ok
    } else {
        AuthOutcome::Mismatch
    }
}

/// The identity a request is rate limited against.
///
/// With `trust_proxy` the right-most `X-Forwarded-For` entry wins, because
/// that is the address the nearest trusted proxy saw. The socket peer is
/// the fallback; when the proxy did not forward the header, every request
/// collapses onto the proxy itself, which is the safe direction to fail.
///
/// THE FORWARDED HEADER IS ONLY TRUSTED FROM A LOOPBACK PEER
/// ----------------------------------------------------------
/// A header is not evidence.  If the guard is reachable from the network
/// and honours `X-Forwarded-For`, then whoever is on the other end can
/// put whatever they like in it — and the rate limiter, which is the
/// thing standing between them and the model's time, can be walked around
/// by rotating the header.  The operator would be looking at a limit that
/// does not exist.
///
/// So the header is honoured only when the immediate peer is on this
/// machine, which is the shape of the real deployment: the guard binds
/// 127.0.0.1 and Caddy on the same box forwards to it.  A proxy on
/// another host is a different arrangement, and `trust_any_peer` is the
/// explicit opt-in for it.
///
/// When the header is not trusted the key falls back to the peer address.
/// That is the safe direction to fail: every client through that proxy
/// shares one bucket, so the limit is stricter than intended rather than
/// absent.
pub fn client_key(
    peer: Option<SocketAddr>,
    forwarded_for: Option<&str>,
    trust_proxy: bool,
    trust_any_peer: bool,
) -> String {
    if trust_proxy {
        let from_a_trusted_peer = match peer {
            Some(addr) => trust_any_peer || addr.ip().is_loopback(),
            // An unknown peer is not a trusted one.
            None => false,
        };
        if from_a_trusted_peer {
            if let Some(observed) = rightmost_forwarded_for(forwarded_for) {
                return observed;
            }
        }
    }
    match peer {
        Some(addr) => addr.ip().to_string(),
        None => "unknown".to_string(),
    }
}

/// The right-most `X-Forwarded-For` entry, or `None` when the header
/// carries no usable value.
fn rightmost_forwarded_for(forwarded_for: Option<&str>) -> Option<String> {
    let raw = forwarded_for?;
    raw.split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .next_back()
        .map(|s| s.to_string())
}

/// The outcome of one rate-limit check.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RateDecision {
    /// Whether the request may proceed.
    pub allowed: bool,
    /// The configured ceiling.
    pub limit: u32,
    /// How many requests are still allowed in the current window.
    pub remaining: u32,
    /// How long the caller should wait before retrying.
    pub retry_after_secs: u64,
}

/// A sliding-window rate limiter, one window per client.
#[derive(Debug)]
pub struct RateLimiter {
    per_minute: u32,
    buckets: Mutex<HashMap<String, Vec<Instant>>>,
}

impl RateLimiter {
    /// A limiter that allows `per_minute` requests per client per minute.
    pub fn new(per_minute: u32) -> Self {
        Self {
            per_minute: per_minute.max(1),
            buckets: Mutex::new(HashMap::new()),
        }
    }

    /// The configured ceiling.
    pub fn limit(&self) -> u32 {
        self.per_minute
    }

    /// Count one request for `key` against the window that contains `now`.
    ///
    /// The window is a true sliding log: hits older than a minute are
    /// dropped, so a client gets exactly `per_minute` requests in *any*
    /// sixty-second span, not `per_minute` per fixed minute boundary.
    pub fn check(&self, key: &str, now: Instant) -> RateDecision {
        let mut buckets = self.buckets.lock().unwrap_or_else(|e| e.into_inner());
        let cutoff = now.checked_sub(RATE_WINDOW).unwrap_or(now);

        let decision = {
            let entry = buckets.entry(key.to_string()).or_default();
            entry.retain(|t| *t >= cutoff);
            if entry.len() as u32 >= self.per_minute {
                let oldest = entry.first().copied().unwrap_or(now);
                let wait = RATE_WINDOW.saturating_sub(now.saturating_duration_since(oldest));
                RateDecision {
                    allowed: false,
                    limit: self.per_minute,
                    remaining: 0,
                    retry_after_secs: wait.as_secs().max(1),
                }
            } else {
                entry.push(now);
                RateDecision {
                    allowed: true,
                    limit: self.per_minute,
                    remaining: self.per_minute - entry.len() as u32,
                    retry_after_secs: 0,
                }
            }
        };

        // Keep the map bounded. An attacker rotating source addresses could
        // otherwise grow it without limit.
        if buckets.len() > MAX_TRACKED_CLIENTS {
            buckets.retain(|_, hits| hits.iter().any(|t| *t >= cutoff));
            while buckets.len() > MAX_TRACKED_CLIENTS {
                let Some(key) = buckets.keys().next().cloned() else {
                    break;
                };
                buckets.remove(&key);
            }
        }

        decision
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{IpAddr, Ipv4Addr};
    use std::str::FromStr;

    fn peer(ip: &str) -> Option<SocketAddr> {
        let addr = IpAddr::V4(Ipv4Addr::from_str(ip).expect("ipv4"));
        Some(SocketAddr::new(addr, 443))
    }

    #[test]
    fn correct_token_is_accepted() {
        assert_eq!(
            check_bearer(Some("Bearer s3cret"), "s3cret"),
            AuthOutcome::Ok
        );
        assert_eq!(
            check_bearer(Some("bearer s3cret"), "s3cret"),
            AuthOutcome::Ok
        );
        assert_eq!(
            check_bearer(Some("  Bearer   s3cret  "), "s3cret"),
            AuthOutcome::Ok
        );
    }

    #[test]
    fn wrong_token_is_a_mismatch_not_a_malformed_header() {
        assert_eq!(
            check_bearer(Some("Bearer wrong"), "s3cret"),
            AuthOutcome::Mismatch
        );
        // A prefix of the real token must not pass.
        assert_eq!(
            check_bearer(Some("Bearer s3cre"), "s3cret"),
            AuthOutcome::Mismatch
        );
        assert_eq!(
            check_bearer(Some("Bearer s3cretx"), "s3cret"),
            AuthOutcome::Mismatch
        );
    }

    #[test]
    fn missing_and_malformed_headers_are_distinguished() {
        assert_eq!(check_bearer(None, "s3cret"), AuthOutcome::Missing);
        assert_eq!(check_bearer(Some(""), "s3cret"), AuthOutcome::Malformed);
        assert_eq!(
            check_bearer(Some("Basic dXNlcjpwYXNz"), "s3cret"),
            AuthOutcome::Malformed
        );
        assert_eq!(
            check_bearer(Some("s3cret"), "s3cret"),
            AuthOutcome::Malformed
        );
    }

    #[test]
    fn constant_time_eq_matches_equality_semantics() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"ab"));
        assert!(!constant_time_eq(b"", b"a"));
        assert!(constant_time_eq(b"", b""));
    }

    #[test]
    fn the_rate_limiter_stops_after_the_ceiling() {
        let limiter = RateLimiter::new(3);
        let now = Instant::now();
        for expected_remaining in [2, 1, 0] {
            let decision = limiter.check("1.2.3.4", now);
            assert!(decision.allowed, "the first three requests must pass");
            assert_eq!(decision.remaining, expected_remaining);
            assert_eq!(decision.limit, 3);
        }
        let denied = limiter.check("1.2.3.4", now);
        assert!(!denied.allowed);
        assert_eq!(denied.remaining, 0);
        assert!(denied.retry_after_secs >= 1);
    }

    #[test]
    fn the_rate_limiter_is_per_client() {
        let limiter = RateLimiter::new(1);
        let now = Instant::now();
        assert!(limiter.check("1.2.3.4", now).allowed);
        assert!(!limiter.check("1.2.3.4", now).allowed);
        // A different client is unaffected.
        assert!(limiter.check("5.6.7.8", now).allowed);
    }

    #[test]
    fn the_window_slides_rather_than_resetting_on_a_boundary() {
        let limiter = RateLimiter::new(2);
        let start = Instant::now();
        assert!(limiter.check("9.9.9.9", start).allowed);
        assert!(limiter.check("9.9.9.9", start).allowed);
        assert!(!limiter.check("9.9.9.9", start + Duration::from_secs(30)).allowed);
        // One minute after the first hit, the first hit has left the window.
        let later = start + Duration::from_secs(61);
        assert!(limiter.check("9.9.9.9", later).allowed);
    }

    #[test]
    fn the_client_key_uses_the_right_most_forwarded_entry() {
        // A client that prepends a forged address cannot move its bucket.
        let key = client_key(peer("127.0.0.1"), Some("6.6.6.6, 203.0.113.9"), true, false);
        assert_eq!(key, "203.0.113.9");
        // Without the proxy flag the header is ignored entirely.
        let key = client_key(peer("127.0.0.1"), Some("6.6.6.6, 203.0.113.9"), false, false);
        assert_eq!(key, "127.0.0.1");
        // A trusted proxy that forwards nothing falls back to the peer.
        let key = client_key(peer("127.0.0.1"), None, true, false);
        assert_eq!(key, "127.0.0.1");
        let key = client_key(peer("127.0.0.1"), Some("  "), true, false);
        assert_eq!(key, "127.0.0.1");
    }

    #[test]
    fn the_forwarded_header_is_ignored_from_a_peer_that_is_not_on_this_machine() {
        // A guard reachable from the network must not take a client's word
        // for who it is: the header is only honoured from a loopback peer.
        let key = client_key(peer("203.0.113.7"), Some("6.6.6.6"), true, false);
        assert_eq!(key, "203.0.113.7");
        // A client that rotates the header does not move its bucket.
        let a = client_key(peer("203.0.113.7"), Some("6.6.6.6"), true, false);
        let b = client_key(peer("203.0.113.7"), Some("9.9.9.9"), true, false);
        assert_eq!(a, b);
        // The explicit opt-in for a proxy on another host restores it.
        let key = client_key(peer("203.0.113.7"), Some("6.6.6.6"), true, true);
        assert_eq!(key, "6.6.6.6");
    }

    #[test]
    fn an_unknown_peer_is_not_a_trusted_one() {
        // No peer means no evidence that the header came from a proxy.
        let key = client_key(None, Some("6.6.6.6"), true, false);
        assert_eq!(key, "unknown");
    }

    #[test]
    fn the_client_key_survives_a_missing_peer() {
        let key = client_key(None, None, false, false);
        assert_eq!(key, "unknown");
    }
}
