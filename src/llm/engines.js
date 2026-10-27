// Browser runners for router.js. Each: async ({system, history, prompt, diagnoseError}, hooks) -> {text, label}
// hooks: {onToken(textSoFar), onTrace(line), onStatus(line)}
import { diagnosisPrompt } from './router.js'
import { makeWorkspaceTools } from './tools.js'
import { runPiTurn, remoteStreamFn, litertStreamFn, remoteModel, localModel, toAgentTools } from './pi.js'
import { ensureLocal } from './litert.js'
import { bridgeTurn } from './bridge.js'
import { localStream } from './litert.js'

export function buildRunners(config, workspace, demoText) {
  const tools = toAgentTools(makeWorkspaceTools(workspace))

  const piTurn = async (which, { system, history, prompt, diagnoseError }, hooks) => {
    const isLocal = which === 'local'
    if (isLocal) { hooks.onStatus?.('loading local model (first run downloads it)…'); await ensureLocal(config.localModelUrl) }
    else hooks.onStatus?.(`calling ${config.provider === 'openai' ? config.openaiModel : config.model}…`)
    const streamFn = isLocal ? await litertStreamFn(config) : await remoteStreamFn(config)
    const turnPromise = runPiTurn({
      streamFn,
      model: isLocal ? localModel(config) : remoteModel(config),
      apiKey: config.apiKey,
      system,
      history,
      prompt: diagnoseError ? diagnosisPrompt(prompt, diagnoseError) : prompt,
      tools: isLocal ? [] : tools, // small local models: no tools in v1 (reliability); remote gets the workspace tools
      sessionId: hooks.sessionId,
      onToken: hooks.onToken,
      onTrace: hooks.onTrace,
      timeoutMs: isLocal ? undefined : config.remoteTimeoutMs,
    })
    // race at this level too: a slow first pi import must not escape the remote budget.
    // (the abandoned turn still self-aborts via runPiTurn's own timer once pi arrives.)
    const text = isLocal || !config.remoteTimeoutMs
      ? await turnPromise
      : await Promise.race([
          turnPromise,
          new Promise((_, rej) => setTimeout(() => rej(new Error(`remote timed out after ${Math.round(config.remoteTimeoutMs / 1000)}s`)), config.remoteTimeoutMs)),
        ])
    return { text, label: isLocal ? 'litert-lm · local' : (config.provider === 'openai' ? config.openaiModel : config.model) }
  }

  return {
    bridge: async ({ system, history, prompt }, hooks) => bridgeTurn(config.bridgeUrl, { sessionId: hooks.sessionId, system, history, prompt }, hooks),
    remote: (req, hooks) => piTurn('remote', req, hooks),
    local: (req, hooks) => piTurn('local', req, hooks),
    demo: async ({ onToken } = {}, hooks = {}) => {
      const h = hooks.onToken || onToken
      const words = demoText.split(' ')
      let acc = ''
      for (const w of words) {
        acc += (acc ? ' ' : '') + w
        h?.(acc)
        await new Promise((r) => setTimeout(r, 24))
      }
      return { text: demoText, label: 'demo · simulated' }
    },
  }
}

/** Background local preload: after a successful remote turn, warm LiteRT-LM so a later failure has somewhere to land. */
export function maybePreloadLocal(config, engineUsed) {
  if (!config.bgPreload || engineUsed === 'local' || engineUsed === 'demo') return
  ensureLocal(config.localModelUrl).catch(() => { /* surfaced when local is actually needed */ })
}

export { localStream }
