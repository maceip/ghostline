# The Caddy front — operator notes

This directory holds the production front end for the MLX tool-call guard:
`Caddyfile` is the reverse proxy that puts TLS, a static site and the guard's
API on one origin.  `scripts/bootstrap_cloud_metal.sh` installs it on a cloud
macOS box; this file is what you read when something is wrong.

---

## Getting a box

The bootstrap installs the guard on a box that already exists.  On EC2, the
box is an **Apple Silicon Mac on a dedicated host**, and
`scripts/provision_ec2_mac.sh` provisions one:

```bash
bash scripts/provision_ec2_mac.sh --dry-run          # everything read-only
bash scripts/provision_ec2_mac.sh --region eu-central-1
```

The dry run is not a mock: it performs the quota check, the availability-zone
lookup and the AMI lookup for real, and only skips the two calls that cost
money.

Three things about it that are easy to get wrong:

- **The unit of billing is the dedicated host, not the instance.** A Mac
  instance runs on a host that is yours alone, and the host is what you are
  charged for. One host, one instance, one price.
- **There is a 24-hour minimum.** Apple's macOS licence requires it, so a
  host bills for a full day whether you use it for five minutes or a week.
  The script passes `--auto-release 24:00` so a forgotten box stops billing
  after the minimum, and AWS refuses a manual release before then
  (`Client.HostMinAllocationPeriodUnexpired`). At the measured us-east-1
  rate, `mac2-m2.metal` is $0.878/hour, so the first day is $21.07.
- **The quota is per region.** `Running Dedicated mac2-m2 Hosts` is a
  service quota, and it is zero in some regions and not in others — this
  account has 5.0 in `eu-central-1` and 0.0 in `us-east-1`. When the quota
  is zero the script says so and scans the other regions for one that has
  it, rather than leaving you to guess.

An Intel Mac (`mac1.metal`) is refused by the script: the guard runs on
`mlx-rs`, which needs Metal on an Apple GPU.

Once the machine is up:

```bash
ssh -i ~/.ssh/<key>.pem ec2-user@<public-dns>
sudo -u "$USER" bash scripts/bootstrap_cloud_metal.sh \
    --domain <your-hostname> --email <your-acme-contact>
```

The bootstrap's dry run is worth doing first — it does not need root and it
is not a mock:

```bash
bash scripts/bootstrap_cloud_metal.sh --dry-run \
    --domain <your-hostname> --email <your-acme-contact>
```

It prints the whole plan, and it **writes the three launchd property lists
for real** into a scratch directory and checks them with `plutil -lint`, so
a plist launchd would refuse is caught before the box ever sees it. It also
validates the Caddy configuration it will write, with the same environment
the box will run it with.

---

## The pieces

| Piece | Where | What it does |
|---|---|---|
| **Caddy** | `/opt/zcode/caddy/Caddyfile` | Terminates TLS, serves the static site at `/`, forwards the API to the guard. Holds no secret. |
| **Caddy environment** | `/opt/zcode/caddy/caddy.env` | The `KEY=VALUE` file the Caddy service loads with `--envfile`. Domain, ports, paths and the ACME contact — no token. |
| **The guard** | `com.zcode.guard` (launchd daemon) | The Rust binary from `qwen-clef-repe-guard/`. Scores tool calls against the calibrated RepE vectors and refuses the harmful ones. Listens on `127.0.0.1:8090`. |
| **The upstream** | `com.zcode.upstream` (launchd daemon) | `mlx_lm.server` with `Qwen/Qwen2.5-0.5B-Instruct`. Listens on `127.0.0.1:8123`. |
| **The static site** | `/opt/zcode/site` | A copy of `clef-site/` from the repository. |
| **The token** | `/opt/zcode/guard.token` | The operator's bearer token, mode `0640`, owned by the `zcode` service user. **Only the guard reads it** — Caddy never sees it. |

The guard and the upstream both listen on loopback only. **Caddy is the only
thing the internet can reach**, and it holds no secret at all.

