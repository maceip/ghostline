// Prompt Cache Breakpoint Injector (ported from farion1231/cc-switch src-tauri/src/proxy/cache_injector.rs).
//
// Automatically injects up to 4 `cache_control: { type: 'ephemeral' }` breakpoints into Anthropic/Bedrock
// request payloads or Pi context objects without exceeding the 4-breakpoint cap:
//   (a) End of `tools` array
//   (b) End of `system` prompt
//   (c) Last non-thinking block of the newest message (`msgs-latest`, including `tool_result` turns)
//   (d) Second-most-recent `user` message anchor (`msgs-prior-user`, when messages.length >= 4) so long
//       tool-result loops stay within Anthropic's 20-block lookback window.

export const DEFAULT_OPTIMIZER_CONFIG = Object.freeze({
  enabled: true,
  thinkingOptimizer: true,
  cacheInjection: true,
})

function makeCacheControl() {
  return { type: 'ephemeral' }
}

export function countExistingCacheBreakpoints(body) {
  if (!body || typeof body !== 'object') return 0
  let count = 0

  if (Array.isArray(body.tools)) {
    count += body.tools.filter((t) => t && typeof t === 'object' && t.cache_control != null).length
  }

  if (Array.isArray(body.system)) {
    count += body.system.filter((b) => b && typeof b === 'object' && b.cache_control != null).length
  }

  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (Array.isArray(msg?.content)) {
        count += msg.content.filter((b) => b && typeof b === 'object' && b.cache_control != null).length
      }
    }
  }

  return count
}

function injectMessageBreakpoint(message) {
  if (!message || typeof message !== 'object') return false
  if (typeof message.content === 'string' && message.content.length > 0) {
    message.content = [{ type: 'text', text: message.content }]
  }
  if (!Array.isArray(message.content)) return false

  for (let i = message.content.length - 1; i >= 0; i--) {
    const block = message.content[i]
    if (!block || typeof block !== 'object') continue
    if (block.type === 'thinking' || block.type === 'redacted_thinking') continue
    if (block.cache_control != null) return false
    block.cache_control = makeCacheControl()
    return true
  }
  return false
}

/**
 * Inject up to `4 - existing` `cache_control: { type: 'ephemeral' }` markers into an Anthropic
 * request body in place. Preserves caller-owned breakpoints (including custom `ttl`).
 */
export function injectCacheBreakpoints(body, config = DEFAULT_OPTIMIZER_CONFIG) {
  const cfg = { ...DEFAULT_OPTIMIZER_CONFIG, ...config }
  if (!cfg.enabled || !cfg.cacheInjection || !body || typeof body !== 'object') {
    return { injected: [], existing: 0 }
  }

  const existing = countExistingCacheBreakpoints(body)
  let budget = Math.max(0, 4 - existing)
  if (budget === 0) {
    return { injected: [], existing }
  }

  const injected = []

  // (a) tools tail
  if (budget > 0 && Array.isArray(body.tools) && body.tools.length > 0) {
    const lastTool = body.tools[body.tools.length - 1]
    if (lastTool && typeof lastTool === 'object' && lastTool.cache_control == null) {
      lastTool.cache_control = makeCacheControl()
      budget -= 1
      injected.push('tools')
    }
  }

  // (b) system tail (convert string system prompt to 1-element text block array)
  if (budget > 0) {
    if (typeof body.system === 'string' && body.system.length > 0) {
      body.system = [{ type: 'text', text: body.system }]
    }
    if (Array.isArray(body.system) && body.system.length > 0) {
      const lastSys = body.system[body.system.length - 1]
      if (lastSys && typeof lastSys === 'object' && lastSys.cache_control == null) {
        lastSys.cache_control = makeCacheControl()
        budget -= 1
        injected.push('system')
      }
    }
  }

  // (c) newest message's last non-thinking block
  if (budget > 0 && Array.isArray(body.messages)) {
    for (let i = body.messages.length - 1; i >= 0; i--) {
      if (injectMessageBreakpoint(body.messages[i])) {
        budget -= 1
        injected.push('msgs-latest')
        break
      }
    }

    // (d) second-most-recent user message anchor when history >= 4
    if (budget > 0 && body.messages.length >= 4) {
      let userCount = 0
      for (let i = body.messages.length - 1; i >= 0; i--) {
        const msg = body.messages[i]
        if (msg?.role !== 'user') continue
        userCount += 1
        if (userCount === 2) {
          if (injectMessageBreakpoint(msg)) {
            budget -= 1
            injected.push('msgs-prior-user')
          }
          break
        }
      }
    }
  }

  return { injected, existing }
}
