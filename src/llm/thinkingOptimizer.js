// Thinking Optimizer + Private Parameter Body Filter + Responses Late-Arguments SSE Repair
// (ported from farion1231/cc-switch:
//   - src-tauri/src/proxy/thinking_optimizer.rs
//   - src-tauri/src/proxy/body_filter.rs
//   - src-tauri/src/proxy/providers/responses_late_arguments.rs)
//
// Zero runtime dependencies.

const ADAPTIVE_THINKING_NEEDLES = Object.freeze([
  'fable-5',
  'mythos-5',
  'mythos-preview',
  'sonnet-5',
  'opus-5',
  'opus-4-8',
  'opus-4-7',
  'opus-4-6',
  'sonnet-4-6',
])

const ADAPTIVE_DEFAULT_NEEDLES = Object.freeze([
  'fable-5',
  'mythos-5',
  'mythos-preview',
  'opus-5',
  'sonnet-5',
])

const THINKING_CANNOT_BE_DISABLED_NEEDLES = Object.freeze([
  'fable-5',
  'mythos-5',
])

const SCHEMA_NAME_MAP_KEYS = new Set([
  'properties',
  'patternProperties',
  'definitions',
  '$defs',
])

export function normalizeModelName(model) {
  if (typeof model !== 'string') return ''
  return model.trim().toLowerCase().replace(/[._]/g, '-')
}

export function usesAdaptiveThinking(model) {
  const norm = normalizeModelName(model)
  return ADAPTIVE_THINKING_NEEDLES.some((needle) => norm.includes(needle))
}

export function adaptiveThinkingIsDefault(model) {
  const norm = normalizeModelName(model)
  return ADAPTIVE_DEFAULT_NEEDLES.some((needle) => norm.includes(needle))
}

export function thinkingCannotBeDisabled(model) {
  const norm = normalizeModelName(model)
  return THINKING_CANNOT_BE_DISABLED_NEEDLES.some((needle) => norm.includes(needle))
}

function appendBeta(body, beta) {
  if (!body || typeof body !== 'object') return
  if (Array.isArray(body.anthropic_beta)) {
    if (!body.anthropic_beta.includes(beta)) {
      body.anthropic_beta.push(beta)
    }
    return
  }
  body.anthropic_beta = [beta]
}

/**
 * 3-path thinking optimizer (ported from `thinking_optimizer.rs`):
 * - `skip`: Haiku models are untouched.
 * - `adaptive`: Opus 4.6+, Sonnet 4.6+, Opus/Sonnet/Fable/Mythos 5.x get `thinking: { type: 'adaptive' }`,
 *   `output_config: { effort: 'max' }`, and `context-1m-2025-08-07` beta.
 * - `legacy`: Earlier Claude models get `thinking: { type: 'enabled', budget_tokens: max_tokens - 1 }`
 *   and `interleaved-thinking-2025-05-14` beta.
 */
export function optimizeThinking(body, config = { enabled: true, thinkingOptimizer: true }) {
  if (!config?.enabled || !config?.thinkingOptimizer || !body || typeof body !== 'object') {
    return { applied: false, mode: 'disabled' }
  }
  const model = typeof body.model === 'string' ? body.model.toLowerCase() : ''
  if (!model) return { applied: false, mode: 'no_model' }

  if (model.includes('haiku')) {
    return { applied: false, mode: 'skip_haiku' }
  }

  if (usesAdaptiveThinking(model)) {
    body.thinking = { type: 'adaptive' }
    body.output_config = { effort: 'max' }
    appendBeta(body, 'context-1m-2025-08-07')
    return { applied: true, mode: 'adaptive' }
  }

  const maxTokens = typeof body.max_tokens === 'number' && body.max_tokens > 0 ? body.max_tokens : 16384
  const budgetTarget = Math.max(1024, maxTokens - 1)
  const thinkingType = typeof body.thinking?.type === 'string' ? body.thinking.type : null

  if (!thinkingType || thinkingType === 'disabled') {
    body.thinking = {
      type: 'enabled',
      budget_tokens: budgetTarget,
    }
    appendBeta(body, 'interleaved-thinking-2025-05-14')
    return { applied: true, mode: 'legacy' }
  }

  if (thinkingType === 'enabled') {
    const currentBudget = typeof body.thinking?.budget_tokens === 'number' ? body.thinking.budget_tokens : 0
    if (currentBudget < budgetTarget) {
      body.thinking.budget_tokens = budgetTarget
    }
    appendBeta(body, 'interleaved-thinking-2025-05-14')
    return { applied: true, mode: 'legacy' }
  }

  appendBeta(body, 'interleaved-thinking-2025-05-14')
  return { applied: true, mode: 'legacy_other' }
}

// ============================================================================
// Private Parameter Body Filter (ported from body_filter.rs)
// ============================================================================

/**
 * Recursively strips private `_`-prefixed keys from outgoing JSON request payloads,
 * while preserving whitelisted keys AND user-defined JSON Schema property names inside
 * `properties`, `patternProperties`, `definitions`, and `$defs`.
 */