### How Caddy is started

Caddy is **built from source with the rate-limit module compiled in** and
run by a **system launchd daemon**,
`/Library/LaunchDaemons/com.zcode.caddy.plist`:

```
/opt/zcode/bin/caddy run --config /opt/zcode/caddy/Caddyfile \
                          --envfile /opt/zcode/caddy/caddy.env
```

It is `/opt/zcode/bin/caddy` and not the Homebrew build because the shipped
Caddyfile uses the `rate_limit` directive, which the Homebrew build does
not have — see *Rate limiting belongs at THIS layer, keyed by IP* below.
`scripts/bootstrap_cloud_metal.sh` builds it.

It runs as `root` because it has to bind ports 80 and 443, which are
privileged on macOS.  Its own launchd daemon — rather than
`brew services start caddy` — is what makes the `--envfile` flag possible:
Homebrew's generated service plist has no such flag, so it could not load
the canonical `caddy.env` that holds the environment.  If you prefer to
manage Caddy through Homebrew, stop the daemon first (`sudo launchctl
bootout system/com.zcode.caddy`) or the two will fight over the ports.

### The request path

```
browser ──https──> Caddy ──http──> guard (127.0.0.1:8090) ──http──> mlx_lm (127.0.0.1:8123)
                    │
                    └── Cookie: zcode_sid + zcode_dev   ← a device-bound session
```

There are **two** credentials, and they belong to different callers:

| Credential | Who has it | Where it is used |
|---|---|---|
| **The bearer token** | The operator. Direct clients on the box — the ZoonCode integration, a script. | `Authorization: Bearer <token>` against the guard's own port. It never goes through Caddy. |
| **The session cookie** | A visitor. Nobody signs in, and nothing about them is recorded. | Issued by `POST /api/session`, then sent automatically by the browser. |

**Caddy injects nothing**, and that is deliberate. If the proxy added the
operator's token to every request, the guard could not tell a visitor from the
operator, and the session gate would be decorative. The proxy passes cookies
through untouched, which is what lets the session work.

The browser never sees the operator's token, and the operator's token never
travels over the public network.

### The session, in one paragraph

A visitor calls `POST /api/session` once and gets two `HttpOnly` cookies:
`zcode_sid` (the session — its claims, id, device hash, issue time and
expiry, signed with an HMAC over a server secret) and `zcode_dev` (a random
value that binds the session to this browser). The guard refuses a session
whose device cookie and user-agent do not match the ones it was minted with,
so the cookie cannot be lifted into another browser on its own. There is no
account, no sign-in and no personal data — the session expires on its own
and nothing about the visitor is kept. It is an admission step and an
accounting mechanism, not an identity system.

**The session is stateless.** The cookie carries its own claims, so the
guard keeps no session table: a restart does not end every session, and the
guard's memory does not grow with the number of visitors. What a restart
*can* end is the session secret, so a stable secret file is what makes
sessions durable across a deploy.

### What is deliberately NOT here

`clef-site/tools/serve.py` is a **development** server. It adds
`Access-Control-Allow-Origin: *`, has no TLS and no rate limiting. It is fine
on a laptop and wrong in production; Caddy replaces it entirely. The cloud
path never starts it.

---

## The environment variables

`/opt/zcode/caddy/caddy.env` (mode `0640`, owner `root`, group `wheel`):

| Variable | Meaning | Example |
|---|---|---|
| `CLEF_DOMAIN` | The public hostname this site serves. **Required** — no default, so a missing value fails loudly at parse time. | `clef.example.com` |
| `GUARD_PORT` | The port the guard listens on. | `8090` (default) |
| `SITE_ROOT` | The directory holding the static site. | `/opt/zcode/site` (default) |
| `ACME_EMAIL` | The contact address for the ACME account. **Required.** | `ops@example.com` |

