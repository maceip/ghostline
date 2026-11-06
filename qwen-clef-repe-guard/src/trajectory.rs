//! Cross-turn trajectory accumulation over the harm-cluster excess vector.
//!
//! A single tool call is a weak signal on its own. A *sequence* of calls is
//! not: an agent that escalates — one probing command after another, each a
//! little further towards the destructive one — looks benign at every
//! individual step and dangerous in aggregate.
//!
//! This module accumulates the per-cluster excess vector across the turns of
//! a session:
//!
//! ```text
//! e_c(t) = cluster_score_c(t) - baseline(t)
//! E_c(t) = lambda * E_c(t-1) + (1 - lambda) * e_c(t)
//! ```
//!
//! and reports the slope of `E_c` over the recent history, which is the
//! signal that separates "one bad call" from "a trend".

use std::collections::VecDeque;

/// The default EMA factor: 70% of the previous state, 30% of the new turn.
pub const DEFAULT_LAMBDA: f32 = 0.7;

/// How many recent turns the slope is fitted over.
pub const HISTORY_WINDOW: usize = 32;

/// How many turns must have been observed before the trajectory may block.
pub const MIN_TURNS: usize = 3;

/// The accumulated per-cluster excess over the turns of a session.
#[derive(Debug, Clone)]
pub struct ExcessTrajectory {
    /// The EMA of each cluster's excess.
    pub ema: Vec<f32>,
    /// The recent per-turn excess vectors, oldest first.
    pub history: VecDeque<Vec<f32>>,
    /// The EMA factor.
    pub lambda: f32,
    /// How many turns have been accumulated in total.
    pub turns: usize,
}

impl Default for ExcessTrajectory {
    fn default() -> Self {
        Self {
            ema: Vec::new(),
            history: VecDeque::new(),
            lambda: DEFAULT_LAMBDA,
            turns: 0,
        }
    }
}

impl ExcessTrajectory {
    /// A trajectory with a different EMA factor.
    pub fn with_lambda(lambda: f32) -> Self {
        Self {
            lambda: lambda.clamp(0.0, 0.999),
            ..Self::default()
        }
    }

    /// Accumulate one turn's per-cluster excess vector.
    ///
    /// The first turn seeds the EMA directly — there is no history to smooth
    /// against, and seeding avoids a fresh session looking artificially calm
    /// for its first call.
    pub fn update(&mut self, excess: &[f32]) {
        if excess.is_empty() {
            return;
        }
        if self.ema.len() != excess.len() {
            self.ema = excess.to_vec();
            self.history.clear();
        } else if self.turns == 0 {
            self.ema = excess.to_vec();
        } else {
            for (slot, value) in self.ema.iter_mut().zip(excess.iter()) {
                *slot = self.lambda * *slot + (1.0 - self.lambda) * *value;
            }
        }
        self.history.push_back(excess.to_vec());
        while self.history.len() > HISTORY_WINDOW {
            self.history.pop_front();
        }
        self.turns += 1;
    }

    /// The least-squares slope of each cluster's excess over the history.
    ///
    /// A positive slope means the agent's calls are drifting towards that
    /// cluster. The slope is per TURN, not per call.
    pub fn slopes(&self) -> Vec<f32> {
        let n = self.history.len();
        if n < 2 {
            return vec![0.0; self.ema.len()];
        }
        let clusters = self.ema.len();
        let mut out = vec![0.0f32; clusters];
        // x = 0, 1, ... n-1, centred.
        let mean_x = (n as f32 - 1.0) / 2.0;
        let var_x: f32 = (0..n).map(|i| (i as f32 - mean_x).powi(2)).sum();
        if var_x <= 0.0 {
            return out;
        }
        for c in 0..clusters {
            let mut num = 0.0f32;
            let mut mean_y = 0.0f32;
            for row in self.history.iter() {
                mean_y += row.get(c).copied().unwrap_or(0.0);
            }
            mean_y /= n as f32;
            for (i, row) in self.history.iter().enumerate() {
                let y = row.get(c).copied().unwrap_or(0.0);
                num += (i as f32 - mean_x) * (y - mean_y);
            }
            out[c] = num / var_x;
        }
        out
    }

    /// The EMA of each cluster.
    pub fn ema(&self) -> &[f32] {
        &self.ema
    }

    /// How many turns have been accumulated.
    pub fn turns(&self) -> usize {
        self.turns
    }

    /// Whether the trajectory may be used as a blocking signal.
    ///
    /// A trend needs enough history to be a trend: one turn is a call, three
    /// is a direction.
    pub fn is_trend(&self) -> bool {
        self.turns >= MIN_TURNS && self.history.len() >= 2
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_turn_seeds_the_ema() {
        let mut t = ExcessTrajectory::default();
        t.update(&[0.5, 0.0, 0.0]);
        assert_eq!(t.ema(), &[0.5, 0.0, 0.0]);
        assert_eq!(t.turns(), 1);
        assert!(!t.is_trend());
    }

    #[test]
    fn ema_follows_the_lambda() {
        let mut t = ExcessTrajectory::with_lambda(0.5);
        t.update(&[1.0]);
        t.update(&[0.0]);
        // 0.5 * 1.0 + 0.5 * 0.0
        assert!((t.ema()[0] - 0.5).abs() < 1e-6);
    }

    #[test]
    fn slope_is_positive_for_a_rising_series() {
        let mut t = ExcessTrajectory::default();
        for v in [0.0f32, 0.1, 0.2, 0.3] {
            t.update(&[v]);
        }
        let s = t.slopes();
        assert!(s[0] > 0.09, "slope was {}", s[0]);
        assert!(t.is_trend());
    }

    #[test]
    fn slope_is_zero_for_a_flat_series() {
        let mut t = ExcessTrajectory::default();
        for _ in 0..4 {
            t.update(&[0.25]);
        }
        assert!(t.slopes()[0].abs() < 1e-6);
    }
}
