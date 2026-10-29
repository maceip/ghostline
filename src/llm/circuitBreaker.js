// Per-provider circuit breaker & health registry (ported from farion1231/cc-switch circuit_breaker.rs).
// Pure ESM, zero runtime dependencies, deterministic injectable clock (`nowFn`) for unit testing.
//
// States:
// - 'closed'    : normal operation; requests pass through.
// - 'open'      : tripped after consecutive failures or high error rate; fast-fails until cooldown expires.
// - 'half_open' : cooldown expired; allows a bounded number of probe requests (`maxHalfOpenRequests`, default 1)
//                 before transitioning back to 'closed' (after `successThreshold` successes) or re-opening on failure.

export const CIRCUIT_STATES = Object.freeze({
  CLOSED: 'closed',
  OPEN: 'open',
  HALF_OPEN: 'half_open',
})

export const DEFAULT_CIRCUIT_BREAKER_CONFIG = Object.freeze({
  failureThreshold: 4,
  successThreshold: 2,
  timeoutSeconds: 60,
  errorRateThreshold: 0.6,
  minRequests: 10,
  maxHalfOpenRequests: 1,
})

export class CircuitBreaker {
  constructor(config = {}, nowFn = () => Date.now()) {
    this.nowFn = nowFn
    this.config = { ...DEFAULT_CIRCUIT_BREAKER_CONFIG, ...config }
    this.state = CIRCUIT_STATES.CLOSED
    this.consecutiveFailures = 0
    this.consecutiveSuccesses = 0
    this.totalRequests = 0
    this.failedRequests = 0
    this.lastOpenedAt = null
    this.lastError = null
    this.halfOpenRequests = 0
    this.listeners = new Set()
  }

  onChange(fn) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  _emit() {
    const snap = this.getStats()
    for (const fn of this.listeners) {
      try { fn(snap) } catch { /* ignore listener error */ }
    }
  }

  updateConfig(newConfig = {}) {
    this.config = { ...this.config, ...newConfig }
  }

  /**
   * Routing-time availability check (does NOT consume a HalfOpen probe permit).
   * - Closed / HalfOpen -> true
   * - Open -> transitions to HalfOpen and returns true if timeoutSeconds has elapsed; otherwise false.
   */
  isAvailable() {
    if (this.state === CIRCUIT_STATES.CLOSED || this.state === CIRCUIT_STATES.HALF_OPEN) {
      return true
    }
    if (this.state === CIRCUIT_STATES.OPEN && this.lastOpenedAt !== null) {
      const elapsedSeconds = (this.nowFn() - this.lastOpenedAt) / 1000
      if (elapsedSeconds >= this.config.timeoutSeconds) {
        this._transitionToHalfOpen()
        return true
      }
    }
    return false
  }

  /**
   * Acquire execution permission before dispatching a request.
   * Returns `{ allowed: boolean, usedHalfOpenPermit: boolean, state: string }`.
   * If `usedHalfOpenPermit` is true, the caller MUST pass it back to `recordSuccess` / `recordFailure` / `releaseHalfOpenPermit`.
   */
  allowRequest() {
    if (this.state === CIRCUIT_STATES.CLOSED) {
      return { allowed: true, usedHalfOpenPermit: false, state: this.state }
    }
    if (this.state === CIRCUIT_STATES.OPEN) {
      if (this.lastOpenedAt !== null) {
        const elapsedSeconds = (this.nowFn() - this.lastOpenedAt) / 1000
        if (elapsedSeconds >= this.config.timeoutSeconds) {
          this._transitionToHalfOpen()
          return this._allowHalfOpenProbe()
        }
      }
      return { allowed: false, usedHalfOpenPermit: false, state: this.state }
    }
    return this._allowHalfOpenProbe()
  }

  _allowHalfOpenProbe() {
    const maxProbes = this.config.maxHalfOpenRequests ?? 1
    if (this.halfOpenRequests < maxProbes) {
      this.halfOpenRequests += 1
      return { allowed: true, usedHalfOpenPermit: true, state: this.state }
    }
    return { allowed: false, usedHalfOpenPermit: false, state: this.state }
  }

  /**
   * Release a HalfOpen permit without recording a provider health outcome
   * (used when a request is rectified/retried or cancelled locally).
   */
  releaseHalfOpenPermit() {
    if (this.halfOpenRequests > 0) {
      this.halfOpenRequests -= 1
    }
  }

  recordSuccess(usedHalfOpenPermit = false) {
    if (usedHalfOpenPermit) {
      this.releaseHalfOpenPermit()
    }
    this.consecutiveFailures = 0
    this.totalRequests += 1
    this.lastError = null

    if (this.state === CIRCUIT_STATES.HALF_OPEN) {
      this.consecutiveSuccesses += 1
      if (this.consecutiveSuccesses >= this.config.successThreshold) {
        this._transitionToClosed()
        return
      }
    }
    this._emit()
  }