**There is no token in `caddy.env`.** The guard's bearer token is the
operator's credential and only the guard reads it, from
`/opt/zcode/guard.token`. The guard picks up its own settings from the
environment too: `ZCODE_GUARD_TOKEN_FILE`, `ZCODE_GUARD_RATE_LIMIT_RPM` and
`ZCODE_SESSION_SECRET_FILE`.

---

## How TLS works

Caddy obtains the certificate itself, over ACME. There is no certificate file
to manage, no renewal cron, and nothing to re-run when one expires.

For the issuance to succeed, two things must be true, and only an operator can
arrange them:

1. **The name resolves to this box.** An `A` record (and an `AAAA` record if
   the box has an IPv6 address) for `CLEF_DOMAIN` must point at the box's
   public IP.
2. **Ports 80 and 443 are reachable.** Port 80 carries the HTTP-01
   challenge, port 443 carries the traffic. Open both in the cloud security
   group *and* in any host firewall.

Caddy runs as `root` because it has to bind those two privileged ports.

The certificate and the ACME account live in the storage directory
`/var/lib/caddy` (set by the `storage` global option). Renewals happen
automatically, about a month before expiry.

Check the certificate the outside world is being served:

```bash
echo | openssl s_client -connect clef.example.com:443 \
    -servername clef.example.com 2>/dev/null | openssl x509 -noout -dates
```

Watch the first issuance happen:

```bash
sudo tail -f /var/log/zcode/caddy.log
```

---

## Rotating the token

The token is the operator's front door. Rotate it if it leaks, if someone had
access to the box, or on a schedule you decided on.

**Only the guard has to change.** Caddy never held the token — it does not
inject one — so a token rotation is a file write and a guard restart.

```bash
# 1. a new token
NEW=$(openssl rand -hex 32)

# 2. what the guard will read (mode 0640, owned by the service user)
sudo sh -c "umask 077; printf '%s\n' '$NEW' > /tmp/guard.token"
sudo install -m 0640 -o zcode -g zcode /tmp/guard.token /opt/zcode/guard.token

# 3. restart the guard — it reads the token when it starts
sudo launchctl kickstart -k system/com.zcode.guard

# 4. verify
sudo cat /opt/zcode/guard.token
curl -sS -H "Authorization: Bearer $(sudo cat /opt/zcode/guard.token)" \
     http://127.0.0.1:8090/api/info
```

The demo site keeps working through a rotation — the browser never had the
token, it has a session. Only direct API clients that cached the old one are
affected, and they get a `401` until they pick up the new value.

### Rotating the session secret

The session secret signs the session cookies. It is a different secret from
the bearer token, and it lives in its own file:

```bash
sudo sh -c "umask 077; printf '%s\n' \"$(openssl rand -hex 32)\" > /tmp/session.secret"
sudo install -m 0640 -o zcode -g zcode /tmp/session.secret /opt/zcode/session.secret
sudo launchctl kickstart -k system/com.zcode.guard
```

Rotating it invalidates every live session at once — each visitor's next
request gets a `401` and the site mints a new session automatically, so the
demo carries on. That is also the way to end every session at once.

---

## The device-bound session

A visitor of the public demo is admitted by a session, not by an account.
There is no sign-in, no email and nothing about the visitor is kept.

**How it works:**

1. The page asks the guard for a session: `POST /api/session`.
2. The guard answers `200` and sets two `HttpOnly` cookies:
   - `zcode_sid` — the session: its claims (id, device hash, issue time,
     expiry) under an HMAC over the server secret, so the cookie describes
     itself and the guard has to keep no session table;
   - `zcode_dev` — a random value that binds the session to this browser.
3. The browser sends both cookies on every later request. The guard checks
   that the pair belongs together and that the user-agent matches the one
   the session was minted with.
4. The session expires by itself (`--session-ttl-secs`, one hour by
   default). The site notices the `401`, mints a new one and carries on.

Because the session is stateless, **a restart does not end it** — the cookie
still carries its own claims, and the secret file is what keeps the
signature valid. Rotating the secret is how every session is ended at once.

