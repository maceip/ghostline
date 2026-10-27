// Engine routing, kept pure: runners are injected so this is unit-testable in node
// with fakes (tests/router.test.mjs). The browser runners live in engines.js.
//
// Chain (mode 'auto'): native bridge (if configured + healthy) -> remote provider
// (if an API key is set) -> LiteRT-LM local. A remote error never surfaces raw when
// a local model can answer: the local pass is told what failed and must both help
// diagnose/fix the configuration AND still answer the user's prompt as best it can.
// 'demo' is explicit-only: auto never silently fakes an answer.
import { remoteConfigured, bridgeConfigured } from './config.js'

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

export async function runTurn({ config, prompt, history = [], runners, hooks = {} }) {
  const { onEngine } = hooks
  const call = async (name, extra = {}) => {
    onEngine?.(name)
    const r = await runners[name]({ system: SYSTEM_PROMPT, history, prompt, ...extra }, hooks)
    if (!r || typeof r.text !== 'string' || !r.text.trim()) throw new Error(`${name} returned an empty response`)
    return { text: r.text, engine: name, label: labelOf(r, name), ...(extra.diagnoseError ? { fallbackFrom: extra.diagnoseError } : {}) }
  }

  if (config.mode === 'demo') return call('demo')
  if (config.mode === 'local') return call('local')
  if (config.mode === 'remote') {
    if (bridgeConfigured(config)) return call('bridge')
    return call('remote')
  }

  // auto
  const errors = []
  if (bridgeConfigured(config)) {
    try { return await call('bridge') } catch (e) { errors.push(`bridge: ${e.message || e}`) }
  }
  if (remoteConfigured(config)) {
    try { return await call('remote') } catch (e) {
      const msg = String(e.message || e)
      errors.push(`remote: ${msg}`)
      try { return await call('local', { diagnoseError: msg }) } catch (e2) { errors.push(`local: ${e2.message || e2}`) }
      throw new Error(`all engines failed — ${errors.join(' · ')}`)
    }
  }
  try { return await call('local') } catch (e) { errors.push(`local: ${e.message || e}`) }
  throw new Error(`no engine available — ${errors.join(' · ') || 'configure an API key, a bridge, or a local model in settings'}`)
}

export function diagnosisPrompt(prompt, error) {
  return [
    `The user's configured remote AI provider just failed with this error: ${error}`,
    `First, in one or two short lines, tell the user the most likely cause and the exact fix (check the API key, model name, base URL, quota, or network — whichever fits the error).`,
    `Then answer their actual request as best you can. Their request was: ${prompt}`,
  ].join('\n')
}
