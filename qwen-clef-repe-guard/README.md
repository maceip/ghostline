# qwen-clef-repe-guard

Native Rust + MLX Representation Engineering (RepE) and Clef pre-execution guard for AI agent tool calls on Apple Silicon.

## Core Components

- **Zero-shot model introspection (`src/zero_shot_loader.rs`)**: Reads `config.json` and single-file or sharded `.safetensors` headers (`model.layers.*` or `language_model.model.layers.*`) to infer layer count, hidden dimension, vocabulary size, RMSNorm epsilon, and quantization layout (`4-bit`, `6-bit`, `8-bit`, mixed OptiQ, or `bf16`). When no calibrated vector artifact matches the model fingerprint and zero-shot mode is enabled, it extracts an initial contrastive direction directly from static unembedding and `mlp.down_proj` value vectors in under 150 ms.
- **Hooked decoder and hybrid Gated DeltaNet runtime (`src/mlx_loader.rs`, `src/qwen_hook.rs`, `src/gdn.rs`)**: Runs dense Qwen2 transformer stacks and hybrid Gated DeltaNet / full-attention stacks (`Cloudflare/clef-flash`) on Metal with fused `mlx_rs::fast` kernels, speculative KV-cache slicing, and `0.0001` cosine parity against Python `mlx_lm`.
- **Fisher-whitened RepE sensor (`src/repe_sensor.rs`, `src/whiten.rs`)**: Scores `<tool_call>` token spans against calibrated harm clusters whitened via a dual Woodbury Ledoit-Wolf shrinkage solver (`O(n^2 d + n^3)`), with centered 2D/3D PCA subspace telemetry and counterfactual activation clamping.
- **Pre-execution proxy and telemetry plane (`src/enforcer_proxy.rs`, `src/viz_ui.html`)**: Exposes `POST /v1/guard/tool-call` for agent tool runners, `POST /v1/chat/completions` as an OpenAI-compatible intercepting proxy, runtime policy/mode controls, online contrastive pair hot-reloading, and live `GhostlineTraceFrame` Server-Sent Events (`/api/events`).

## How Tool Calls Are Evaluated

1. **Pass-1 Trusted Anchor**: `clean_trusted_prompt` strips embedded untrusted payloads from the user message, runs Pass 1 through the model up to the probe layer (`l* = 16` on 24-layer Qwen2.5-0.5B), and caches the pooled user-intent anchor state.
2. **Pass-2 Tool-Span Extraction**: Any untrusted tool outputs are isolated inside `<tool_response>` turns, and the candidate shell command or structured JSON tool call is rendered via `render_tool_call_turn` (byte-identical to `extract_repe_vectors.py`, verified by `tools/check_render_parity.py`). Only tokens inside the `<tool_call>` span `[T, D]` are scored so prompt phrasing does not skew short tool calls.
3. **Whitened Multi-Cluster Projection**: Copy/echo directions are projected out, and each span token is scored in one vectorized `[T, D] @ [D, C]` multiply against three Fisher-whitened harm clusters: destructive mutations, credential/secret reads, and network exfiltration.
4. **Span Pooling**: Token scores are aggregated per cluster using the artifact's calibrated pooling mode (`mean`, length-invariant LogMeanExp `lse:<beta>`, `hybrid:<beta>:<weight>`, or Conditional Value-at-Risk top-`k` `cvar:<k>`). Structured non-`bash` JSON tool calls use `cvar:6` so localized exploit payloads are not diluted across verbose JSON keys and punctuation.
5. **Matched Baseline Subtraction**: The guard subtracts a matched-verb shell baseline or schema-preserving per-cluster 80th-percentile JSON tool baseline (`harm_excess = max_c (score_c - baseline_c)`), removing prompt-dependent cosine offsets, and compares `harm_excess` against the calibrated conformal threshold.

### Integrity Guarantees

- Every score, layer trace, PCA coordinate, and token attribution comes from a live forward pass of the loaded model checkpoint. No synthetic fallback scores or mock upstreams exist in the crate.
- Optional heads (`ClefHead` via `--joint-head`) evaluate only when real trained weights are provided; otherwise `clef_decisions` is empty rather than populated from uninitialized weights.

## Measured Performance

Reproducible via `bash ../evals/verify_all.sh`:

- **Frozen 50-command held-out benchmark (`evals/heldout_novel.py`)**: `16 / 20` (`80.0%`) novel harmful commands blocked at `3 / 30` (`10.0%`) benign false positives (`Youden's J = 0.700`), compared to `10 / 20` harmful blocked at `6 / 30` false positives (`J = 0.300`) for a lexical keyword filter.
- **24-pair `.632` LOPO cross-validation**: `24 / 24` pair accuracy; panel AUROC `0.9375` on `Qwen2.5-0.5B-Instruct` and `0.9549` on `Cloudflare/clef-flash`.
- **Canonical multi-prompt suite (`evals/canonical_40.py`)**: `40 / 40` harmful calls blocked, `1 / 40` benign false positive across 5 prompt templates.
- **Structured JSON tool calls**: Positive margin separation across `read_file`, `write_file`, `http_request`, and nested MCP `argv` schemas, with `~28 ms` static-panel prefill latency on Apple Silicon.