**What it defends against:** a session cookie copied into another browser on
its own, a cookie edited to point at somebody else's session, and a client
that never went through the admission step at all.

**What it does not defend against:** an attacker who holds both cookies and
presents the same user-agent, or an attacker who drives a real browser. It is
an admission step and an accounting mechanism, not an identity system.

**Checking it:**

```bash
# mint a session and keep the cookies
curl -sS -X POST http://127.0.0.1:8090/api/session -D /tmp/jar.headers

# the guard now accepts it
curl -sS -H "Cookie: $(grep -i zcode_sid /tmp/jar.headers | cut -d' ' -f2 | tr -d '\r')" \
     http://127.0.0.1:8090/api/info

# ...and refuses it without the session
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8090/api/info
```

The cookies are marked `Secure`, so a plain-`http` client such as `curl` will
not send them back on its own — that is why the example passes them
explicitly. Browsers accept them on `http://localhost`.

**Turning sessions off.** `--no-sessions` refuses to mint any, which makes
the bearer token the only way in — the posture for a private deployment.

---

## Rate limiting belongs at THIS layer, keyed by IP

**The public deployment must rate limit at Caddy, by client IP.** Not in the
guard, not in the browser — in the reverse proxy, before the request is
proxied onward.

Two reasons, and together they are the whole reason:

1. **It sheds load before it costs anything.** The expensive part of this
   system is the model forward pass behind `/v1/guard/tool-call` and
   `/v1/chat/completions`. A limit applied inside the guard is applied
   *after* the request has been accepted, routed, and — for the inference
   routes — after it has already taken the Metal device. The edge limit
   refuses the request before any of that happens.
2. **It is keyed on the address Caddy saw on the socket.** The limiter uses
   `{remote_host}` and trusts no header at all. The guard's own limiter has
   to trust the right-most `X-Forwarded-For` entry, because it sits behind a
   proxy; the edge limiter needs no such trust, so there is nothing to
   forge.

### The gotcha: stock Caddy has no rate limiter

