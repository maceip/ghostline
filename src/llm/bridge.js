// Native bridge client (see BRIDGE.md). A per-platform sidecar — wrapping a local
// `claude`/`codex` CLI or an Agent SDK with real filesystem/shell tools — implements
// two endpoints; the webview needs no changes when one appears:
//   GET  {url}/health      -> 200 {name, version}
//   POST {url}/v1/turn     {sessionId, system, messages:[{role,content}], prompt}
//        -> text/event-stream: data: {"type":"token","text":"…"} | {"type":"trace","text":"…"} | {"type":"done"} | {"type":"error","message":"…"}
let healthCache = { url: '', ok: false, at: 0 }

export async function bridgeHealthy(url) {
  if (!url) return false
  const base = url.replace(/\/$/, '')
  if (healthCache.url === base && Date.now() - healthCache.at < 30000) return healthCache.ok
  let ok = false
  try {
    const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) })
    ok = r.ok
  } catch { ok = false }
  healthCache = { url: base, ok, at: Date.now() }
  return ok
}

export async function bridgeTurn(url, { sessionId, system, history, prompt }, { onToken, onTrace } = {}) {
  const base = url.replace(/\/$/, '')
  if (!(await bridgeHealthy(base))) throw new Error(`native bridge not reachable at ${base} (is the sidecar running?)`)
  const res = await fetch(`${base}/v1/turn`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, system, messages: history, prompt }),
  })
  if (!res.ok || !res.body) throw new Error(`bridge turn failed: HTTP ${res.status}`)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let text = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n'); buffer = lines.pop()
    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      let ev; try { ev = JSON.parse(line.slice(5).trim()) } catch { continue }
      if (ev.type === 'token') { text += ev.text || ''; onToken?.(text) }
      else if (ev.type === 'trace') onTrace?.(ev.text)
      else if (ev.type === 'error') throw new Error(ev.message || 'bridge error')
    }
  }
  return { text, label: 'native bridge' }
}
