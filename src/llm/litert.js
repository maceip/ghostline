// LiteRT-LM local engine (@litert-lm/core, WebGPU). Lazy: nothing downloads until
// ensureLocal() is called — first chat with no remote configured, an explicit
// "load now" in Settings, or the background preload after a successful remote turn.
let engine = null
let loading = null
let status = { state: 'idle', detail: 'not loaded' }
const listeners = new Set()

function setStatus(state, detail) {
  status = { state, detail }
  listeners.forEach((fn) => { try { fn(status) } catch { /* listener gone */ } })
}
export const getLocalStatus = () => status
export function onLocalStatus(fn) { listeners.add(fn); fn(status); return () => listeners.delete(fn) }
export const localReady = () => !!engine

export async function ensureLocal(modelUrl) {
  if (engine) return engine
  if (!modelUrl) throw new Error('no local model URL configured (settings → local model)')
  loading ??= (async () => {
    setStatus('loading', 'downloading model… first run only, then browser-cached')
    try {
      const { Engine } = await import('@litert-lm/core')
      engine = await Engine.create({ model: modelUrl })
      setStatus('ready', 'local model ready')
      return engine
    } catch (e) {
      loading = null
      setStatus('error', String(e?.message || e))
      throw new Error(`LiteRT-LM failed to load (${e?.message || e}). Needs WebGPU and the model URL must serve a web .litertlm file.`)
    }
  })()
  return loading
}

function chunkText(chunk) {
  const c = chunk?.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.filter((p) => p.type === 'text').map((p) => p.text).join('')
  return ''
}

/** Stream one local completion. messages: [{role:'user'|'assistant', content}] ending with the new user prompt. */
export async function* localStream(modelUrl, system, messages) {
  const eng = await ensureLocal(modelUrl)
  const preface = []
  if (system) preface.push({ role: 'system', content: system })
  for (const m of messages.slice(0, -1)) preface.push({ role: m.role === 'assistant' ? 'model' : 'user', content: m.content })
  const conversation = await eng.createConversation(preface.length ? { preface: { messages: preface } } : undefined)
  try {
    const stream = conversation.sendMessageStreaming(messages[messages.length - 1].content)
    const reader = stream.getReader()
    let acc = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const text = chunkText(value)
      if (!text) continue
      if (text.startsWith(acc) && acc) { const d = text.slice(acc.length); acc = text; if (d) yield d } // cumulative chunks
      else { acc += text; yield text } // delta chunks
    }
  } finally {
    try { await conversation.delete() } catch { /* already gone */ }
  }
}
