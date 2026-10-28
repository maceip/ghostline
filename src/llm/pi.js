// pi (@mariozechner/pi-agent-core + pi-ai) is the off-the-shelf agent loop:
// tool calling, session/transcript state, provider streaming. It is loaded lazily
// (dynamic import) so the shell never pays for it until the first real turn.
// Remote providers use pi-ai's own Anthropic / OpenAI-completions stream functions;
// LiteRT-LM is adapted into the same loop as a custom pi StreamFn, so local and
// remote share tools, history shaping, and event handling.
import { localStream } from './litert.js'

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

export function remoteModel(config) {
  if (config.provider === 'openai') {
    return {
      id: config.openaiModel, name: config.openaiModel, api: 'openai-completions', provider: 'openai',
      baseUrl: config.baseUrl || 'https://api.openai.com/v1', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096,
    }
  }
  return {
    id: config.model, name: config.model, api: 'anthropic-messages', provider: 'anthropic',
    baseUrl: 'https://api.anthropic.com', reasoning: false, input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 4096,
    headers: { 'anthropic-dangerous-direct-browser-access': 'true' },
  }
}

export function localModel(config) {
  return {
    id: 'litert-lm', name: 'LiteRT-LM (local)', api: 'litert-lm', provider: 'litert-lm',
    baseUrl: '', reasoning: false, input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024,
  }
}

export async function remoteStreamFn(config) {
  return loadPiProvider(config.provider)
}

/** LiteRT-LM as a pi StreamFn. Text only: small local models don't get tools in v1. */
export async function litertStreamFn(config) {
  const pi = await loadPi()
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
        let acc = ''
        for await (const delta of localStream(config.localModelUrl, context.systemPrompt || '', messages)) {
          acc += delta
          msg.content = [{ type: 'text', text: acc }]
          stream.push({ type: 'text_delta', contentIndex: 0, delta, partial: msg })
        }
        msg.usage.output = Math.ceil(acc.length / 4); msg.usage.totalTokens = msg.usage.output
        stream.push({ type: 'text_end', contentIndex: 0, content: acc, partial: msg })
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

/** Run one user prompt through a pi Agent with the given streamFn. Returns final text; throws on provider error or timeout. */
export async function runPiTurn({ streamFn, model, apiKey, system, history, prompt, tools, sessionId, onToken, onTrace, timeoutMs }) {
  const pi = await loadPi()
  const messages = history.map((m) => (m.role === 'user'
    ? { role: 'user', content: m.content, timestamp: Date.now() }
    : {
        role: 'assistant', content: [{ type: 'text', text: m.content }], api: model.api, provider: model.provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: zeroCost }, stopReason: 'stop', timestamp: Date.now(),
      }))
  const agent = new pi.Agent({
    initialState: { systemPrompt: system, model, tools: tools || [], messages, thinkingLevel: 'off' },
    streamFn,
    getApiKey: async () => apiKey || undefined,
    sessionId,
  })
  const unsub = agent.subscribe((ev) => {
    if (ev.type === 'message_update') { const t = textOf(ev.message); if (t) onToken?.(t) }
    else if (ev.type === 'tool_execution_start') onTrace?.(`tool ${ev.toolName}(${Object.entries(ev.args || {}).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')})`)
    else if (ev.type === 'tool_execution_end') onTrace?.(`tool ${ev.toolName} ${ev.isError ? '→ error' : '→ ok'}`)
  })
  let timer = null
  let timedOut = false
  try {
    if (timeoutMs) timer = setTimeout(() => { timedOut = true; agent.abort().catch(() => {}) }, timeoutMs)
    await agent.prompt(prompt)
    await agent.waitForIdle()
  } catch (e) {
    if (!timedOut) throw e
  } finally { if (timer) clearTimeout(timer); unsub() }
  if (timedOut) throw new Error(`remote timed out after ${Math.round(timeoutMs / 1000)}s`)
  if (agent.state.errorMessage) throw new Error(agent.state.errorMessage)
  const last = [...agent.state.messages].reverse().find((m) => m.role === 'assistant')
  return textOf(last)
}
