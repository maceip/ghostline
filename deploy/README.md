# The Caddy front — operator notes

This directory holds the production front end for the MLX tool-call guard:
`Caddyfile` is the reverse proxy that puts TLS, a static site and the guard's
API on one origin.  `scripts/bootstrap_cloud_metal.sh` installs it on a cloud
macOS box; this file is what you read when something is wrong.

---

## The pieces

| Piece | Where | What it does |
|---|---|---|
| **Caddy** | `/opt/zcode/caddy/Caddyfile` | Terminates TLS, serves the static site at `/`, forwards the API to the guard, injects the bearer token. |
| **Caddy environment** | `/opt/zcode/caddy/caddy.env` | The `KEY=VALUE` file the Caddy service loads with `--envfile`. Holds the token. |
| **The guard** | `com.zcode.guard` (launchd daemon) | The Rust binary from `qwen-clef-repe-guard/`. Scores tool calls against the calibrated RepE vectors and refuses the harmful ones. Listens on `127.0.0.1:8090`. |
| **The upstream** | `com.zcode.upstream` (launchd daemon) | `mlx_lm.server` with `Qwen/Qwen2.5-0.5B-Instruct`. Listens on `127.0.0.1:8123`. |
| **The static site** | `/opt/zcode/site` | A copy of `clef-site/` from the repository. |
| **The token** | `/opt/zcode/guard.token` | The bearer token, mode `0640`, owned by the `zcode` service user. |

The guard and the upstream both listen on loopback only. **Caddy is the only
thing the internet can reach**, and it is the only thing that holds the token
in a request.

### The request path

```
browser ──https──> Caddy ──http──> guard (127.0.0.1:8090) ──http──> mlx_lm (127.0.0.1:8123)
                    │
                    └── Authorization: Bearer <token>   ← added here, server-side
```

The browser never receives the token and never sends it. It cannot leak it by
reading the page, the source, or the network tab, and it cannot override it by
sending its own `Authorization` header — Caddy replaces that header on the way
through.

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
| `GUARD_TOKEN` | The bearer token Caddy sends to the guard. **Required.** | `9f2c…` (64 hex chars) |
| `GUARD_PORT` | The port the guard listens on. | `8090` (default) |
| `SITE_ROOT` | The directory holding the static site. | `/opt/zcode/site` (default) |
| `ACME_EMAIL` | The contact address for the ACME account. **Required.** | `ops@example.com` |

The same names are read by the guard as `ZCODE_GUARD_TOKEN`,
`ZCODE_GUARD_TOKEN_FILE` and `ZCODE_GUARD_RATE_LIMIT_RPM`.

The token is written to **two** places on purpose, and they must agree:
`/opt/zcode/guard.token` is what the guard reads, and `GUARD_TOKEN` in
`caddy.env` is what Caddy sends. The rotation procedure below changes both.

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

The token is the guard's front door. Rotate it if it leaks, if someone had
access to the box, or on a schedule you decided on.

**Both processes have to change.** The guard reads the token from a file, and
Caddy holds it in its environment; a restart — not a reload — is what makes
each of them pick up a new value.

```bash
# 1. a new token
NEW=$(openssl rand -hex 32)

# 2. what the guard will read (mode 0640, owned by the service user)
sudo sh -c "umask 077; printf '%s\n' '$NEW' > /tmp/guard.token"
sudo install -m 0640 -o zcode -g zcode /tmp/guard.token /opt/zcode/guard.token

# 3. what Caddy will send
sudo sed -i '' "s|^GUARD_TOKEN=.*|GUARD_TOKEN=$NEW|" /opt/zcode/caddy/caddy.env

# 4. restart BOTH — a reload is not enough for Caddy, it reads the
#    environment when the process starts
sudo launchctl kickstart -k system/com.zcode.guard
sudo launchctl kickstart -k system/com.zcode.caddy

# 5. verify
sudo cat /opt/zcode/guard.token
curl -sS -H "Authorization: Bearer $(sudo cat /opt/zcode/guard.token)" \
     http://127.0.0.1:8090/api/info
```

The demo site keeps working through a rotation — the browser never had the
token. Only direct API clients that cached the old one are affected.

`sudo caddy reload --config /opt/zcode/caddy/Caddyfile` is the right command
for an ordinary configuration change, but it re-reads the Caddyfile in the
**running process**, so it still uses the environment the process started
with. That is why a token change needs a restart.

---

## Checking that rate limiting works

The guard rate-limits per client IP over a sliding sixty-second window
(`--rate-limit-rpm N`): a client gets exactly `N` requests in *any* sixty
second span, not `N` per clock minute. It is the layer that actually protects
a public endpoint, because the expensive part is the model inference behind
the guard, not the token check.

The identity is the **right-most** `X-Forwarded-For` entry — the address the
nearest proxy observed — and Caddy overwrites that header with the address it
actually saw. A client therefore cannot forge its way into somebody else's
budget.

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
| `/var/log/zcode/caddy-access.log` | One JSON line per request (the `log` block in the Caddyfile). |
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