**`rate_limit` is not a Caddyfile directive in the standard build.** It comes
from the community module
[`github.com/mholt/caddy-ratelimit`](https://github.com/mholt/caddy-ratelimit),
which has to be compiled in.

The zone is **already in `deploy/Caddyfile`** — you do not paste anything — and
it is written in terms of that module. So the binary that serves the site
*must* have the module. `scripts/bootstrap_cloud_metal.sh` builds it into
`/opt/zcode/bin/caddy` and points the launchd daemon at that binary.

This fails loudly, which is the good way to fail: a Caddyfile containing
`rate_limit` on a binary without the module is a parse error, so Caddy
refuses to load the configuration rather than quietly serving an
unprotected site.

```
Error: adapting config using caddyfile: parsing caddyfile tokens for 'rate_limit': unrecognized directive: rate_limit
```

If you see that, the fix is the **binary**, not the Caddyfile.

### Build Caddy with the module

`xcaddy` is **not** a Homebrew formula — `brew install xcaddy` does not
exist. It is a Go program, so it installs with `go install`:

```bash
brew install go
go install github.com/caddyserver/xcaddy/cmd/xcaddy@latest
mkdir -p /opt/zcode/bin
"$(go env GOPATH)/bin/xcaddy" build \
    --with github.com/mholt/caddy-ratelimit \
    --output /opt/zcode/bin/caddy

# the module must be in the build
/opt/zcode/bin/caddy list-modules | grep rate
#   http.handlers.rate_limit
```

The bootstrap does exactly this, and skips the rebuild when the binary is
already there and already has the module. It then uses that binary for both
`caddy validate` and the launchd daemon — so the config that is validated is
the config that is served.

### The zone

`deploy/Caddyfile` carries two zones inside the `handle @guard` block:

```caddyfile
rate_limit {
	zone tool_call {
		match {
			path /v1/*
		}
		key          {remote_host}
		window       {$RL_TOOL_CALL_WINDOW:1m}
		events       {$RL_TOOL_CALL_EVENTS:10}
		ipv6_prefix  64
	}
	zone api {
		match {
			path /api/*
		}
		key          {remote_host}
		window       {$RL_API_WINDOW:1m}
		events       {$RL_API_EVENTS:60}
		ipv6_prefix  64
	}
}
```

Two zones because the two halves cost very different amounts: `/v1/*` runs
the model, `/api/*` is JSON and the event stream. The **static site and
`/health` are in neither zone** — a visitor is never throttled for loading a
page, and the liveness probe is never throttled.

The limits live in the environment, so an operator can tune them without
editing the file. The bootstrap writes them into `/opt/zcode/caddy/caddy.env`:

| Variable | Default | Meaning |
|---|---|---|
| `RL_TOOL_CALL_EVENTS` | `10` | `/v1/*` requests per IP per window |
| `RL_TOOL_CALL_WINDOW` | `1m` | the window for `/v1/*` |
| `RL_API_EVENTS` | `60` | `/api/*` requests per IP per window |
| `RL_API_WINDOW` | `1m` | the window for `/api/*` |

Notes on that configuration:

- **`key {remote_host}` is the client IP.** That is the requirement: rate
  limiting by address, not by a header the client controls.
- **The module uses a sliding window**, so `events 10 / window 1m` means ten
  requests in *any* sixty-second span, not ten per clock minute.
- **Over the limit the module answers `429` and sets `Retry-After` itself**,
  before the request is proxied to the guard. The rejected request never
  reaches the model — that is the whole point of limiting at the edge.
- **`ipv6_prefix 64` matters.** A client with a `/64` can cycle through
  billions of IPv6 addresses and walk straight past a per-address limit.
  Grouping the prefix puts the whole network in one bucket.
- **There is deliberately no `ipv4_prefix`.** Masking IPv4 to a `/24` would
  put an entire university or office NAT into one bucket and throttle every
  student behind it. An IPv4 client gets its own bucket.
- **`match` takes Caddy request matchers** (`path`, `method`, `header`, …).
  The expensive paths are matched specifically rather than the whole site, so
  the static assets are not charged against the API budget.

### Verify it is actually limiting

There is a script for this, and it checks the shipped file rather than a
copy:

```bash
# Build the binary once (see above), then:
ZCODE_CADDY_BIN=/opt/zcode/bin/caddy python3 evals/caddy_edge.py
```

It runs `deploy/Caddyfile` — unmodified — against a real Caddy and a real
HTTP backend, and asserts that:

1. the shipped configuration loads on a Caddy with the module;
2. a **stock** Caddy *refuses* the same file, so a mis-provisioned box
   fails loudly instead of serving unprotected;
3. the file is `caddy fmt` clean;
4. **the configuration as the box will run it validates** — a bare
   hostname, `:443`, `/opt/zcode/site` — and the *adapted* config (the
   thing that actually runs) really carries the two zones with the
   documented limits, keyed by client IP, with `/health` in neither;
5. a client that sends its own `X-Forwarded-For` has it **replaced** with
   the address Caddy saw, so it cannot choose its own bucket;
6. the limit sheds load **before** the backend — the refused requests never
   arrive, and the `429` carries a `Retry-After`;
7. the static site and `/health` are in no zone and are never throttled.

Check 4 is the one that matters for the box: everything else in this list
runs the config with values chosen to make it runnable on a laptop, while
check 4 uses the exact env file `bootstrap_cloud_metal.sh` writes.

The same script runs in CI, so a Caddyfile that would refuse to start on the
box cannot be committed.

From outside, on a live deployment:

```bash
for i in $(seq 1 40); do
    curl -s -o /dev/null -w '%{http_code} %{time_total}s\n' \
        -X POST https://clef.example.com/v1/guard/tool-call \
        -H 'Content-Type: application/json' -d '{"prompt":"ls"}'
done
#   the first ten answer 200, the rest answer 429
```

### If you cannot build the module

There is no fallback, and that is deliberate. The shipped Caddyfile uses
`rate_limit`, so a stock binary **cannot load it at all** — the deployment
stops rather than running unprotected.

The guard's own limiter (`--rate-limit-rpm`, the bootstrap defaults to 30)
is the backstop for direct clients on the box, not a substitute for the edge
limit. See the section below.

---

## The guard's own limiter — the backstop

The guard also rate-limits per client IP over a sliding sixty-second window
(`--rate-limit-rpm N`): a client gets exactly `N` requests in *any* sixty
second span, not `N` per clock minute.

**This is the backstop, not the primary limit.** It exists so that a direct
client — something on the machine, or a proxy that is misconfigured — cannot
spend the model's time without a ceiling. The edge limit in Caddy is what
protects a public deployment; see the section above.

The identity is the **right-most** `X-Forwarded-For` entry — the address the
nearest proxy observed — and Caddy overwrites that header with the address it
actually saw. A client therefore cannot forge its way into somebody else's
budget.

The header is only trusted when it comes from a peer the guard can vouch
for. `--trust-proxy` honours it **only from a peer on this machine**, which
is the shape of this deployment: the guard binds `127.0.0.1` and Caddy on
the same box forwards to it. A forwarded header arriving from the network is
not evidence — anyone can set it — so it is ignored and the client is keyed
on the socket peer instead, which is the safe direction to fail: every
client through such a proxy shares one bucket, so the limit is stricter
than intended rather than absent. If you put a proxy on *another* host, add
`--trust-proxy-any-peer`, and only then, if that proxy rewrites the header
itself.

Allowed responses carry the budget:

```
x-ratelimit-limit: 30
x-ratelimit-remaining: 29
```

Requests over the limit are refused with `429 Too Many Requests`, a
`retry-after` header, and a JSON body:

```json
{"error":"rate_limited","limit_per_minute":30,"retry_after_seconds":17}
```

To see it happen, stay under the limit first and then cross it:

```bash
# 30 requests, then a few more — the last ones must be 429
for i in $(seq 1 40); do
    curl -s -o /dev/null -w '%{http_code} %{size_download}\n' \
        -X POST https://clef.example.com/v1/guard/tool-call \
        -H 'Content-Type: application/json' -d '{}'
done
```

The same run against the loopback port shows the headers directly:

```bash
TOKEN=$(sudo cat /opt/zcode/guard.token)
curl -sS -D- -o /dev/null -H "Authorization: Bearer $TOKEN" \
     http://127.0.0.1:8090/api/info | grep -i ratelimit
```

To change the ceiling, edit `ZCODE_GUARD_RATE_LIMIT_RPM` in
`/Library/LaunchDaemons/com.zcode.guard.plist` (or pass `--rate-limit` to
`scripts/bootstrap_cloud_metal.sh`) and restart the guard:

```bash
sudo launchctl kickstart -k system/com.zcode.guard
```

`0` means unlimited — do not set that on a public endpoint.

---

## Troubleshooting

### Health checks

```bash
# the guard — no token needed, /health is exempt from auth and rate limiting
curl -sS http://127.0.0.1:8090/health
# {"status":"ok","service":"qwen-clef-repe-guard", ...}

# the upstream model server
curl -sS http://127.0.0.1:8123/v1/models

# through Caddy, from outside
curl -sS https://clef.example.com/health

# the guard's API, with the token
curl -sS -H "Authorization: Bearer $(sudo cat /opt/zcode/guard.token)" \
     http://127.0.0.1:8090/api/info
```

`/health` is the only route that does not need the token. Everything else
answers `401` with `{"error":"unauthorized","reason":"missing bearer token"}`
if the token is missing or wrong.

### The logs

| File | What is in it |
|---|---|
| `/var/log/zcode/caddy.log` | Caddy's own log: startup, ACME, certificate renewals. |
| `/var/log/zcode/caddy.err.log` | Caddy's stderr. |
| `/var/log/zcode/caddy-access.log` | One JSON line per request (the `log` block in the Caddyfile). The `Authorization` header is logged as `REDACTED`, so the token never lands in the log. |
| `/var/log/zcode/guard.log` | The guard's structured log (`RUST_LOG=info`). |
| `/var/log/zcode/guard.err.log` | The guard's stderr. |
| `/var/log/zcode/upstream.log` | The `mlx_lm.server` output. |
| `/var/log/zcode/upstream.err.log` | The upstream's stderr — the model loading errors land here. |

```bash
sudo tail -f /var/log/zcode/caddy.log
sudo tail -f /var/log/zcode/guard.log
sudo tail -f /var/log/zcode/upstream.err.log
```

### The services

```bash
sudo launchctl list | grep com.zcode        # are they loaded?
sudo launchctl print system/com.zcode.guard  # the details, the last exit code
sudo launchctl print system/com.zcode.caddy
```

Restart one:

```bash
sudo launchctl kickstart -k system/com.zcode.caddy
sudo launchctl kickstart -k system/com.zcode.guard
sudo launchctl kickstart -k system/com.zcode.upstream
```

Stop one (it comes back at the next boot, because `KeepAlive` is on and the
plist is in `/Library/LaunchDaemons`):

```bash
sudo launchctl bootout system/com.zcode.caddy
```

### The Caddy configuration

Validate before you load anything — a broken config never reaches the running
server:

```bash
sudo caddy validate --config /opt/zcode/caddy/Caddyfile \
                     --envfile /opt/zcode/caddy/caddy.env
sudo caddy fmt --diff /opt/zcode/caddy/Caddyfile   # formatting only
sudo caddy reload --config /opt/zcode/caddy/Caddyfile
```

`caddy validate` provisions every module, so it catches the mistakes that
only show up at runtime: a missing `SITE_ROOT`, a `GUARD_TOKEN` that is not
set, a bad `Content-Security-Policy`.

### Common failures

| Symptom | Cause | What to do |
|---|---|---|
| `502` from the browser | The guard is not running, or it crashed. | `sudo launchctl print system/com.zcode.guard`, then `sudo tail -40 /var/log/zcode/guard.err.log`. |
| `401` for a direct API call | Missing or wrong bearer token. | `sudo cat /opt/zcode/guard.token` and send `Authorization: Bearer <it>`. |
| `429` | Over the per-IP rate limit. | Wait for `retry-after`, or raise `--rate-limit-rpm`. |
| `413` | The request body is over 1 MB. | The API takes JSON probes, not uploads. |
| Certificate error in the browser | The name does not resolve here, or 80/443 is closed. | Check the A/AAAA record and the security group; `sudo tail -f /var/log/zcode/caddy.log` shows the ACME attempt. |
| The site loads but the API is empty | Caddy is serving the static files but the guard is not answering. | `curl -sS http://127.0.0.1:8090/health`. |
| `no such file or directory` for the model | The snapshot was deleted or never downloaded. | Check `/opt/zcode/models/hf/hub/models--Qwen--Qwen2.5-0.5B-Instruct/snapshots/`. |

---

## Changing the Caddyfile

`deploy/Caddyfile` in the repository is the source of truth. The copy that
runs is `/opt/zcode/caddy/Caddyfile`. To change it:

```bash
# edit deploy/Caddyfile in your checkout, then
scp deploy/Caddyfile user@box:/tmp/Caddyfile
sudo install -m 0644 -o root -g wheel /tmp/Caddyfile /opt/zcode/caddy/Caddyfile
sudo caddy validate --config /opt/zcode/caddy/Caddyfile \
                     --envfile /opt/zcode/caddy/caddy.env
sudo caddy reload --config /opt/zcode/caddy/Caddyfile
```

Or re-run `scripts/bootstrap_cloud_metal.sh`, which copies the file,
validates it, and only then loads it.
