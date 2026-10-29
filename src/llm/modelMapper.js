// Tiered Model Mapper + Offline Pi Model Catalog & Thinking Level Profiles
// (ported from farion1231/cc-switch:
//   - src-tauri/src/proxy/model_mapper.rs
//   - src/config/piModelCatalog.ts
//   - src/config/piThinkingProfiles.ts)
//
// Zero runtime dependencies. Provides:
// 1. `ModelMapping` / `applyModelMapping` / `stripOneMSuffix`: maps abstract role tiers
//    (`haiku`, `sonnet`, `opus`, `fable`, `subagent`, `default`) with `fable -> opus` fallback
//    and strips `[1M]` / `[1m]` local context markers before upstream wire dispatch.
// 2. `PI_MODEL_CATALOG` & `PI_THINKING_PROFILES`: offline capability & thinking-level lookups
//    for `@mariozechner/pi-ai` models.

export const ONE_M_CONTEXT_MARKER = '[1m]'

export const PI_THINKING_LEVELS = Object.freeze([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
])

export const PI_THINKING_PROFILES = Object.freeze({
  xhighAndMax: { map: { xhigh: 'xhigh', max: 'max' } },
  deepseekV4: { map: { minimal: null, low: null, medium: null, high: 'high', max: 'max' } },
  offUnsupported: { map: { off: null } },
  kimi3: { map: { off: null, minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: 'max' } },
  openCodeGoGlm52: { map: { off: null, minimal: null, low: null, medium: null, high: 'high', xhigh: null, max: 'max' } },
  offUnsupportedXhighAndMax: { map: { off: null, xhigh: 'xhigh', max: 'max' } },
  maxOnly: { map: { max: 'max' } },
  lowMediumHighOnly: { map: { off: null, minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null } },
  openaiResponsesGpt5: { map: { off: null, minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null } },
  openaiResponsesGpt51: { map: { off: 'none', minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null } },
  openaiResponsesGpt52To55: { map: { off: 'none', minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: null } },
  openaiResponsesGpt53CodexSpark: { map: { off: null, minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: null } },
  openaiResponsesGpt56: { map: { off: 'none', minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' } },
  openaiResponsesGpt6Astra: { map: { off: null, minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' } },
  geminiLowHigh: { map: { off: null, minimal: null, low: 'LOW', medium: null, high: 'HIGH' } },
})

export const PI_MODEL_CATALOG = Object.freeze({
  'amazon/nova-pro': { name: 'Amazon Nova Pro', reasoning: false, input: ['text', 'image'], contextWindow: 300000, maxTokens: 8192 },
  'anthropic/claude-haiku-4.5': { name: 'Claude Haiku 4.5', reasoning: true, input: ['text', 'image'], contextWindow: 200000, maxTokens: 64000 },
  'anthropic/claude-sonnet-4.5': { name: 'Claude Sonnet 4.5', reasoning: true, input: ['text', 'image'], contextWindow: 200000, maxTokens: 64000 },
  'anthropic/claude-sonnet-4.6': { name: 'Claude Sonnet 4.6', reasoning: true, input: ['text', 'image'], contextWindow: 1000000, maxTokens: 128000 },
  'anthropic/claude-sonnet-5': { name: 'Claude Sonnet 5', reasoning: true, input: ['text', 'image'], contextWindow: 1000000, maxTokens: 128000, thinkingProfile: 'xhighAndMax', modelCompat: { forceAdaptiveThinking: true } },
  'anthropic/claude-sonnet-5.5': { name: 'Claude Sonnet 5.5', reasoning: true, input: ['text', 'image'], contextWindow: 1000000, maxTokens: 128000 },
  'anthropic/claude-opus-4.5': { name: 'Claude Opus 4.5', reasoning: true, input: ['text', 'image'], contextWindow: 200000, maxTokens: 64000 },
  'anthropic/claude-opus-4.6': { name: 'Claude Opus 4.6', reasoning: true, input: ['text', 'image'], contextWindow: 1000000, maxTokens: 128000, thinkingProfile: 'maxOnly', modelCompat: { forceAdaptiveThinking: true } },
  'anthropic/claude-opus-4.7': { name: 'Claude Opus 4.7', reasoning: true, input: ['text', 'image'], contextWindow: 1000000, maxTokens: 128000, thinkingProfile: 'xhighAndMax', modelCompat: { forceAdaptiveThinking: true } },
  'anthropic/claude-opus-5': { name: 'Claude Opus 5', reasoning: true, input: ['text', 'image'], contextWindow: 1000000, maxTokens: 128000, thinkingProfile: 'xhighAndMax', modelCompat: { forceAdaptiveThinking: true } },
  'anthropic/claude-opus-5.5': { name: 'Claude Opus 5.5', reasoning: true, input: ['text', 'image'], contextWindow: 1000000, maxTokens: 128000, thinkingProfile: 'offUnsupportedXhighAndMax', modelCompat: { forceAdaptiveThinking: true } },
  'anthropic/claude-fable-5': { name: 'Claude Fable 5', reasoning: true, input: ['text', 'image'], contextWindow: 1000000, maxTokens: 128000, thinkingProfile: 'offUnsupportedXhighAndMax', modelCompat: { forceAdaptiveThinking: true } },
  'anthropic/claude-fable-5.1': { name: 'Claude Fable 5.1', reasoning: true, input: ['text', 'image'], contextWindow: 1000000, maxTokens: 128000, thinkingProfile: 'offUnsupportedXhighAndMax', modelCompat: { forceAdaptiveThinking: true } },
  'deepseek/deepseek-r1': { name: 'DeepSeek R1', reasoning: true, input: ['text'], contextWindow: 128000, maxTokens: 32768 },
  'deepseek/deepseek-v3.2': { name: 'DeepSeek V3.2', reasoning: true, input: ['text'], contextWindow: 131072, maxTokens: 32768 },
  'deepseek/deepseek-v4-flash': { name: 'DeepSeek V4 Flash', reasoning: true, input: ['text'], contextWindow: 1000000, maxTokens: 384000, thinkingProfile: 'deepseekV4' },
  'deepseek/deepseek-v4-pro': { name: 'DeepSeek V4 Pro', reasoning: true, input: ['text'], contextWindow: 1000000, maxTokens: 384000, thinkingProfile: 'deepseekV4' },
  'google/gemini-2.5-flash': { name: 'Gemini 2.5 Flash', reasoning: true, input: ['text', 'image'], contextWindow: 1048576, maxTokens: 65536 },
  'google/gemini-2.5-pro': { name: 'Gemini 2.5 Pro', reasoning: true, input: ['text', 'image'], contextWindow: 1048576, maxTokens: 65536 },
  'google/gemini-3.1-pro-preview': { name: 'Gemini 3.1 Pro Preview', reasoning: true, input: ['text', 'image'], contextWindow: 1048576, maxTokens: 65536, thinkingProfile: 'geminiLowHigh' },
  'google/gemini-3.5-flash': { name: 'Gemini 3.5 Flash', reasoning: true, input: ['text', 'image'], contextWindow: 1048576, maxTokens: 65536, thinkingProfile: 'offUnsupported' },
  'minimax/minimax-m3': { name: 'MiniMax-M3', reasoning: true, input: ['text', 'image'], contextWindow: 1000000, maxTokens: 128000 },
  'moonshotai/kimi-k2.5': { name: 'Kimi K2.5', reasoning: true, input: ['text', 'image'], contextWindow: 262144, maxTokens: 262144 },
  'moonshotai/kimi-k3': { name: 'Kimi K3', reasoning: true, input: ['text', 'image'], contextWindow: 1048576, maxTokens: 131072, thinkingProfile: 'kimi3' },
  'openai/gpt-4o': { name: 'GPT-4o', reasoning: false, input: ['text', 'image'], contextWindow: 128000, maxTokens: 16384 },
  'openai/gpt-5': { name: 'GPT-5', reasoning: true, input: ['text', 'image'], contextWindow: 272000, maxTokens: 128000, thinkingProfile: 'openaiResponsesGpt5' },
  'openai/gpt-5-mini': { name: 'GPT-5 Mini', reasoning: true, input: ['text', 'image'], contextWindow: 272000, maxTokens: 128000, thinkingProfile: 'openaiResponsesGpt5' },
  'openai/gpt-5.1': { name: 'GPT-5.1', reasoning: true, input: ['text', 'image'], contextWindow: 272000, maxTokens: 128000, thinkingProfile: 'openaiResponsesGpt51' },
  'openai/gpt-5.2': { name: 'GPT-5.2', reasoning: true, input: ['text', 'image'], contextWindow: 272000, maxTokens: 128000, thinkingProfile: 'openaiResponsesGpt52To55' },
  'openai/gpt-5.3-codex': { name: 'GPT-5.3 Codex', reasoning: true, input: ['text', 'image'], contextWindow: 272000, maxTokens: 128000, thinkingProfile: 'openaiResponsesGpt52To55' },
  'openai/gpt-5.4': { name: 'GPT-5.4', reasoning: true, input: ['text', 'image'], contextWindow: 272000, maxTokens: 128000, thinkingProfile: 'openaiResponsesGpt52To55' },
  'openai/gpt-5.4-mini': { name: 'GPT-5.4 mini', reasoning: true, input: ['text', 'image'], contextWindow: 272000, maxTokens: 128000, thinkingProfile: 'openaiResponsesGpt52To55' },
  'openai/gpt-5.5': { name: 'GPT-5.5', reasoning: true, input: ['text', 'image'], contextWindow: 272000, maxTokens: 128000, thinkingProfile: 'openaiResponsesGpt52To55' },
  'openai/gpt-5.6-sol': { name: 'GPT-5.6 Sol', reasoning: true, input: ['text', 'image'], contextWindow: 272000, maxTokens: 128000, thinkingProfile: 'openaiResponsesGpt56' },
  'openai/o3': { name: 'o3', reasoning: true, input: ['text', 'image'], contextWindow: 200000, maxTokens: 100000, thinkingProfile: 'lowMediumHighOnly' },
  'openai/o4-mini': { name: 'o4-mini', reasoning: true, input: ['text', 'image'], contextWindow: 200000, maxTokens: 100000, thinkingProfile: 'lowMediumHighOnly' },
  'qwen/qwen3-coder-plus': { name: 'Qwen3 Coder Plus', reasoning: false, input: ['text'], contextWindow: 1000000, maxTokens: 65536 },
  'qwen/qwen3.5': { name: 'Qwen3.5', reasoning: true, input: ['text', 'image'], contextWindow: 262144, maxTokens: 32768 },
  'xai/grok-4.5': { name: 'Grok 4.5', reasoning: true, input: ['text', 'image'], contextWindow: 500000, maxTokens: 500000, thinkingProfile: 'lowMediumHighOnly' },
  'zai/glm-5': { name: 'GLM-5', reasoning: true, input: ['text'], contextWindow: 200000, maxTokens: 131072 },
  'zai/glm-5.2': { name: 'GLM-5.2', reasoning: true, input: ['text'], contextWindow: 1000000, maxTokens: 131072, thinkingProfile: 'openCodeGoGlm52' },
})

/**
 * Strip Claude Code's local `[1M]` / `[1m]` context marker before dispatching to upstream APIs.
 */
export function stripOneMSuffix(model) {
  if (typeof model !== 'string') return ''
  const trimmed = model.trimEnd()
  if (trimmed.toLowerCase().endsWith(ONE_M_CONTEXT_MARKER)) {
    return trimmed.slice(0, trimmed.length - ONE_M_CONTEXT_MARKER.length).trimEnd()
  }
  return model
}

export function stripOneMSuffixFromBody(body) {
  if (!body || typeof body !== 'object' || typeof body.model !== 'string') return body
  const stripped = stripOneMSuffix(body.model)
  if (stripped !== body.model) {
    return { ...body, model: stripped }
  }
  return body
}

function normalizeClientSubagentId(model) {
  const raw = stripOneMSuffix(model).replace(/^[^/]+\//, '')
  return raw.replace(/(\d+)\.(\d+)/g, '$1-$2')
}

export class ModelMapping {
  constructor(mapping = {}) {
    const env = mapping.env || mapping
    const nonEmpty = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null)
    this.haikuModel = nonEmpty(env.haikuModel ?? env.ANTHROPIC_DEFAULT_HAIKU_MODEL)
    this.sonnetModel = nonEmpty(env.sonnetModel ?? env.ANTHROPIC_DEFAULT_SONNET_MODEL)
    this.opusModel = nonEmpty(env.opusModel ?? env.ANTHROPIC_DEFAULT_OPUS_MODEL)
    this.fableModel = nonEmpty(env.fableModel ?? env.ANTHROPIC_DEFAULT_FABLE_MODEL)
    this.subagentModel = nonEmpty(env.subagentModel ?? env.CLAUDE_CODE_SUBAGENT_MODEL)
    this.defaultModel = nonEmpty(env.defaultModel ?? env.ANTHROPIC_MODEL)
  }

  hasMapping() {
    return Boolean(
      this.haikuModel ||
      this.sonnetModel ||
      this.opusModel ||
      this.fableModel ||
      this.subagentModel ||
      this.defaultModel
    )
  }

  mapModel(originalModel, role = null) {
    if (role === 'subagent' && this.subagentModel) {
      return stripOneMSuffix(this.subagentModel)
    }
    if (role === 'fast' && this.haikuModel) {
      return stripOneMSuffix(this.haikuModel)
    }
    if (role === 'reasoning' && (this.fableModel || this.opusModel)) {
      return stripOneMSuffix(this.fableModel || this.opusModel)
    }

    if (typeof originalModel !== 'string' || !originalModel) {
      return this.defaultModel || originalModel || ''
    }

    const lower = originalModel.toLowerCase()

    if (lower.includes('fable')) {
      if (this.fableModel) return this.fableModel
      // Fable degrades to Opus tier before falling back to default (cc-switch #3980)
      if (this.opusModel) return this.opusModel
    }
    if (lower.includes('haiku') && this.haikuModel) {
      return this.haikuModel
    }
    if (lower.includes('opus') && this.opusModel) {
      return this.opusModel
    }
    if (lower.includes('sonnet') && this.sonnetModel) {
      return this.sonnetModel
    }

    if (this.subagentModel) {
      if (stripOneMSuffix(originalModel) === stripOneMSuffix(this.subagentModel)) {
        return originalModel
      }
      if (stripOneMSuffix(originalModel) === normalizeClientSubagentId(this.subagentModel)) {
        return this.subagentModel
      }
    }

    if (this.defaultModel) {
      return this.defaultModel
    }

    return originalModel
  }
}

export function applyModelMapping(body, providerOrMapping = {}) {
  const mapping = providerOrMapping instanceof ModelMapping
    ? providerOrMapping
    : new ModelMapping(providerOrMapping?.settingsConfig || providerOrMapping?.modelMapping || providerOrMapping)

  const original = typeof body?.model === 'string' ? body.model : null
  if (!mapping.hasMapping() || !original) {
    return { body, originalModel: original, mappedModel: null }
  }

  const mapped = mapping.mapModel(original)
  if (mapped !== original) {
    return {
      body: { ...body, model: mapped },
      originalModel: original,
      mappedModel: mapped,
    }
  }
  return { body, originalModel: original, mappedModel: null }
}

/**
 * Look up a model ID in `PI_MODEL_CATALOG` (matching either exact `vendor/id`, bare `id`,
 * or hyphen/dot normalized variants like `claude-sonnet-4-5` <-> `anthropic/claude-sonnet-4.5`).
 */
export function lookupPiModelCapabilities(modelId) {
  if (typeof modelId !== 'string' || !modelId.trim()) return null
  const clean = stripOneMSuffix(modelId.trim()).toLowerCase()

  if (PI_MODEL_CATALOG[clean]) {
    return resolveCatalogEntry(clean, PI_MODEL_CATALOG[clean])
  }

  const dotNormalized = clean.replace(/-(\d+)-(\d+)(?=$|[-])/g, '-$1.$2')
  // Pass 1: exact match on full key or bare key
  for (const [key, entry] of Object.entries(PI_MODEL_CATALOG)) {
    const bareKey = key.split('/').pop()
    if (key === dotNormalized || bareKey === clean || bareKey === dotNormalized) {
      return resolveCatalogEntry(key, entry)
    }
  }
  // Pass 2: longest prefix match (e.g. `claude-sonnet-4-5-20250929` -> `claude-sonnet-4.5`)
  let bestKey = null
  let bestLen = 0
  for (const [key] of Object.entries(PI_MODEL_CATALOG)) {
    const bareKey = key.split('/').pop()
    if (
      (clean.startsWith(`${bareKey}-`) || dotNormalized.startsWith(`${bareKey}-`)) &&
      bareKey.length > bestLen
    ) {
      bestKey = key
      bestLen = bareKey.length
    }
  }
  if (bestKey) return resolveCatalogEntry(bestKey, PI_MODEL_CATALOG[bestKey])
  return null
}

function resolveCatalogEntry(catalogKey, entry) {
  const profile = entry.thinkingProfile ? PI_THINKING_PROFILES[entry.thinkingProfile] : null
  return {
    catalogKey,
    name: entry.name,
    reasoning: entry.reasoning,
    input: [...entry.input],
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
    ...(profile ? { thinkingLevelMap: { ...profile.map } } : {}),
    ...(entry.modelCompat ? { compat: { ...entry.modelCompat } } : {}),
  }
}

export function isPiThinkingLevelMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const allowed = new Set(PI_THINKING_LEVELS)
  return Object.entries(value).every(
    ([key, entry]) => allowed.has(key) && (typeof entry === 'string' || entry === null)
  )
}
