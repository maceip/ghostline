// Cheap-stack telemetry hooks for the LLM router.
// Opt-in: only active when CHEAP_STACK_URL or an ingest token is configured.
// Sends routing metadata ONLY (engine name, circuit states, latency) — never
// prompt text, completions, file contents, or API keys.
//
// Usage:
//   import { createTelemetryHooks } from './src/llm/telemetry.js'
//   const hooks = createTelemetryHooks()
//   await runTurn({ config, prompt, runners, hooks })

export function buildEngineEvent(name, { latencyMs = null } = {}) {
  return { kind: 'llm-engine', detail: JSON.stringify({ engine: String(name), latencyMs }) }
}

export function buildCircuitEvent(snapshot) {
  const states = {}
  for (const [leg, s] of Object.entries(snapshot || {})) {
    states[leg] = s?.state ?? s?.status ?? 'unknown'
  }
  return { kind: 'llm-circuit', detail: JSON.stringify({ legs: states }) }
}

export function createTelemetryHooks({ ingestFn = null, nowFn = () => Date.now() } = {}) {
  let send = ingestFn
  let lastStart = null
  async function emit(event) {
    try {
      if (!send) {
        // Lazy default: the Cheap Stack Analytics SDK (sessions included).
        // Token comes from CHEAP_STACK_TOKEN (Node) or localStorage (web).
        const mod = await import('../../tools/cheapstack-analytics.js').catch(() => null)
        if (mod?.Analytics) {
          const token = (typeof process !== 'undefined' && process.env?.CHEAP_STACK_TOKEN)
            || (typeof localStorage !== 'undefined' ? localStorage.getItem('cheapStackToken') : '') || ''
          const client = new mod.Analytics({
            app: 'zode', token, autoPageviews: false, autoErrors: false,
          })
          send = (_app, kind, detail) => {
            let props = {}
            try { props = JSON.parse(detail) } catch { props = { raw: String(detail).slice(0, 200) } }
            client.track(kind, props)
            return client.flush()
          }
        } else {
          send = () => Promise.resolve(null)
        }
      }
      await send('zode', event.kind, event.detail)
    } catch { /* telemetry must never break a turn */ }
  }
  return {
    onEngine(name) {
      const now = nowFn()
      const latencyMs = lastStart == null ? null : now - lastStart
      lastStart = now
      void emit(buildEngineEvent(name, { latencyMs }))
    },
    onCircuit(snapshot) {
      void emit(buildCircuitEvent(snapshot))
    },
  }
}
