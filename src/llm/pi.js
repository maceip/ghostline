// pi (@mariozechner/pi-agent-core + pi-ai) is the off-the-shelf agent loop:
// tool calling, session/transcript state, provider streaming. It is loaded lazily
// (dynamic import) so the shell never pays for it until the first real turn.
// Remote providers use pi-ai's own Anthropic / OpenAI-completions stream functions;
// LiteRT-LM is adapted into the same loop as a custom pi StreamFn, so local and
// remote share tools, history shaping, and event handling.
//
// Integrated with CC Switch modules:
// - `InlineThinkSplitter` + `splitLeadingThinkBlock` (`./inlineThink.js`): splits leading `<think>` / `<thinking>`
//   blocks from local and OpenAI-compatible streams into structured reasoning traces.
// - `shouldRectifyThinkingSignature` + `rectifyPiMessages` + `shouldRectifyThinkingBudget` (`./rectifier.js`):
//   automatically rectifies cross-provider thinking signature / budget errors and retries transparently.
// - `ModelMapping` + `lookupPiModelCapabilities` + `stripOneMSuffix` (`./modelMapper.js`): resolves model
//   aliases (`haiku`, `sonnet`, `opus`, `fable`, `subagent`), capabilities, and `thinkingLevelMap`.
// - `injectCacheBreakpoints` (`./cacheInjector.js`): wraps Anthropic payload construction with 4-BP ephemeral caching.

import { localStream } from './litert.js'
import { InlineThinkSplitter, splitLeadingThinkBlock } from './inlineThink.js'
import {
  shouldRectifyThinkingSignature,
  shouldRectifyThinkingBudget,
  rectifyPiMessages,
  rectifyAnthropicRequest,
  rectifyThinkingBudget,
} from './rectifier.js'
import { ModelMapping, lookupPiModelCapabilities, stripOneMSuffix } from './modelMapper.js'
import { injectCacheBreakpoints } from './cacheInjector.js'

let piPromise = null
export function loadPi() {
  piPromise ??= (async () => {
    const [core, ai] = await Promise.all([
      import('@mariozechner/pi-agent-core'),
      import('@mariozechner/pi-ai'),
    ])
    return {
      Agent: core.Agent,
      createAssistantMessageEventStream: ai.createAssistantMessageEventStream,
    }
  })()
  return piPromise
}

/* The provider SDKs are the one part of the pi graph the app does not always need:
   the Anthropic module is ~104 KB and the OpenAI-compatible module ~124 KB of
   parsed JS, and exactly one of them is ever used. They are loaded per provider
   and memoised, so switching providers in settings fetches the other one on
   demand instead of paying for both on every first turn. */
const providerPromises = new Map()
export function loadPiProvider(provider) {
  const key = provider === 'openai' ? 'openai' : 'anthropic'
  let p = providerPromises.get(key)
  if (!p) {
    p = key === 'openai'
      ? import('@mariozechner/pi-ai/openai-completions').then((m) => m.streamSimpleOpenAICompletions)
      : import('@mariozechner/pi-ai/anthropic').then((m) => m.streamSimpleAnthropic)
    providerPromises.set(key, p)
  }
  return p
}

/* Warm the engine graph while the user is still reading the shell: the first
   turn then starts streaming instead of downloading and parsing ~1 MB of JS.
   Fire-and-forget; a failure here is harmless because send() loads on demand. */
export function warmPi(config) {
  const warm = () => {
    loadPi().catch(() => {})
    loadPiProvider(config.provider).catch(() => {})
  }
  if (typeof requestIdleCallback === 'function') {
    const id = requestIdleCallback(warm, { timeout: 5000 })
    return () => cancelIdleCallback?.(id)
  }
  const t = setTimeout(warm, 1500)
  return () => clearTimeout(t)
}

const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }

export function resolveConfiguredModelId(config, role = null) {
  const raw = config.provider === 'openai' ? config.openaiModel : config.model
  const mapper = new ModelMapping(config.modelMapping || {})
  const mapped = mapper.hasMapping() ? mapper.mapModel(raw, role) : raw
  return stripOneMSuffix(mapped || raw || '')
}

export function remoteModel(config, role = null) {
  const modelId = resolveConfiguredModelId(config, role)
  const cap = lookupPiModelCapabilities(modelId)

  if (config.provider === 'openai') {
    return {
      id: modelId,
      name: cap?.name || modelId,
      api: 'openai-completions',
      provider: 'openai',
      baseUrl: config.baseUrl || 'https://api.openai.com/v1',
      reasoning: cap?.reasoning ?? false,
      input: cap?.input || ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: cap?.contextWindow || 128000,
      maxTokens: cap?.maxTokens || 4096,
      ...(cap?.thinkingLevelMap ? { thinkingLevelMap: cap.thinkingLevelMap } : {}),
      ...(cap?.compat ? { compat: cap.compat } : {}),
    }
  }
  return {
    id: modelId,
    name: cap?.name || modelId,
    api: 'anthropic-messages',
    provider: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    reasoning: cap?.reasoning ?? false,
    input: cap?.input || ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: cap?.contextWindow || 200000,
    maxTokens: cap?.maxTokens || 4096,
    headers: { 'anthropic-dangerous-direct-browser-access': 'true' },
    ...(cap?.thinkingLevelMap ? { thinkingLevelMap: cap.thinkingLevelMap } : {}),
    ...(cap?.compat ? { compat: cap.compat } : {}),
  }
}

export function localModel() {
  return {
    id: 'litert-lm', name: 'LiteRT-LM (local)', api: 'litert-lm', provider: 'litert-lm',
    baseUrl: '', reasoning: false, input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024,
  }
}

/**
 * Wrap any underlying Pi `streamFn` with CC Switch's `onPayload` optimizer & rectifier hook
 * so Anthropic requests get automatic 4-breakpoint prompt cache injection and optional
 * thinking signature / budget rectification.
 */
export async function remoteStreamFn(config, { rectifySignature = false, rectifyBudget = false } = {}) {
  const baseStreamFn = await loadPiProvider(config.provider)
  const optimizerCfg = { enabled: true, cacheInjection: true, ...(config.optimizer || {}) }
  return (model, context, options = {}) => {
    const prevOnPayload = options.onPayload
    return baseStreamFn(model, context, {
      ...options,
      onPayload: async (payload, m) => {
        let next = payload
        if (prevOnPayload) {
          const r = await prevOnPayload(next, m)
          if (r !== undefined) next = r
        }
        if (next && typeof next === 'object' && m?.api === 'anthropic-messages') {
          if (rectifySignature) rectifyAnthropicRequest(next)
          if (rectifyBudget) rectifyThinkingBudget(next)
          if (optimizerCfg.enabled && optimizerCfg.cacheInjection) {
            injectCacheBreakpoints(next, optimizerCfg)
          }
        }
        return next
      },
    })
  }
}