export function filterPrivateParams(body, whitelist = []) {
  const whitelistSet = new Set(whitelist)
  return filterRecursive(body, [], whitelistSet)
}

function filterRecursive(value, path, whitelistSet) {
  if (Array.isArray(value)) {
    return value.map((item) => filterRecursive(item, path, whitelistSet))
  }
  if (value !== null && typeof value === 'object') {
    const parentKey = path.length > 0 ? path[path.length - 1] : null
    const isSchemaNameMap = parentKey !== null && SCHEMA_NAME_MAP_KEYS.has(parentKey)
    const out = {}
    for (const [key, val] of Object.entries(value)) {
      if (key.startsWith('_') && !whitelistSet.has(key) && !isSchemaNameMap) {
        continue
      }
      path.push(key)
      out[key] = filterRecursive(val, path, whitelistSet)
      path.pop()
    }
    return out
  }
  return value
}

// ============================================================================
// Responses Late-Arguments SSE Repair (ported from responses_late_arguments.rs)
// ============================================================================

function parseSseBlock(raw) {
  let eventName = null
  const dataParts = []
  for (const line of String(raw).split(/\r?\n/)) {
    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim()
    } else if (line.startsWith('data:')) {
      dataParts.push(line.slice(5).trimStart())
    }
  }
  let event = null
  if (dataParts.length > 0) {
    try {
      event = JSON.parse(dataParts.join('\n'))
    } catch {
      event = null
    }
  }
  return { raw: String(raw), eventName, event }
}

function emptyFunctionCallEndId(block) {
  const ev = block.event
  if (!ev || typeof ev !== 'object') return null
  if (ev.type === 'response.function_call_arguments.done') {
    const itemId = typeof ev.item_id === 'string' ? ev.item_id : null
    const args = ev.arguments
    if (itemId && (args == null || args === '')) return itemId
    return null
  }
  if (ev.type === 'response.output_item.done') {
    const item = ev.item
    if (!item || item.type !== 'function_call') return null
    const itemId = typeof item.id === 'string' ? item.id : null
    const args = item.arguments
    if (itemId && (args == null || args === '')) return itemId
  }
  return null
}

function argumentsDeltaInfo(block) {
  const ev = block.event
  if (!ev || ev.type !== 'response.function_call_arguments.delta') return null
  if (typeof ev.item_id === 'string' && typeof ev.delta === 'string') {
    return { itemId: ev.item_id, delta: ev.delta }
  }
  return null
}

function serializeWithArguments(block, args) {
  if (!block.event || typeof block.event !== 'object') return `${block.raw}\n\n`
  const cloned = JSON.parse(JSON.stringify(block.event))
  if (cloned.type === 'response.output_item.done' && cloned.item && typeof cloned.item === 'object') {
    cloned.item.arguments = args
  } else {
    cloned.arguments = args
  }
  let out = ''
  if (block.eventName) {
    out += `event: ${block.eventName}\n`
  }
  out += `data: ${JSON.stringify(cloned)}\n\n`
  return out
}

function completedArgumentsForItem(completedEvent, itemId) {
  const output = completedEvent?.response?.output
  if (!Array.isArray(output)) return null
  const found = output.find((item) => item?.id === itemId)
  if (typeof found?.arguments === 'string' && found.arguments.length > 0) {
    return found.arguments
  }
  return null
}

/**
 * Stateful SSE repair machine for OpenAI Responses streams where upstream gateways
 * (e.g. MiniMax `/v1/responses`) emit `function_call_arguments.done` / `output_item.done`
 * with empty `arguments: ""` BEFORE emitting `function_call_arguments.delta`.
 */
export class LateArgumentsRepair {
  constructor() {
    this.arguments = new Map()
    this.held = []
  }

  push(rawBlock) {
    const block = parseSseBlock(rawBlock)
    const out = []

    const delta = argumentsDeltaInfo(block)
    if (delta) {
      const prev = this.arguments.get(delta.itemId) || ''
      this.arguments.set(delta.itemId, prev + delta.delta)
      out.push(`${block.raw}\n\n`)
      return out
    }

    const emptyEndId = emptyFunctionCallEndId(block)
    if (emptyEndId) {
      this.held.push({ itemId: emptyEndId, block })
      return out
    }

    const completed = block.event?.type === 'response.completed' ? block.event : null
    out.push(...this.flush(completed))
    out.push(`${block.raw}\n\n`)
    return out
  }

  flush(completedEvent = null) {
    const held = this.held
    this.held = []
    return held.map(({ itemId, block }) => {
      const acc = this.arguments.get(itemId)
      const resolved = (acc && acc.length > 0 ? acc : null) ||
        (completedEvent ? completedArgumentsForItem(completedEvent, itemId) : null)
      if (resolved) {
        return serializeWithArguments(block, resolved)
      }
      return `${block.raw}\n\n`
    })
  }
}
