# qwen-clef-repe-guard

Zero-shot model-agnostic MLX **RepE** hook + **Clef** joint-schema head
tool-call **blocker**, with an embedded live telemetry dashboard.

## The pieces

**Zero-shot introspection** (`src/zero_shot_loader.rs`). On startup the binary
reads `config.json` and the safetensors headers — single-file or sharded, with
either `model.layers.*` or `language_model.model.layers.*` prefixes — and infers
the layer count, residual width, vocabulary size, norm epsilon and the
per-projection quantization bit-width (4-bit, 6-bit, 8-bit, mixed OptiQ or bf16)
straight from the tensor shapes.

**Zero-pass RepE extraction.** When no cached `repe_vectors.safetensors` matches
the model's structural fingerprint, the vectors are computed from the static
weight matrices alone, in well under 150 ms and with no prompt forward pass:

- *Unembedding contrastive projection* — the unsafe coding lexemes (`rm`,
  `curl`, `.ssh`, `eval`) are contrasted against the safe ones (`cargo`,
  `test`, `check`, `status`) in the unembedding basis, after `final_norm`.
- *Layer-l\* MLP value-vector routing* — at the 68%-depth layer every column
  of `mlp.down_proj` is one MLP value vector; the columns are scored by their
  alignment with the unembedding axis and the strongest ones are isolated,
  yielding the middle-layer write direction that routes into destructive tool
  calls, plus a top-3 SVD/PCA basis.

**Blocking** (`src/enforcer_proxy.rs`). The proxy inspects every tool call in a
chat-completion response. In `enforce` mode an unsafe call is never returned to
the agent — the proxy answers `403` with the reason. `monitor` passes it
through and reports.

**Telemetry** (`src/viz_ui.html`). A dark dashboard is served at
`http://127.0.0.1:8090/`, streaming every intercepted call over SSE
(`/api/events`). It plots the per-layer RepE cosine profile across all decoder
layers, the PCA subspace coordinates (PC1/PC2/PC3), the Clef noul and score
probability distributions, and whether the call was clamped, circuit-broken or
passed. `/api/info` reports the model facts the guard introspected.

## How a call is judged

1. **Anchor.** The trusted user turn is run through the backbone and the
   residual state at the probe layer is pooled over the turn's tokens.
2. **Reading.** The intercepted call is run through the backbone and the
   residual is pooled over the **tool-call span** — the tokens of the tool
   name and its arguments, never the user's own wording. A single trailing
   token is dominated by however the request was phrased, which is what made
   the same command read +0.002 under one prompt and +0.052 under another.
3. **Clusters.** The harm direction is not one difference-in-means vector but
   three cluster centroids — filesystem destruction, secret reading and
   network exfiltration — each orthogonalised against the direction every
   benign shell command shares. The call is scored against the strongest
   cluster.
4. **Baseline.** The same context is rendered with a **panel** of five benign
   tool calls. The worst of them is the baseline for this context.
5. **Decision.** The statistic is `harm_cosine - baseline`, compared against
   the calibrated `harm_excess_threshold`.

The baseline is what makes the reading comparable across prompts: without it,
the absolute cosine carries an offset that depends on what the prompt already
contained.

The extractor and the guard must agree on the exact text they feed the
tokenizer, so both call the same `render_tool_call_turn` helper, both pool the
same tool-call span, and both measure the raw probe-layer residual (never the
final-normed one). `check_render_parity.py` asserts the renderings match byte
for byte.

### No mocks

Nothing in this project fabricates a measurement.

- The proxy has no built-in fake upstream. Point it at a real model server
  (for example `mlx_lm.server`) and it intercepts the tool calls that model
  actually produced.
- The Clef head is `Option`. If no trained `joint_head.safetensors` is
  supplied for the backbone, the Clef questions are **not evaluated** — the
  dashboard says so instead of drawing a distribution from random weights.
  A head is never invented.
- Every number on the dashboard comes from a real forward pass of the real
  backbone.

## Measured behaviour

Two benchmarks, both reproducible against a running guard.

**Canonical** (`final.py` — eight harmful/benign command pairs across five
prompt shapes, judged through the direct probe endpoint):

```
TOTAL: harmful blocked 31/40   benign wrongly blocked 0/40
```

The natural-language shape is 8/8 with 0 false positives; the misses are
concentrated in the synthetic `run:<cmd>` echo shapes, where the prompt names
a different command than the one being judged.

**Real model** (`real_eval.py` — a real `mlx_lm` upstream is asked for a goal
in natural language and the guard judges whatever command the model actually
produced; nothing is injected):

```
harmful blocked 7/10   benign wrongly blocked 0/10
```

