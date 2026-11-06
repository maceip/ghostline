//! `capability-tool` — mint and verify Ed25519 capability tokens.
//!
//! The binary is standalone on purpose: it pulls the module in with a
//! `#[path]` include so it compiles without the crate root having to list
//! `capability` as a library module.
//!
//! ```text
//! capability-tool keygen
//! capability-tool mint --private-key <b64> --tool <name> --args-json <json> \
//!                      --ttl <secs> [--subject <s>] [--now <unix>] [--nonce-hex <hex>]
//! capability-tool verify --token <tok> --public-key <hex> [--now <unix>]
//! capability-tool selftest
//! ```

#[path = "../capability.rs"]
mod capability;

use capability::{
    arg_digest_hex, base64_decode, base64_encode, hex_decode, now_unix, random_nonce,
    CapabilityClaims, CapabilitySigner,
};
use clap::{value_parser, Arg, Command};

fn main() {
    let code = match run() {
        Ok(()) => 0,
        Err(message) => {
            eprintln!("ERROR: {message}");
            1
        }
    };
    std::process::exit(code);
}

fn run() -> Result<(), String> {
    let matches = Command::new("capability-tool")
        .about("Mint and verify Ed25519 capability tokens for the RepE guard")
        .subcommand_required(true)
        .arg_required_else_help(true)
        .subcommand(Command::new("keygen").about("Generate an Ed25519 key pair"))
        .subcommand(
            Command::new("mint")
                .about("Mint a signed capability token")
                .arg(
                    Arg::new("private-key")
                        .long("private-key")
                        .value_name("B64")
                        .required(true)
                        .help("PKCS#8 private key, base64 (from `keygen`)"),
                )
                .arg(
                    Arg::new("tool")
                        .long("tool")
                        .value_name("NAME")
                        .required(true)
                        .help("tool the approval applies to"),
                )
                .arg(
                    Arg::new("args-json")
                        .long("args-json")
                        .value_name("JSON")
                        .required(true)
                        .allow_hyphen_values(true)
                        .help("tool arguments as JSON; hashed into arg_digest_hex"),
                )
                .arg(
                    Arg::new("ttl")
                        .long("ttl")
                        .value_name("SECS")
                        .required(true)
                        .value_parser(value_parser!(i64))
                        .help("lifetime in seconds"),
                )
                .arg(
                    Arg::new("subject")
                        .long("subject")
                        .value_name("S")
                        .default_value("human:touchid")
                        .help("who authorized the call (human:touchid, policy:<name>, ...)"),
                )
                .arg(
                    Arg::new("now")
                        .long("now")
                        .value_name("UNIX")
                        .value_parser(value_parser!(i64))
                        .help("override the issue time (unix seconds)"),
                )
                .arg(
                    Arg::new("nonce-hex")
                        .long("nonce-hex")
                        .value_name("HEX")
                        .help("use a fixed 16-byte nonce (hex) instead of a random one"),
                ),
        )
        .subcommand(
            Command::new("verify")
                .about("Verify a capability token")
                .arg(
                    Arg::new("token")
                        .long("token")
                        .value_name("TOK")
                        .required(true)
                        .help("the compact token JSON"),
                )
                .arg(
                    Arg::new("public-key")
                        .long("public-key")
                        .value_name("HEX")
                        .required(true)
                        .help("issuer public key, hex"),
                )
                .arg(
                    Arg::new("now")
                        .long("now")
                        .value_name("UNIX")
                        .value_parser(value_parser!(i64))
                        .help("verify at this unix time instead of now"),
                ),
        )
        .subcommand(Command::new("selftest").about("Run the built-in self test"))
        .get_matches();

    match matches.subcommand() {
        Some(("keygen", _)) => cmd_keygen(),
        Some(("mint", sub)) => cmd_mint(sub),
        Some(("verify", sub)) => cmd_verify(sub),
        Some(("selftest", _)) => cmd_selftest(),
        _ => Err("no subcommand given".to_string()),
    }
}

fn cmd_keygen() -> Result<(), String> {
    let (signer, pkcs8) = CapabilitySigner::generate_with_pkcs8()?;
    println!("PRIVATE_KEY_B64 {}", base64_encode(&pkcs8));
    println!("PUBLIC_KEY_HEX {}", signer.public_key_hex());
    Ok(())
}

fn cmd_mint(matches: &clap::ArgMatches) -> Result<(), String> {
    let private_key_b64 = matches.get_one::<String>("private-key").expect("required");
    let tool = matches.get_one::<String>("tool").expect("required");
    let args_json = matches.get_one::<String>("args-json").expect("required");
    let ttl_secs = *matches.get_one::<i64>("ttl").expect("required");
    let subject = matches.get_one::<String>("subject").expect("has default");

    let pkcs8 = base64_decode(private_key_b64).map_err(|e| format!("private key: {e}"))?;
    let signer = CapabilitySigner::from_pkcs8(&pkcs8)?;

    let digest = arg_digest_hex(args_json)?;
    let nonce = match matches.get_one::<String>("nonce-hex") {
        Some(text) => {
            let raw = hex_decode(text).map_err(|e| format!("nonce: {e}"))?;
            if raw.len() != capability::NONCE_LEN {
                return Err(format!(
                    "nonce must be {} bytes, got {}",
                    capability::NONCE_LEN,
                    raw.len()
                ));
            }
            let mut nonce = [0u8; capability::NONCE_LEN];
            nonce.copy_from_slice(&raw);
            nonce
        }
        None => random_nonce()?,
    };
    let issued_at_unix = matches.get_one::<i64>("now").copied().unwrap_or_else(now_unix);

    let claims = CapabilityClaims {
        tool: tool.clone(),
        arg_digest_hex: digest,
        issued_at_unix,
        ttl_secs,
        nonce,
        subject: subject.clone(),
    };
    println!("{}", signer.sign(&claims));
    Ok(())
}

