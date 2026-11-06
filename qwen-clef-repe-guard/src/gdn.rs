//! Gated DeltaNet (Gated Delta Rule) forward pass.
//!
//! Ported literally from the on-disk Python reference:
//!
//! * `mlx_lm/models/qwen3_5.py` -> `GatedDeltaNet.__call__`
//! * `mlx_lm/models/gated_delta.py` -> `gated_delta_ops`, `_gated_delta_step_ops`,
//!   `compute_g`, `normalize_qk`
//! * `mlx_lm/models/qwen3_next.py` -> `Qwen3NextRMSNormGated`
//! * `mlx_lm/models/activations.py` -> `precise_swiglu`
//!
//! `mlx-rs` does not expose `mx.fast.gated_delta_update`, so the recurrence is
//! expressed with ordinary MLX ops using the `_gated_delta_step_ops`
//! formulation. The recurrent state is kept in `float32` throughout the loop,
//! exactly as the reference does.
//!
//! This module is self-contained: it only depends on `mlx-rs` and `anyhow`.

use anyhow::Result;
use mlx_rs::{
    Array,
    fast,
    nn::{sigmoid, softplus},
    ops::{self, indexing::IndexOp},
};

/// Geometry of one Gated DeltaNet block.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy)]
pub struct GdnConfig {
    /// Model hidden size.
    pub hidden_size: i32,
    /// Number of value heads (`Hv`).
    pub num_v_heads: i32,
    /// Number of key heads (`Hk`).
    pub num_k_heads: i32,
    /// Per-head key dimension (`Dk`).
    pub head_k_dim: i32,
    /// Per-head value dimension (`Dv`).
    pub head_v_dim: i32,
    /// Depthwise causal convolution kernel size.
    pub conv_kernel_size: i32,
    /// Epsilon of the gated RMSNorm.
    pub rms_eps: f32,
}

impl GdnConfig {
    /// Total width of the concatenated query/key projection (`Hk * Dk`).
    pub fn key_dim(&self) -> i32 {
        self.num_k_heads * self.head_k_dim
    }

    /// Total width of the value projection (`Hv * Dv`).
    pub fn value_dim(&self) -> i32 {
        self.num_v_heads * self.head_v_dim
    }

    /// Width of the fused qkv projection (`2 * key_dim + value_dim`).
    pub fn conv_dim(&self) -> i32 {
        self.key_dim() * 2 + self.value_dim()
    }
}

/// `mlx.nn.activation.silu`: `x * sigmoid(x)`.
///
/// The reference calls the `mx.compile`d `mlx.nn.activation.silu`. On the
/// reference's MLX build (0.32.4) the compiled and the unfused forms are
/// bit-identical, but MLX's compiled `silu` on the Rust side (MLX 0.34) is
/// not — it differs from the unfused form by one ULP on roughly 1% of the
/// elements. Evaluating the unfused formula here makes both sides run the
/// same arithmetic.
pub fn silu(x: &Array) -> Result<Array> {
    Ok(ops::multiply(x, &ops::sigmoid(x)?)?)
}

/// `x @ weight.T` — the `nn.Linear` convention used throughout the reference.
pub fn linear(x: &Array, weight: &Array) -> Result<Array> {
    let w_t = ops::transpose_axes(weight, &[1, 0])?;
    Ok(ops::matmul(x, &w_t)?)
}

/// `mx.fast.rms_norm` over the last axis.
pub fn rms_norm(x: &Array, weight: Option<&Array>, eps: f32) -> Result<Array> {
    Ok(fast::rms_norm(x, weight, eps)?)
}

