# Ghostline

**Ghostline** is a Representation Engineering (RepE) + Clef pre-flight guard for AI agent tool calls on Apple Silicon (MLX in Rust, `qwen-clef-repe-guard/`), paired with a live interactive web exhibit (`clef-site/index.html` and `clef-site/demo.html`).

Before an agent executes a shell command or tool call, Ghostline runs a single prefill pass through `Qwen2.5-0.5B-Instruct` (or `Cloudflare/clef-flash` hybrid Gated DeltaNet), reads the hidden residual stream at probe layer 16, projects the span tokens against calibrated contrastive harm directions (`destruction · theft · exfiltration`), subtracts the live prompt baseline across 5 ordinary reference commands, and refuses tool calls whose `harm_excess` crosses the calibrated alarm line (`excess_threshold`).

## Repository Layout

- **`qwen-clef-repe-guard/`** — Native Rust + MLX guard server (`src/mlx_loader.rs`, `src/qwen_hook.rs`, `src/repe_sensor.rs`, `src/enforcer_proxy.rs`, `src/gdn.rs`, `src/joint_head.rs`) achieving `0.0001` cosine parity with Python `mlx_lm`.
- **`repe-mods/` & `repe-compose.py` & `upgrade_generic_viz.sh`** — Modular source workspace and deterministic single-file generator checked by `.githooks/pre-commit`.
- **`extract_repe_vectors.py`** — Contrastive RepE calibration pipeline producing `qwen-clef-repe-guard/artifacts/repe_vectors_qwen2_5_0_5b_v2.safetensors`.
- **`clef-site/`** — Two-experience live web application:
  - `clef-site/index.html` (`js/museum.js`, `museum.css`, `js/field.js`): 4-room interactive exhibit (Room 1 Live Mind-Reader & Token Attribution, Room 2 50-Command Beeswarm Alarm Line, Room 3 Matched-Verb Pairs, Room 4 Held-Out Scoreboard) with a 3D `ResidualField` hero and dark/light theme switcher.
  - `clef-site/demo.html` (`js/exhibit.js`, `exhibit.css`, `js/clef-viz.js`): 6-step "FROM QWEN" Glass Room walkthrough from zero-context model wake-up (`0 · WAKE IT UP`) to layer-by-layer residual trace (`5 · PULL THE TRACE`).
- **`evals/`** — End-to-end verification suite (`verify_all.sh`, `heldout_novel.py`, `real_upstream_20.py`, `access_control.py`, `session_guard.py`, `caddy_edge.py`, `site_claims.py`).
- **`deploy/` & `scripts/`** — Production Caddyfile with per-IP rate limiting and zero-sudo macOS launchd / Tailscale / EC2 Mac installers.

## Working on the RepE guard

The guard's source lives in `repe-mods/`; `repe-compose.py` assembles
`upgrade_generic_viz.sh` from it, and the generator rebuilds
`qwen-clef-repe-guard/` from that. The generated tree and the module
workspace are both committed, and a pre-commit hook refuses a commit whose
generator has drifted from `repe-mods/` — the drift that silently rewrites
the project with stale sources.

One command checks, commits, and pushes:

```bash
scripts/repe_checkpoint.sh              # sync check, commit, push
scripts/repe_checkpoint.sh --verify     # ...after the full verification suite
scripts/repe_checkpoint.sh --no-push    # local only
```

The full end-to-end verification (build, unit tests, the canonical and
real-upstream benchmarks, the render / GDN / joint-head parity suites, the
access-control and session checks, and the Caddy edge check) needs
Apple Silicon, so it runs locally:

```bash
bash evals/verify_all.sh
```

The pure-arithmetic parts — the Ledoit-Wolf whitening, the cross-turn
trajectory — have no MLX dependency and are also checked in CI on every push
(`.github/workflows/repe-guard.yml`). CI additionally builds a Caddy with the
rate-limit module and runs `evals/caddy_edge.py` against the shipped
`deploy/Caddyfile`, so a config that would refuse to start on the box cannot
be committed.

### How the GDN parity is judged, and why

`tools/compare_gdn.py` compares the Rust Gated DeltaNet recurrence against
the MLX-Python reference and **exits non-zero when either gate fails**, so a
broken recurrence cannot pass the suite.

The two gates are deliberately different measures:

- **Layer 0 is absolute** — the contractual bar, `max_abs < 1e-4`. Measured:
  **1.192093e-05**, about 8x inside the bar.
- **The full stack is relative** — `max_abs / max|x| < 1e-3`. Measured:
  **4.216565e-04** on the worst tensor (`layer31`), and 3.311e-04 at the
  final hidden state.

The reason is that the residual stream's own magnitude grows with depth: on
clef-flash, `max|x|` runs from 7.9 at layer 0 to 4.60e+01 at the final
hidden state. A fixed *absolute* bound on a signal that grows 5.8x is not a
correctness criterion — it eventually fails for a perfectly correct
implementation purely because the model got deeper. The relative error is
the scale-invariant measure, and it sits at round-off level: 3.3e-04
against a float32 epsilon of 1.2e-07, across the 32 compared layers of
the hybrid stack (24 Gated DeltaNet layers and 8 full-attention ones).

The absolute number is still printed in full on every run — the full-stack
`max_abs` is **1.521969e-02**, and it is reported next to the relative one
rather than hidden behind it.

The calibrated vectors under `qwen-clef-repe-guard/artifacts/` are committed
on purpose: they are the measured operating point, not a derived file, and
they cost minutes of calibration against a specific checkpoint snapshot.

## Installing the guard

One command on a fresh Apple Silicon Mac:

```bash
curl -fsSL https://raw.githubusercontent.com/maceip/zune-code/main/scripts/install_guard.sh | bash
```

It checks the platform, installs `cargo` and `uv` if they are missing, clones
the repository, builds the release binary, downloads
`Qwen/Qwen2.5-0.5B-Instruct` and the 4B generation model, writes a bearer
token and a session secret, installs three launchd agents — the upstream
model server, the generation model server and the guard — waits for all of
them to answer, and prints the URLs. It never runs `sudo` and never writes
outside `$HOME`.

```bash
bash scripts/install_guard.sh --dry-run        # print the plan, touch nothing
bash scripts/install_guard.sh --dir ~/zune-code --port 8090 --rate-limit 60
bash scripts/install_guard.sh --help
```

### Serving it over Tailscale, without a cloud box

To reach the site from your own devices before there is a public box, a
second installer puts Caddy — with the `rate_limit` module — in front of the
guard on this Mac and binds it to the **tailnet address**:

```bash
bash scripts/install_guard.sh --dir "$PWD" --session-cookie-secure false --trust-proxy
bash scripts/install_tailscale_edge.sh --dir "$PWD"
```

The edge is reachable from any device on the tailnet and from nowhere else,
and its rate limiter keys on each device's own `100.x` address — which is
what "keyed by client IP" means on a tailnet. It ends by measuring that:
the site is served, a visitor gets a session and a real reading, the
limiter refuses the excess, the listener is on the tailnet address, and the
LAN address gets nothing. `deploy/README.md` has the details, including why
it is plain HTTP and why Tailscale Serve was measured and rejected.

### Putting it on the internet

The guard binds `127.0.0.1` and **refuses to start** on a routable address
without a bearer token, so the public face is a reverse proxy in front of it:

```
browser ──https──> Caddy ──http──> guard (127.0.0.1:8090) ──http──> mlx_lm (127.0.0.1:8123)
                    │                    (reads activations with the 0.5B model)
                    │
                    ├── /gen/* ──http──> generation model (127.0.0.1:8080)
                    │                    (writes the code in the site's glass room)
                    │
                    └── rate limit by client IP, before the request is proxied
```

`deploy/Caddyfile` terminates TLS with an automatically renewed ACME
certificate, serves `clef-site/` on the same origin as the API so the browser
never makes a cross-origin request, and rate limits by the address it saw on
the socket — a client cannot forge its way into somebody else's budget by
sending an `X-Forwarded-For`.

**Caddy deliberately injects no bearer token.** The guard admits two
credentials: the operator's token, which direct clients on the box send
themselves, and a device-bound session cookie that a visitor gets from
`POST /api/session`. If the proxy added the operator's token to every
request, the guard could not tell a visitor from the operator and the
session gate would be decorative.