/** LiteRT-LM as a pi StreamFn with CC Switch's streaming `InlineThinkSplitter`. */
export async function litertStreamFn(config) {
  const pi = await loadPi()
  const useInlineThink = config.rectifier?.inlineThink !== false
  return (model, context) => {
    const stream = pi.createAssistantMessageEventStream()
    const msg = {
      role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: zeroCost },
      stopReason: 'stop', timestamp: Date.now(),
    }
    ;(async () => {
      stream.push({ type: 'start', partial: msg })
      stream.push({ type: 'text_start', contentIndex: 0, partial: msg })
      try {
        const messages = (context.messages || []).flatMap((m) => {
          if (m.role === 'user') return [{ role: 'user', content: typeof m.content === 'string' ? m.content : m.content.filter((p) => p.type === 'text').map((p) => p.text).join('') }]
          if (m.role === 'assistant') return [{ role: 'assistant', content: m.content.filter((p) => p.type === 'text').map((p) => p.text).join('') }]
          if (m.role === 'toolResult') return [{ role: 'user', content: `[tool ${m.toolName} result]\n${m.content.filter((p) => p.type === 'text').map((p) => p.text).join('')}` }]
          return []
        })
        const splitter = useInlineThink ? new InlineThinkSplitter() : null
        let acc = ''
        let thinkingAcc = ''
        for await (const delta of localStream(config.localModelUrl, context.systemPrompt || '', messages)) {
          if (splitter) {
            const { thinking, text } = splitter.push(delta)
            if (thinking) {
              thinkingAcc += thinking
              msg.thinking = thinkingAcc
            }
            if (text) {
              acc += text
              msg.content = [
                ...(thinkingAcc ? [{ type: 'thinking', thinking: thinkingAcc }] : []),
                { type: 'text', text: acc },
              ]
              stream.push({ type: 'text_delta', contentIndex: 0, delta: text, partial: msg })
            }
          } else {
            acc += delta
            msg.content = [{ type: 'text', text: acc }]
            stream.push({ type: 'text_delta', contentIndex: 0, delta, partial: msg })
          }
        }
        if (splitter) {
          const tail = splitter.flush()
          if (tail.thinking) thinkingAcc += tail.thinking
          if (tail.text) {
            acc += tail.text
            stream.push({ type: 'text_delta', contentIndex: 0, delta: tail.text, partial: msg })
          }
          msg.content = [
            ...(thinkingAcc ? [{ type: 'thinking', thinking: thinkingAcc }] : []),
            { type: 'text', text: acc || thinkingAcc },
          ]
        }
        msg.usage.output = Math.ceil((acc.length + thinkingAcc.length) / 4)
        msg.usage.totalTokens = msg.usage.output
        stream.push({ type: 'text_end', contentIndex: 0, content: acc || thinkingAcc, partial: msg })
        stream.push({ type: 'done', reason: 'stop', message: msg })
      } catch (e) {
        msg.stopReason = 'error'; msg.errorMessage = String(e?.message || e)
        stream.push({ type: 'error', reason: 'error', error: msg })
      }
    })()
    return stream
  }
}

export function toAgentTools(specs) {
  return specs.map((s) => ({
    name: s.name,
    label: s.name,
    description: s.description,
    parameters: s.parameters,
    execute: async (_id, params) => ({ content: [{ type: 'text', text: await s.run(params || {}) }], details: {} }),
  }))
}

const textOf = (message) => (message?.content || []).filter((p) => p.type === 'text').map((p) => p.text).join('')
const thinkingOf = (message) => (message?.content || []).filter((p) => p.type === 'thinking').map((p) => p.thinking || '').join('')