/// `mlx_lm.models.gated_delta.normalize_qk`.
///
/// The reference folds the `Dk**-0.5` readout scale into `q` and scales `k` by
/// the same factor; `rms_eps` is scaled by `inv_scale**2` because
/// `mx.fast.rms_norm` adds the epsilon to the *mean* of the squares rather than
/// to their sum.
fn normalize_qk(q: &Array, k: &Array, head_k_dim: i32, eps: f64) -> Result<(Array, Array)> {
    // Computed in f64 to match the Python reference's float arithmetic, then
    // narrowed to f32 exactly where MLX would narrow it.
    let inv_scale = (head_k_dim as f64).powf(-0.5);
    let inv_scale_sq = inv_scale.powi(2);
    let rms_eps = (eps * inv_scale_sq) as f32;

    let q = ops::multiply(
        &fast::rms_norm(q, None, rms_eps)?,
        &Array::from_f32(inv_scale_sq as f32),
    )?;
    let k = ops::multiply(
        &fast::rms_norm(k, None, rms_eps)?,
        &Array::from_f32(inv_scale as f32),
    )?;
    Ok((q, k))
}

/// Intermediates of one Gated DeltaNet block.
///
/// They are cheap to keep (MLX arrays are shared handles) and make it possible
/// to localize a numerical divergence against the Python reference step by
/// step.
#[derive(Debug, Default)]
pub struct GdnTrace {
    /// Fused qkv projection, `[B, S, conv_dim]`.
    pub qkv: Option<Array>,
    /// Reshaped gate projection, `[B, S, Hv, Dv]`.
    pub z: Option<Array>,
    /// `b` projection, `[B, S, Hv]`.
    pub b_proj: Option<Array>,
    /// `a` projection, `[B, S, Hv]`.
    pub a_proj: Option<Array>,
    /// Convolution output before the SiLU, `[B, S, conv_dim]`.
    pub conv_pre: Option<Array>,
    /// Convolution output after the SiLU, `[B, S, conv_dim]`.
    pub conv_out: Option<Array>,
    /// Normalized query, `[B, S, Hk, Dk]`.
    pub q: Option<Array>,
    /// Normalized key, `[B, S, Hk, Dk]`.
    pub k: Option<Array>,
    /// Value, `[B, S, Hv, Dv]`.
    pub v: Option<Array>,
    /// `a + dt_bias`, `[B, S, Hv]`.
    pub a_dt: Option<Array>,
    /// `softplus(a + dt_bias)`, `[B, S, Hv]`.
    pub soft: Option<Array>,
    /// The exponent of the decay gate, `[B, S, Hv]`.
    pub g_exp: Option<Array>,
    /// Decay gate, `[B, S, Hv]`.
    pub g: Option<Array>,
    /// Beta, `[B, S, Hv]`.
    pub beta: Option<Array>,
    /// Final recurrent state, `[B, Hv, Dv, Dk]`.
    pub state: Option<Array>,
    /// Recurrence output, `[B, S, Hv, Dv]`.
    pub y: Option<Array>,
    /// Gated RMSNorm output, `[B, S, Hv, Dv]`.
    pub normed: Option<Array>,
    /// Gated (swiglu) output, `[B, S, Hv, Dv]`.
    pub gated: Option<Array>,
}

/// `mlx_lm.models.gated_delta.compute_g`:
/// `exp(-exp(A_log) * softplus(a + dt_bias))`.
fn compute_g(
    a_log: &Array,
    a: &Array,
    dt_bias: &Array,
    trace: &mut GdnTrace,
) -> Result<Array> {
    let a_log_f32 = a_log.as_type::<f32>()?;
    let neg_exp_a_log = ops::negative(&ops::exp(&a_log_f32)?)?;
    let a_dt = ops::add(a, dt_bias)?;
    let soft = softplus(&a_dt)?;
    let exponent = ops::multiply(&neg_exp_a_log, &soft)?;
    let g = ops::exp(&exponent)?;
    trace.a_dt = Some(a_dt);
    trace.soft = Some(soft);
    trace.g_exp = Some(exponent);
    trace.g = Some(g.clone());
    Ok(g)
}

/// `mx.repeat(x, repeats, axis=-2)`.
///
/// MLX inserts a new axis of size `repeats` after the head axis and broadcasts,
/// which *interleaves* the heads: output head `h` maps to input head
/// `h / repeats`. The Metal reference kernel uses the same convention
/// (`hk_idx = hv_idx / (Hv / Hk)`).
fn repeat_heads(x: &Array, repeats: i32) -> Result<Array> {
    if repeats == 1 {
        return Ok(x.clone());
    }
    let shape = x.shape();
    let (b, s, h, d) = (shape[0], shape[1], shape[2], shape[3]);
    let x5 = ops::reshape(x, &[b, s, h, 1, d])?;
    let tiled = ops::broadcast_to(&x5, &[b, s, h, repeats, d])?;
    Ok(ops::reshape(&tiled, &[b, s, h * repeats, d])?)
}