`scripts/provision_ec2_mac.sh` gets you an Apple Silicon Mac on EC2 (the
guard needs Metal on an Apple GPU, so an Intel Mac will not do), and
`scripts/bootstrap_cloud_metal.sh` provisions the box with that front end
(Caddy with the rate-limit module, the site copy, the service account, the
launchd daemons, and a validated config). `deploy/README.md` is the
operator's notes — TLS, token rotation, rate-limit checks, troubleshooting.

### Rate limiting belongs at the Caddy layer, by IP

**The public deployment must rate limit at Caddy, keyed by client IP** — not
in the guard. The edge limit sheds load before the model forward pass ever
starts, and it keys on the address Caddy saw on the socket, so there is no
forwarded header to forge.

The zones are **already in `deploy/Caddyfile`** — one for the expensive
`/v1/*` path, one for `/api/*`, and two for `/gen/*` (the page that streams a
real model writing code): one per client IP and **one shared by everybody**,
because a per-IP limit alone does not bound the total work. The static site
and `/health` are in no zone at all, so a visitor is never throttled for
loading a page. The limits are environment variables (`RL_TOOL_CALL_EVENTS`
and friends), so they can be tuned without editing the file.

The `rate_limit` block sits **above** the routes, not inside one, and that
is not a style choice. Caddy applies `uri` — which strips the `/gen`
prefix — *before* `rate_limit`, and a zone whose matcher no longer matches
is skipped silently, which means no limit at all. Measured here: with the
limiter next to the rewrite, the `/gen`, `/v1/*` and `/api/*` zones all
stopped firing. `evals/caddy_edge.py` checks the order and the behaviour.

One thing to know before the first deploy: **`rate_limit` is not a Caddyfile
directive in the standard build.** It comes from the community module
`github.com/mholt/caddy-ratelimit` and has to be compiled in. A Caddyfile
containing `rate_limit` on a binary without the module is a parse error, so
Caddy refuses to load it — it fails loudly rather than quietly serving an
unprotected site. `scripts/bootstrap_cloud_metal.sh` builds that binary
(`/opt/zcode/bin/caddy`) and points the launchd daemon at it, so the config
that is validated is the config that is served. Note that `xcaddy` is not a
Homebrew formula — it installs with `go install`.

`python3 evals/caddy_edge.py` proves all of it against the **shipped**
Caddyfile: it must load, a stock Caddy must refuse it, a forged
`X-Forwarded-For` must be replaced with the real address, and the limit must
shed load *before* the backend sees the request. It also checks the
generation route — that `/gen/*` is limited per IP, that the shared budget
is one counter for the whole site, that the prefix is stripped before the
model server sees it, and that the limiter runs before the rewrite. The
same check runs in CI, so a Caddyfile that would refuse to start on the box
cannot be committed.
The build command, the IPv6-prefix caveat and the tuning table are in
`deploy/README.md`, under *Rate limiting belongs at THIS layer, keyed by IP*.

The guard's own `--rate-limit-rpm` remains as a **backstop** for direct or
misconfigured clients — not as the public deployment's limit.

### The guard's access control

Two independent layers, both **off by default**, so a local run and the
benchmark harnesses behave exactly as they did before:

| Flag | Effect |
|---|---|
| `--auth-token-file PATH` | The operator's bearer token. Opens every route. |
| `--rate-limit-rpm N` | `N` requests per client per minute over a sliding window — `N` in *any* sixty-second span, not `N` per clock minute. `0` disables the limit. |
| `--trust-proxy` | Take the client identity from the **right-most** `X-Forwarded-For` entry instead of the socket peer — but **only when the socket peer is on this machine**. See below. |
| `--trust-proxy-any-peer` | Trust `X-Forwarded-For` from a peer that is *not* on this machine. Only for a reverse proxy on another host that rewrites the header itself. |
| `--host` | The interface to bind. A routable address requires a token. |
| `--session-ttl-secs N` | How long a device-bound session lives. One hour by default. |
| `--no-sessions` | Refuse to mint sessions: the bearer token becomes the only way in. |
| `--session-secret-file PATH` | The HMAC key that signs the session cookies. A random one is generated per process when absent, which ends every session on restart. |

The env equivalents are `ZCODE_GUARD_TOKEN`, `ZCODE_GUARD_TOKEN_FILE`,
`ZCODE_GUARD_RATE_LIMIT_RPM` and `ZCODE_SESSION_SECRET_FILE`.