  recordFailure(usedHalfOpenPermit = false, errorMsg = null) {
    if (usedHalfOpenPermit) {
      this.releaseHalfOpenPermit()
    }
    this.consecutiveFailures += 1
    this.totalRequests += 1
    this.failedRequests += 1
    this.consecutiveSuccesses = 0
    if (errorMsg) this.lastError = String(errorMsg)

    if (this.state === CIRCUIT_STATES.HALF_OPEN) {
      this._transitionToOpen()
      return
    }

    if (this.state === CIRCUIT_STATES.CLOSED) {
      if (this.consecutiveFailures >= this.config.failureThreshold) {
        this._transitionToOpen()
        return
      }
      if (this.totalRequests >= this.config.minRequests) {
        const errorRate = this.failedRequests / this.totalRequests
        if (errorRate >= this.config.errorRateThreshold) {
          this._transitionToOpen()
          return
        }
      }
    }
    this._emit()
  }

  reset() {
    this.lastError = null
    this._transitionToClosed()
  }

  _transitionToOpen() {
    this.state = CIRCUIT_STATES.OPEN
    this.lastOpenedAt = this.nowFn()
    this.consecutiveFailures = 0
    this.consecutiveSuccesses = 0
    this._emit()
  }

  _transitionToHalfOpen() {
    if (this.state !== CIRCUIT_STATES.OPEN) return
    this.state = CIRCUIT_STATES.HALF_OPEN
    this.consecutiveSuccesses = 0
    this.halfOpenRequests = 0
    this._emit()
  }

  _transitionToClosed() {
    this.state = CIRCUIT_STATES.CLOSED
    this.consecutiveFailures = 0
    this.consecutiveSuccesses = 0
    this.totalRequests = 0
    this.failedRequests = 0
    this.halfOpenRequests = 0
    this.lastOpenedAt = null
    this._emit()
  }

  getState() {
    // Auto-advance Open -> HalfOpen if cooldown elapsed so UI telemetry reflects live readiness
    if (this.state === CIRCUIT_STATES.OPEN && this.lastOpenedAt !== null) {
      const elapsedSeconds = (this.nowFn() - this.lastOpenedAt) / 1000
      if (elapsedSeconds >= this.config.timeoutSeconds) {
        this.state = CIRCUIT_STATES.HALF_OPEN
        this.consecutiveSuccesses = 0
        this.halfOpenRequests = 0
      }
    }
    return this.state
  }

  getStats() {
    const state = this.getState()
    const cooldownRemainingMs = state === CIRCUIT_STATES.OPEN && this.lastOpenedAt !== null
      ? Math.max(0, this.config.timeoutSeconds * 1000 - (this.nowFn() - this.lastOpenedAt))
      : 0
    return {
      state,
      consecutiveFailures: this.consecutiveFailures,
      consecutiveSuccesses: this.consecutiveSuccesses,
      totalRequests: this.totalRequests,
      failedRequests: this.failedRequests,
      halfOpenRequests: this.halfOpenRequests,
      lastOpenedAt: this.lastOpenedAt,
      cooldownRemainingMs,
      lastError: this.lastError,
    }
  }
}

/**
 * Multi-provider CircuitBreakerRegistry (ported from farion1231/cc-switch ProviderRouter).
 * Manages keyed circuit breakers (`bridge`, `remote`, `local`, or `app:providerId`) and emits
 * live snapshots when any leg transitions state.
 */
export class CircuitBreakerRegistry {
  constructor(defaultConfig = {}, nowFn = () => Date.now()) {
    this.defaultConfig = { ...DEFAULT_CIRCUIT_BREAKER_CONFIG, ...defaultConfig }
    this.nowFn = nowFn
    this.breakers = new Map()
    this.listeners = new Set()
  }

  get(key) {
    let b = this.breakers.get(key)
    if (!b) {
      b = new CircuitBreaker(this.defaultConfig, this.nowFn)
      b.onChange(() => this._emit())
      this.breakers.set(key, b)
    }
    return b
  }

  isAvailable(key) {
    return this.get(key).isAvailable()
  }

  allowRequest(key) {
    return this.get(key).allowRequest()
  }

  recordResult(key, { usedHalfOpenPermit = false, success, errorMsg = null }) {
    const b = this.get(key)
    if (success) b.recordSuccess(usedHalfOpenPermit)
    else b.recordFailure(usedHalfOpenPermit, errorMsg)
  }

  reset(key) {
    if (key) {
      this.get(key).reset()
    } else {
      for (const b of this.breakers.values()) b.reset()
    }
    this._emit()
  }

  updateConfig(newConfig = {}) {
    this.defaultConfig = { ...this.defaultConfig, ...newConfig }
    for (const b of this.breakers.values()) b.updateConfig(this.defaultConfig)
    this._emit()
  }

  snapshot(keys = ['bridge', 'remote', 'local']) {
    const out = {}
    const allKeys = new Set([...keys, ...this.breakers.keys()])
    for (const k of allKeys) {
      out[k] = this.get(k).getStats()
    }
    return out
  }

  onChange(fn) {
    this.listeners.add(fn)
    fn(this.snapshot())
    return () => this.listeners.delete(fn)
  }

  _emit() {
    const snap = this.snapshot()
    for (const fn of this.listeners) {
      try { fn(snap) } catch { /* listener error */ }
    }
  }
}

export const defaultCircuitRegistry = new CircuitBreakerRegistry()
