#!/usr/bin/env bash
# Fetch zode provider keys from Secret Manager (project gcp-cheap-stack-7202)
# into .env.local. Create the secrets once, e.g.:
#   printf '%s' "$KEY" | gcloud secrets create zode-openai-api-key --project=gcp-cheap-stack-7202 --data-file=-
# Secret values are written only to .env.local (gitignored). Nothing is printed.
set -euo pipefail
PROJECT_ID="${PROJECT_ID:-gcp-cheap-stack-7202}"
OUT="${1:-.env.local}"
umask 077
: > "$OUT"
for pair in "zode-openai-api-key:OPENAI_API_KEY" "zode-anthropic-api-key:ANTHROPIC_API_KEY" "zode-gemini-api-key:GEMINI_API_KEY"; do
  secret="${pair%%:*}"; var="${pair##*:}"
  if value="$(gcloud secrets versions access latest --secret="$secret" --project="$PROJECT_ID" 2>/dev/null)"; then
    printf '%s=%s\n' "$var" "$value" >> "$OUT"
    echo "fetched $secret -> $var"
  else
    echo "skip $secret (not created yet)"
  fi
done
echo "wrote $OUT"