/// Weights of one Gated DeltaNet block. All tensors are `float32`.
#[derive(Debug, Clone)]
pub struct GatedDeltaNetWeights {
    /// Fused query/key/value projection, `[conv_dim, hidden_size]`.
    pub in_proj_qkv: Array,
    /// Gate projection, `[value_dim, hidden_size]`.
    pub in_proj_z: Array,
    /// `a` (decay) projection, `[num_v_heads, hidden_size]`.
    pub in_proj_a: Array,
    /// `b` (beta) projection, `[num_v_heads, hidden_size]`.
    pub in_proj_b: Array,
    /// Depthwise convolution kernel, `[conv_dim, kernel_size, 1]`.
    pub conv1d: Array,
    /// Log of the per-head decay rate, `[num_v_heads]`.
    pub a_log: Array,
    /// Per-head timestep bias, `[num_v_heads]`.
    pub dt_bias: Array,
    /// Gated RMSNorm weight, `[head_v_dim]`.
    pub norm: Array,
    /// Output projection, `[hidden_size, value_dim]`.
    pub out_proj: Array,
}

impl GatedDeltaNetWeights {
    /// Forward pass for an input shaped `[B, S, hidden_size]`.
    pub fn forward(&self, cfg: &GdnConfig, inputs: &Array) -> Result<Array> {
        let mut trace = GdnTrace::default();
        self.forward_traced(cfg, inputs, &mut trace)
    }

