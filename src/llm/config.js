// Engine configuration. Persisted to localStorage only — API keys never leave the device
// except in the Authorization header of the provider call itself.
export const CONFIG_KEY = 'zunecode.config.v1'

export const DEFAULT_CONFIG = {
  mode: 'auto', // auto | remote | local | demo
  provider: 'anthropic', // anthropic | openai (OpenAI-compatible chat completions)
  apiKey: '',
  model: 'claude-sonnet-4-5',
  openaiModel: 'gpt-4o',
  baseUrl: 'https://api.openai.com/v1',
  // LiteRT-LM web model (Google's documented web example). ~1-2 GB, downloaded lazily, cached by the browser.
  localModelUrl: 'https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/main/gemma-4-E2B-it-gpu.litertlm',
  bgPreload: true, // after the first successful remote turn, pull the local model in the background
  bridgeUrl: '', // optional native sidecar speaking BRIDGE.md (e.g. http://127.0.0.1:17861)
  remoteTimeoutMs: 45000, // remote gets this long before auto falls back to local
  accentName: 'magenta',
  theme: 'dark',
  density: 1,
  motion: { tilt: true, spotlight: true, glow: true, shimmer: true, cascade: true }, // per-card effects still opt in individually
}

export function loadConfig() {
  try {
    const raw = globalThis.localStorage?.getItem(CONFIG_KEY)
    if (!raw) return { ...DEFAULT_CONFIG }
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

export function saveConfig(config) {
  try { globalThis.localStorage?.setItem(CONFIG_KEY, JSON.stringify(config)) } catch { /* private mode */ }
}

export function remoteConfigured(config) {
  return !!(config.apiKey && config.apiKey.trim())
}

export function bridgeConfigured(config) {
  return !!(config.bridgeUrl && config.bridgeUrl.trim())
}