#### A forwarded header is only evidence from a proxy you can vouch for

`X-Forwarded-For` is a header, and a header is not evidence. If the guard
is reachable from the network and honours it, then whoever is on the other
end can put whatever they like in it — and the rate limiter, the thing
standing between them and the model's time, can be walked around by
rotating the header. The operator would be looking at a limit that does not
exist.

So `--trust-proxy` honours the header **only when the immediate peer is on
this machine**, which is the shape of the real deployment: the guard binds
`127.0.0.1` and Caddy on the same box forwards to it. A proxy on another
host is a different arrangement, and `--trust-proxy-any-peer` is the
explicit opt-in for it.

When the header is not trusted the client key falls back to the peer
address. That is the safe direction to fail: every client through that
proxy shares one bucket, so the limit is stricter than intended rather
than absent.

`evals/access_control.py` proves both halves against a live guard: a
client whose socket peer is a LAN address cannot buy extra budget by
rotating the header, and the opt-in does restore it.

### Using the guard from a native bridge

The demo site is one client of the guard. The other one that matters is a
**native bridge** — the sidecar that spawns `claude -p` / `codex exec` and
therefore runs the agent's shell and write tools. Before such a tool runs,
the bridge asks the guard whether it should:

```
POST http://127.0.0.1:8090/v1/guard/tool-call
{"prompt": "…", "tool_name": "bash", "tool_args": {"cmd": "…"}}
```

`allowed: false` means the bridge must not run the tool, and it should hand
`reason` back to the model so the model can pick another route. The full
contract, with a real answer from the running guard, is in
[`BRIDGE.md`](BRIDGE.md) — “Guarding a bridge's tool calls”.

The webview's own tools (`list_files`, `read_file`, `get_diff`, `search`)
are read-only by design, so the guard has nothing to judge there; the
judging belongs where the commands are.

### Device-bound sessions

A visitor of the public demo is admitted by a **session**, not by an
account. There is no sign-in, no email, and nothing about the visitor is
kept.

1. The page asks the guard for one: `POST /api/session`.
2. The guard answers `200` and sets two `HttpOnly` cookies — `zcode_sid`
   (the session, carrying its own claims — id, device hash, issue time and
   expiry — under an HMAC over a server secret) and `zcode_dev` (a random
   value binding the session to this browser).
3. The browser sends both on every later request. The guard checks that the
   pair belongs together and that the user-agent matches the one the
   session was minted with.
4. The session expires by itself. The site notices the `401`, mints a new
   one and carries on.

**The session is stateless.** The cookie carries everything the guard needs
to check it, so the guard keeps no session table, a restart does not end
every session, and a session minted before a deploy still works after it.
What survives a restart is the *secret*: with `--session-secret-file` the
secret is stable, and without it a random one is generated per process, so
every session ends when the process does. Rotating the secret is how every
session is ended at once.

Both installers write one: `scripts/install_guard.sh` puts it at
`~/.config/zcode/session.secret` and `scripts/bootstrap_cloud_metal.sh` at
`/opt/zcode/session.secret`. Measured on a real launchd install: a session
answered `200`, the guard was restarted with `launchctl kickstart`, and it
still answered `200`; rotating the secret turned that into `401`, and
restoring it turned it back into `200`.

**What it defends against:** a session cookie copied into another browser on
its own, a cookie edited to point at somebody else's session, and a client
that never went through the admission step at all. **What it does not:**
an attacker holding both cookies with the same user-agent. It is an
admission step and an accounting mechanism, not an identity system.

**Caddy deliberately injects no token.** If the proxy added the operator's
token to every request, the guard could not tell a visitor from the
operator and the session gate would be decorative. The operator's token
stays on the box, for direct clients; the public path carries a session.

`python3 evals/session_guard.py` proves all of this against a live guard:
admission, device binding, forgery, the operator's token, `--no-sessions`,
that a session survives a restart when the secret is stable and dies when it
rotates, and that local mode needs nothing at all.

`python3 evals/access_control.py` proves the bearer token, the rate limit and
the safety rail against a live guard: the authentication matrix, that the
rate limit holds, that a forged `X-Forwarded-For` cannot buy extra budget,
and that a routable bind without a token refuses to start.

## Licence

MIT — see [LICENSE](LICENSE).