async function executeSinglePiAttempt({
  pi, streamFn, model, apiKey, system, messages, prompt, tools, sessionId,
  thinkingLevel = 'off', inlineThink = true, onToken, onThinking, onTrace, timeoutMs,
}) {
  const agent = new pi.Agent({
    initialState: { systemPrompt: system, model, tools: tools || [], messages, thinkingLevel },
    streamFn,
    getApiKey: async () => apiKey || undefined,
    sessionId,
  })
  let lastEmittedThinking = ''
  const unsub = agent.subscribe((ev) => {
    if (ev.type === 'message_update') {
      const rawText = textOf(ev.message)
      const structuredThink = thinkingOf(ev.message)
      if (structuredThink && structuredThink !== lastEmittedThinking) {
        lastEmittedThinking = structuredThink
        onThinking?.(structuredThink)
      }
      if (rawText) {
        if (inlineThink) {
          const split = splitLeadingThinkBlock(rawText)
          if (split) {
            if (split.thinking && split.thinking !== lastEmittedThinking) {
              lastEmittedThinking = split.thinking
              onThinking?.(split.thinking)
            }
            if (split.text) onToken?.(split.text)
            return
          }
        }
        onToken?.(rawText)
      }
    } else if (ev.type === 'tool_execution_start') {
      onTrace?.(`tool ${ev.toolName}(${Object.entries(ev.args || {}).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')})`)
    } else if (ev.type === 'tool_execution_end') {
      onTrace?.(`tool ${ev.toolName} ${ev.isError ? '→ error' : '→ ok'}`)
    }
  })
  let timer = null
  let timedOut = false
  try {
    if (timeoutMs) timer = setTimeout(() => { timedOut = true; agent.abort().catch(() => {}) }, timeoutMs)
    await agent.prompt(prompt)
    await agent.waitForIdle()
  } catch (e) {
    if (!timedOut) throw e
  } finally {
    if (timer) clearTimeout(timer)
    unsub()
  }
  if (timedOut) throw new Error(`remote timed out after ${Math.round(timeoutMs / 1000)}s`)
  if (agent.state.errorMessage) throw new Error(agent.state.errorMessage)
  const last = [...agent.state.messages].reverse().find((m) => m.role === 'assistant')
  const finalRaw = textOf(last)
  if (inlineThink) {
    const split = splitLeadingThinkBlock(finalRaw)
    if (split) {
      if (split.thinking && split.thinking !== lastEmittedThinking) {
        onThinking?.(split.thinking)
        onTrace?.(`thought · ${split.thinking.replace(/\s+/g, ' ').slice(0, 140)}`)
      }
      return split.text || finalRaw
    }
  }
  const structuredThink = thinkingOf(last)
  if (structuredThink) {
    onThinking?.(structuredThink)
    onTrace?.(`thought · ${structuredThink.replace(/\s+/g, ' ').slice(0, 140)}`)
  }
  return finalRaw
}

/**
 * Run one user prompt through a pi Agent with the given streamFn.
 * Automatically rectifies and retries once if the upstream API fails with a
 * thinking signature or thinking budget error (`cc-switch` rectifier pipeline).
 */
export async function runPiTurn({
  streamFn, model, apiKey, system, history, prompt, tools, sessionId,
  thinkingLevel = 'off', rectifierConfig, onToken, onThinking, onTrace, timeoutMs,
}) {
  const pi = await loadPi()
  const baseMessages = history.map((m) => (m.role === 'user'
    ? { role: 'user', content: m.content, timestamp: Date.now() }
    : {
        role: 'assistant',
        content: Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }],
        api: model.api, provider: model.provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: zeroCost },
        stopReason: 'stop', timestamp: Date.now(),
      }))

  const inlineThink = rectifierConfig?.inlineThink !== false

  try {
    return await executeSinglePiAttempt({
      pi, streamFn, model, apiKey, system, messages: baseMessages, prompt, tools, sessionId,
      thinkingLevel, inlineThink, onToken, onThinking, onTrace, timeoutMs,
    })
  } catch (err) {
    const msg = String(err?.message || err)
    const sigTrigger = shouldRectifyThinkingSignature(msg, rectifierConfig)
    const budgetTrigger = shouldRectifyThinkingBudget(msg, rectifierConfig)
    if (!sigTrigger && !budgetTrigger) throw err

    const { messages: cleanedMessages } = sigTrigger
      ? rectifyPiMessages(baseMessages)
      : { messages: baseMessages }
    const nextThinkingLevel = sigTrigger ? 'off' : thinkingLevel
    onTrace?.(`rectifier · ${sigTrigger ? 'stripped invalid thinking signatures' : 'adjusted thinking budget'} → retrying turn`)

    return await executeSinglePiAttempt({
      pi, streamFn, model, apiKey, system, messages: cleanedMessages, prompt, tools, sessionId,
      thinkingLevel: nextThinkingLevel, inlineThink, onToken, onThinking, onTrace, timeoutMs,
    })
  }
}