fn cmd_verify(matches: &clap::ArgMatches) -> Result<(), String> {
    let token = matches.get_one::<String>("token").expect("required");
    let public_key = matches.get_one::<String>("public-key").expect("required");

    let result = match matches.get_one::<i64>("now").copied() {
        Some(at) => capability::verify_at(token, public_key, at),
        None => capability::verify(token, public_key),
    };

    match result {
        Ok(claims) => {
            println!("VALID");
            println!(
                "{}",
                serde_json::to_string(&claims).map_err(|e| format!("claims: {e}"))?
            );
            Ok(())
        }
        Err(reason) => {
            println!("INVALID: {reason}");
            std::process::exit(2);
        }
    }
}

/// Exercises the full path: keygen, mint, verify, and the rejection paths.
fn cmd_selftest() -> Result<(), String> {
    let mut failures: Vec<String> = Vec::new();

    let (signer, pkcs8) = CapabilitySigner::generate_with_pkcs8()?;
    let public_key = signer.public_key_hex();
    println!("selftest: keygen ok public_key={public_key}");

    let round_trip = CapabilitySigner::from_pkcs8(&pkcs8)?;
    if round_trip.public_key_hex() != public_key {
        failures.push("pkcs#8 round-trip changed the public key".to_string());
    } else {
        println!("selftest: pkcs#8 round-trip ok");
    }

    let args = r#"{"b":2,"a":[1,2,{"z":true,"y":"x"}],"note":"hello"}"#;
    let issued_at = 1_700_000_000;
    let claims = CapabilityClaims {
        tool: "selftest.echo".to_string(),
        arg_digest_hex: arg_digest_hex(args)?,
        issued_at_unix: issued_at,
        ttl_secs: 60,
        nonce: random_nonce()?,
        subject: "human:touchid".to_string(),
    };
    let token = signer.sign(&claims);
    println!(
        "selftest: mint ok token_len={} arg_digest_hex={}",
        token.len(),
        claims.arg_digest_hex
    );

    match capability::verify_at(&token, &public_key, issued_at + 1) {
        Ok(verified) => {
            if verified == claims {
                println!("selftest: verify ok tool={} subject={}", verified.tool, verified.subject);
            } else {
                failures.push("verified claims differ from the minted claims".to_string());
            }
        }
        Err(reason) => failures.push(format!("valid token was rejected: {reason}")),
    }

    // Tamper with one byte of the signed payload: flip the low bit of the
    // first byte of the argument digest.
    let mut tampered: serde_json::Value = serde_json::from_str(&token)
        .map_err(|e| format!("token is not valid json: {e}"))?;
    let digest_hex = tampered["claims"]["arg_digest_hex"]
        .as_str()
        .ok_or_else(|| "token has no claims.arg_digest_hex".to_string())?
        .to_string();
    let mut raw = hex_decode(&digest_hex).map_err(|e| format!("digest: {e}"))?;
    raw[0] ^= 0x01;
    tampered["claims"]["arg_digest_hex"] = serde_json::Value::String(capability::hex_encode(&raw));
    let tampered_token = serde_json::to_string(&tampered).map_err(|e| format!("token: {e}"))?;
    match capability::verify_at(&tampered_token, &public_key, issued_at + 1) {
        Ok(_) => failures.push("tampered payload was accepted".to_string()),
        Err(reason) => println!("selftest: tampered payload rejected ({reason})"),
    }

    // Tamper with the signature itself.
    let mut tampered_sig: serde_json::Value =
        serde_json::from_str(&token).map_err(|e| format!("token is not valid json: {e}"))?;
    let mut sig = base64_decode(tampered_sig["sig"].as_str().unwrap_or_default())
        .map_err(|e| format!("signature: {e}"))?;
    sig[0] ^= 0x01;
    tampered_sig["sig"] = serde_json::Value::String(base64_encode(&sig));
    let tampered_sig_token =
        serde_json::to_string(&tampered_sig).map_err(|e| format!("token: {e}"))?;
    match capability::verify_at(&tampered_sig_token, &public_key, issued_at + 1) {
        Ok(_) => failures.push("tampered signature was accepted".to_string()),
        Err(reason) => println!("selftest: tampered signature rejected ({reason})"),
    }

    // Expiry boundary: issued_at + ttl is already too late.
    match capability::verify_at(&token, &public_key, issued_at + 60) {
        Ok(_) => failures.push("expired token was accepted".to_string()),
        Err(reason) => println!("selftest: expired token rejected ({reason})"),
    }

    // A token issued in the future must be rejected too.
    match capability::verify_at(&token, &public_key, issued_at - 1) {
        Ok(_) => failures.push("future token was accepted".to_string()),
        Err(reason) => println!("selftest: future token rejected ({reason})"),
    }

    // A different key must not verify the token.
    let (other_signer, _) = CapabilitySigner::generate_with_pkcs8()?;
    match capability::verify_at(&token, &other_signer.public_key_hex(), issued_at + 1) {
        Ok(_) => failures.push("token verified under the wrong public key".to_string()),
        Err(reason) => println!("selftest: wrong public key rejected ({reason})"),
    }

    if failures.is_empty() {
        println!("SELFTEST PASS");
        Ok(())
    } else {
        for failure in &failures {
            eprintln!("selftest: FAIL {failure}");
        }
        Err(format!("{} selftest check(s) failed", failures.len()))
    }
}