    /// Forward pass that also records the intermediates in `trace`.
    pub fn forward_traced(
        &self,
        cfg: &GdnConfig,
        inputs: &Array,
        trace: &mut GdnTrace,
    ) -> Result<Array> {
        let in_shape = inputs.shape();
        let (b, s) = (in_shape[0], in_shape[1]);
        let key_dim = cfg.key_dim();
        let value_dim = cfg.value_dim();
        let conv_dim = cfg.conv_dim();

        // 1. Projections.
        let qkv = linear(inputs, &self.in_proj_qkv)?; // [B, S, conv_dim]
        let z = linear(inputs, &self.in_proj_z)?; // [B, S, value_dim]
        let z = ops::reshape(&z, &[b, s, cfg.num_v_heads, cfg.head_v_dim])?;
        let b_proj = linear(inputs, &self.in_proj_b)?; // [B, S, Hv]
        let a_proj = linear(inputs, &self.in_proj_a)?; // [B, S, Hv]
        trace.qkv = Some(qkv.clone());
        trace.z = Some(z.clone());
        trace.b_proj = Some(b_proj.clone());
        trace.a_proj = Some(a_proj.clone());

        // 2. Causal depthwise convolution: the zero state is prepended so the
        //    convolution sees `kernel_size - 1` tokens of history.
        let conv_state = Array::zeros::<f32>(&[b, cfg.conv_kernel_size - 1, conv_dim])?;
        let conv_input = ops::concatenate(&[&conv_state, &qkv], 1)?; // [B, S+3, conv_dim]
        let conv_out = ops::conv1d(&conv_input, &self.conv1d, 1, 0, 1, conv_dim)?;
        trace.conv_pre = Some(conv_out.clone());
        let conv_out = silu(&conv_out)?; // [B, S, conv_dim]
        trace.conv_out = Some(conv_out.clone());

        // 3. Split into q / k / v and shape them per head.
        let parts = ops::split_at_indices(&conv_out, &[key_dim, 2 * key_dim], -1)?;
        let q = ops::reshape(&parts[0], &[b, s, cfg.num_k_heads, cfg.head_k_dim])?;
        let k = ops::reshape(&parts[1], &[b, s, cfg.num_k_heads, cfg.head_k_dim])?;
        let v = ops::reshape(&parts[2], &[b, s, cfg.num_v_heads, cfg.head_v_dim])?;

        // 4. Normalize q/k and compute the gates.
        let (q, k) = normalize_qk(&q, &k, cfg.head_k_dim, 1e-6)?;
        let g = compute_g(&self.a_log, &a_proj, &self.dt_bias, trace)?; // [B, S, Hv]
        let beta = sigmoid(&b_proj)?; // [B, S, Hv]
        trace.q = Some(q.clone());
        trace.k = Some(k.clone());
        trace.v = Some(v.clone());
        trace.beta = Some(beta.clone());

        // 5. Repeat the key heads across the value heads.
        let repeats = cfg.num_v_heads / cfg.num_k_heads;
        let q = repeat_heads(&q, repeats)?;
        let k = repeat_heads(&k, repeats)?;

        // 6. Gated DeltaNet recurrence (float32 state throughout).
        let mut state = Array::zeros::<f32>(&[
            b,
            cfg.num_v_heads,
            cfg.head_v_dim,
            cfg.head_k_dim,
        ])?;
        let mut ys: Vec<Array> = Vec::with_capacity(s as usize);
        for t in 0..s {
            let decay = ops::reshape(&g.index((.., t)), &[b, cfg.num_v_heads, 1, 1])?;
            let k_t = k.index((.., t, .., ..)); // [B, Hv, Dk]
            let v_t = v.index((.., t, .., ..)); // [B, Hv, Dv]
            let q_t = q.index((.., t, .., ..)); // [B, Hv, Dk]
            let beta_t = ops::expand_dims(&beta.index((.., t)), 2)?; // [B, Hv, 1]

            // state = state * g[:, t]
            state = ops::multiply(&state, &decay)?;

            // kv_mem = (state * k[:, t][..., None, :]).sum(-1)
            let k_exp = ops::expand_dims_axes(&k_t, &[2])?; // [B, Hv, 1, Dk]
            let kv_mem = ops::sum_axes(&ops::multiply(&state, &k_exp)?, &[-1], false)?;

            // delta = (v[:, t] - kv_mem) * beta[:, t][..., None]
            let delta = ops::multiply(&ops::subtract(&v_t, &kv_mem)?, &beta_t)?;

            // state = state + k[:, t][..., None, :] * delta[..., None]
            state = ops::add(
                &state,
                &ops::multiply(&k_exp, &ops::expand_dims(&delta, 3)?)?,
            )?;

            // y[:, t] = (state * q[:, t][..., None, :]).sum(-1)
            let q_exp = ops::expand_dims_axes(&q_t, &[2])?; // [B, Hv, 1, Dk]
            let y = ops::sum_axes(&ops::multiply(&state, &q_exp)?, &[-1], false)?;
            ys.push(y);
        }
        let out = ops::stack(&ys, 1)?; // [B, S, Hv, Dv]
        trace.state = Some(state.clone());
        trace.y = Some(out.clone());

        // 7. Gated RMSNorm: `precise_swiglu(out, z, rms_norm(out, norm.weight, eps))`.
        let normed = fast::rms_norm(&out, Some(&self.norm), cfg.rms_eps)?;
        let gate = silu(&z)?;
        let gated = ops::multiply(&gate, &normed)?;
        trace.normed = Some(normed.clone());
        trace.gated = Some(gated.clone());

        // 8. Output projection.
        let out = ops::reshape(&gated, &[b, s, value_dim])?;
        linear(&out, &self.out_proj)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The helper must stay the *unfused* `x * sigmoid(x)` formula: the
    /// reference's `mx.compile`d `nn.silu` is bit-identical to it on the
    /// reference's MLX build, while MLX's compiled `silu` on the Rust side is
    /// not.
    #[test]
    fn silu_helper_is_the_unfused_formula() {
        let x = mlx_rs::random::normal::<f32>(&[1, 16, 8192], None, None, None).unwrap();
        let helper = silu(&x).unwrap();
        let unfused = ops::multiply(&x, &ops::sigmoid(&x).unwrap()).unwrap();
        helper.eval().unwrap();
        unfused.eval().unwrap();
        assert_eq!(
            helper.to_vec_exact::<f32>().unwrap(),
            unfused.to_vec_exact::<f32>().unwrap()
        );
    }
}