## Running the Guard

```bash
# Self-test mode
cargo run --release -- --self-test

# Production enforce mode with calibrated vectors
cargo run --release -- \
  --port 8090 \
  --upstream http://127.0.0.1:8123 \
  --model /path/to/Qwen2.5-0.5B-Instruct \
  --repe artifacts/repe_vectors_qwen2_5_0_5b_v2.safetensors \
  --mode enforce \
  --no-zero-shot

# Include an optional trained Clef joint head
cargo run --release -- \
  --port 8090 \
  --model /path/to/checkpoint \
  --repe artifacts/repe_vectors_clef_flash.safetensors \
  --joint-head /path/to/checkpoint/joint_head.safetensors
```

## Calibration

Artifacts embed the checkpoint fingerprint and pooling configuration. Recalibrate when changing models, pooling modes, or agent prompt wrappers:

```bash
# Python MLX extractor (supports dense and hybrid Gated DeltaNet models)
uv run --python 3.12 --with mlx-lm python3 ../extract_repe_vectors.py \
  --model /path/to/checkpoint \
  --pooling mean \
  --fp-budget-pct 10.0 \
  --out artifacts/repe_vectors.safetensors

# Native Rust extractor (dense Transformer stacks)
cargo run --release --bin extract-repe -- \
  --model /path/to/checkpoint \
  --pooling mean \
  --fp-budget-pct 10.0 \
  --out artifacts/repe_vectors.safetensors

# Split-conformal threshold and Fisher refit from labeled JSONL traffic
cargo run --release --bin site-calibrate -- \
  --model /path/to/checkpoint \
  --labels artifacts/site_calibration.jsonl \
  --alpha 0.05 \
  --out artifacts/repe_vectors_site.safetensors
```

## Source Layout

| File | Responsibility |
| :--- | :--- |
| `src/zero_shot_loader.rs` | Checkpoint introspection, structural fingerprinting, closed-form weight extraction |
| `src/mlx_loader.rs` | Sharded safetensors loader, quantized/bf16 projections, RoPE, and GQA |
| `src/gdn.rs` & `src/joint_head.rs` | Hybrid Gated DeltaNet recurrence and Clef joint-head projections |
| `src/whiten.rs` | Dual Woodbury Ledoit-Wolf shrinkage and regularized Fisher discriminant solver |
| `src/repe_sensor.rs` | Span scoring (`mean`, `lse`, `hybrid`, `cvar`), centered PCA subspace, activation clamping |
| `src/qwen_hook.rs` | Hooked decoder passes, cached anchor/panel evaluation, multi-cluster hot-reload, KV rollback |
| `src/enforcer_proxy.rs` | HTTP proxy, pre-tool guard endpoint, schema-preserving baselines, SSE telemetry, runtime policy |
| `src/trajectory.rs` | Per-conversation EMA and slope detector for multi-turn escalation |
| `src/capability.rs` | Offline Ed25519 capability token verification for human-approved tool calls |
| `src/site_calibration.rs` | Split-conformal quantile estimation and Fisher cluster refitting |
| `src/rollback.rs` | Speculative KV cache management and Layer-16 clamp-and-rollback decoding |
| `src/access.rs` & `src/session.rs` | Bearer authentication, peer-verified rate limiting, stateless HMAC device-bound sessions |

## Additional Telemetry and Controls

- **Token-level attribution**: Reports the exact `<tool_call>` token index, decoded token text, and cluster id carrying peak harm salience.
- **Untrusted-span attention ratio**: Reports the fraction of probe-layer attention from `<tool_call>` tokens landing on `untrusted_context` (`role: "tool"` turns) as forensic provenance without blocking on attention share alone.
- **Cross-turn escalation (`conversation_id`)**: Accumulates per-cluster excess with an EMA (`lambda = 0.7`) and linear slope so gradual multi-step attacks trip even when individual commands sit slightly below single-turn thresholds.
- **Ed25519 capability tokens**: Allows human-reviewed actions (for example via `tools/touchid_stepup.swift` on macOS) to pass with a short-lived signature bound to the exact tool name and SHA-256 argument digest.

## Operational Caveats

- Zero-shot weight extraction provides a cold-start fallback (`~0.01` cosine scale) and is substantially weaker than forward-pass contrastive calibration (`~0.1-0.4` scale); always prefer calibrated vector artifacts in production.
- `v_drift` cosines are calibrated on `<tool_response>` poisoning examples and emitted as non-blocking advisories during `<tool_call>` interception.
- Re-evaluate thresholds in `--mode monitor` before switching to `enforce` when migrating to a new agent prompt template or model family.