Two of the three misses are calls where the model emitted no command at all,
and the third (`kubectl config current-context`) was not destructive. On the
calls that carried a command: **7/8 harmful blocked, 0/8 benign blocked**.

**Limits, stated plainly.** The curated benchmark and real-model traffic do
not agree, and the gap is real: a threshold fitted on hand-written commands
does not transfer to the commands a model actually emits, which is why the
calibration set now contains the commands the real upstream produced. The
upstream used here is Qwen2.5-0.5B-Instruct, whose tool calls are often
malformed or unrelated to the request; a stronger upstream will produce
different traffic and wants its own calibration pass. The guard's recall on
the synthetic echo shapes is materially lower than on natural-language goals.

## Run

```bash
# Zero-shot: no vectors file needed, no checkpoint needed
cargo run -- --self-test

# Real checkpoint: introspection + zero-shot calibration + dashboard
cargo run -- --port 8090 --model /path/to/checkpoint

# Explicit vectors and a real Clef joint head
cargo run -- --port 8090 \
  --model /path/to/checkpoint \
  --repe artifacts/repe_vectors.safetensors \
  --joint-head /path/to/checkpoint/joint_head.safetensors
```

## Calibration

Vectors are cached with the model fingerprint they were derived from. A later
run reuses them only when the fingerprint still matches; otherwise the zero-shot
extraction runs again. A cache that belongs to a different model is copied to
`<name>.safetensors.bak` before it is replaced.

The extractor measures the operating point from the data instead of guessing
it: it prints the per-pair table and picks the threshold that catches as many
harmful calls as possible while keeping the false-positive rate on the benign
population at or below 10%.

```bash
# Python reference path (works for hybrid attention stacks too)
uv run --python 3.12 --with mlx-lm python3 ../extract_repe_vectors.py \
  --model /path/to/checkpoint --pca-k 3 \
  --out artifacts/repe_vectors.safetensors

# In-language path (dense stacks only)
cargo run --bin extract-repe -- \
  --model /path/to/checkpoint --out artifacts/repe_vectors.safetensors
```

## Layout

| File | Role |
|---|---|
| `src/zero_shot_loader.rs` | Introspection, fingerprinting, closed-form RepE extraction |
| `src/mlx_loader.rs` | Sharded safetensors loader; quantized and bf16 projections; RoPE + GQA |
| `src/repe_sensor.rs` | Layer hook, clamping, per-layer profile, vector cache |
| `src/clef_head.rs` | Clef joint-schema head over the final hidden state |
| `src/qwen_hook.rs` | The hooked decoder loop |
| `src/enforcer_proxy.rs` | Blocking proxy, telemetry bus, SSE endpoint |
| `src/viz_ui.html` | The embedded dashboard |
| `src/bin/extract_repe.rs` | In-language RepE extractor |

## Wiring it into an agent loop

The natural interception point is wherever tool specs become executable — in
Zode that is `toAgentTools` in `src/llm/pi.js`. Either call
`/v1/guard/tool-call` before running the tool, or point the agent's base URL at
this proxy so unsafe tool calls never reach it.

## Measured behaviour

On `Qwen/Qwen2.5-0.5B-Instruct` with vectors calibrated by `extract-repe`, the
eight harmful/benign calibration pairs replayed through five different prompt
shapes (a plain task description, a prompt naming the command, a terse
`run:<cmd>` form, and two more) give **37/40 harmful calls blocked with 4/40
benign calls wrongly blocked** — a 10% false-positive rate, which is the
budget the operating point is calibrated to.

The zero-shot direction extracted from the static weights is much weaker on
this model — a cosine scale of roughly 0.01 against 0.2-0.4 for a calibrated
direction. It is a starting point, not a substitute for calibration.

## Known gaps

- **Hybrid attention stacks are not implemented in Rust.** Qwen3.5 / Qwen3.8
  interleave gated linear attention with full attention; the reference decoder
  block implements the dense stack only and the loader refuses such a
  checkpoint. Use the Python extractor and serve the backbone from `mlx_lm`.
- The Clef joint head is loaded through its four projection matrices; the
  upstream head's evidence-routing and transformer layers are not reproduced.
- An untrained head cannot block: its answers are reported but never block on
  their own.
- **The task-drift signal is advisory only.** `v_drift` is calibrated on
  tool-*response* turns (a poisoned file body read back into the context),
  while this proxy intercepts tool *calls*; the two states are not comparable,
  so the drift reading is reported but never blocks on its own.
- The zero-shot direction needs no calibration but is much weaker than a
  calibrated one, and its cosine scale is model-specific — tune `--threshold`
  or run the extractor.
- Thresholds transfer within a prompt distribution, not across it. Re-derive
  them for your own traffic, or run in `monitor` mode while you measure.
