// Engine routing, kept pure: runners are injected so this is unit-testable in node
// with fakes (tests/router.test.mjs). The browser runners live in engines.js.
//
// Chain (mode 'auto'): native bridge (if configured + circuit closed/half-open) ->
// remote provider (if an API key is set + circuit closed/half-open) -> LiteRT-LM local.
// A remote error never surfaces raw when a local model can answer: the local pass is told
// what failed and must both help diagnose/fix the configuration AND still answer the user's
// prompt as best it can.
// 'demo' is explicit-only: auto never silently fakes an answer.
//
// Integrated with CC Switch's `CircuitBreakerRegistry` (`./circuitBreaker.js`):
// - Tracks per-leg health (`bridge`, `remote`, `local`) across turns.
// - Skips legs whose circuit is `open` (cooldown not yet elapsed), routing straight to the
//   healthy fallback without waiting for a dead upstream timeout on every turn.
import { remoteConfigured, bridgeConfigured } from './config.js'
import { CircuitBreakerRegistry, defaultCircuitRegistry } from './circuitBreaker.js'

export const SYSTEM_PROMPT = [
  'You are the coding agent inside zune code, a Metro-style agentic coding desktop.',
  'Answer concisely and concretely. When workspace tools are available, use them to ground claims about files and pending diffs instead of guessing.',
  'Never invent file contents you have not read. If you cannot do something from the webview (write files, run shell), say so plainly and give the exact change instead.',
].join(' ')

export function historyFromTurns(turns) {
  const out = []
  for (const t of turns || []) {
    const text = (t.actor === 'user' ? t.full || t.intent : t.synthesis || t.full || '').trim()
    if (!text) continue
    out.push({ role: t.actor === 'user' ? 'user' : 'assistant', content: text })
  }
  return out.slice(-24)
}

const labelOf = (r, fallback) => r?.label || fallback

/**
 * Factory for creating a standalone, project-agnostic LLM router instance with its own
 * isolated `CircuitBreakerRegistry` and optional custom system prompt.
 */
export function createLLMRouter({
  circuitConfig = {},
  systemPrompt = SYSTEM_PROMPT,
  nowFn = () => Date.now(),
} = {}) {
  const registry = new CircuitBreakerRegistry(circuitConfig, nowFn)
  return {
    registry,
    runTurn: (opts) => runTurn({ systemPrompt, circuitRegistry: registry, ...opts }),
    getCircuitStats: () => registry.snapshot(),
    resetCircuits: (key) => registry.reset(key),
    onCircuitChange: (fn) => registry.onChange(fn),
  }
}

export async function runTurn({
  config,
  prompt,
  history = [],
  runners,
  hooks = {},
  role = null,
  systemPrompt = SYSTEM_PROMPT,
  circuitRegistry = null,
}) {
  const { onEngine, onCircuit } = hooks
  const cbConfig = config?.circuitBreaker
  const useBreaker = Boolean(circuitRegistry) || Boolean(cbConfig && cbConfig.enabled)
  const registry = circuitRegistry || (useBreaker ? defaultCircuitRegistry : null)
  if (registry && cbConfig && typeof cbConfig === 'object') {
    const { enabled: _e, ...rest } = cbConfig
    if (Object.keys(rest).length > 0) registry.updateConfig(rest)
  }

  const call = async (name, extra = {}) => {
    let permit = { allowed: true, usedHalfOpenPermit: false }
    if (registry) {
      permit = registry.allowRequest(name)
      if (!permit.allowed) {
        const stats = registry.get(name).getStats()
        const sec = Math.ceil((stats.cooldownRemainingMs || 0) / 1000)
        throw new Error(`${name} circuit open (${sec}s cooldown remaining${stats.lastError ? ` · last: ${stats.lastError}` : ''})`)
      }
    }
    onEngine?.(name)
    try {
      const r = await runners[name]({ system: systemPrompt, history, prompt, role, ...extra }, hooks)
      if (!r || typeof r.text !== 'string' || !r.text.trim()) {
        throw new Error(`${name} returned an empty response`)
      }
      if (registry) {
        registry.recordResult(name, { usedHalfOpenPermit: permit.usedHalfOpenPermit, success: true })
        onCircuit?.(registry.snapshot())
      }
      return {
        text: r.text,
        engine: name,
        label: labelOf(r, name),
        ...(r.thinking ? { thinking: r.thinking } : {}),
        ...(extra.diagnoseError ? { fallbackFrom: extra.diagnoseError } : {}),
      }
    } catch (e) {
      if (registry) {
        registry.recordResult(name, {
          usedHalfOpenPermit: permit.usedHalfOpenPermit,
          success: false,
          errorMsg: String(e?.message || e),
        })
        onCircuit?.(registry.snapshot())
      }
      throw e
    }
  }

  if (config.mode === 'demo') return call('demo')
  if (config.mode === 'local') return call('local')
  if (config.mode === 'remote') {
    if (bridgeConfigured(config)) return call('bridge')
    return call('remote')
  }

  // auto mode: ordered failover queue (bridge -> remote -> local) with circuit breaker filtering
  const errors = []
  if (bridgeConfigured(config)) {
    try {
      return await call('bridge')
    } catch (e) {
      errors.push(`bridge: ${e.message || e}`)
    }
  }
  if (remoteConfigured(config)) {
    try {
      return await call('remote')
    } catch (e) {
      const msg = String(e.message || e)
      errors.push(`remote: ${msg}`)
      try {
        return await call('local', { diagnoseError: msg })
      } catch (e2) {
        errors.push(`local: ${e2.message || e2}`)
      }
      throw new Error(`all engines failed — ${errors.join(' · ')}`)
    }
  }
  try {
    return await call('local')
  } catch (e) {
    errors.push(`local: ${e.message || e}`)
  }
  throw new Error(
    `no engine available — ${errors.join(' · ') || 'configure an API key, a bridge, or a local model in settings'}`
  )
}

export function diagnosisPrompt(prompt, error) {
  return [
    `The user's configured remote AI provider just failed with this error: ${error}`,
    `First, in one or two short lines, tell the user the most likely cause and the exact fix (check the API key, model name, base URL, quota, or network — whichever fits the error).`,
    `Then answer their actual request as best you can. Their request was: ${prompt}`,
  ].join('\n')
}
