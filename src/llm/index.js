// Standalone, portable LLM Router & CC Switch Toolkit Barrel (`src/llm/index.js`).
// Can be imported as a single self-contained module or published as a workspace package
// across other projects without pulling in any Zune UI or React dependencies.

export {
  CONFIG_KEY,
  DEFAULT_CONFIG,
  loadConfig,
  saveConfig,
  remoteConfigured,
  bridgeConfigured,
} from './config.js'

export {
  CIRCUIT_STATES,
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
  CircuitBreaker,
  CircuitBreakerRegistry,
  defaultCircuitRegistry,
} from './circuitBreaker.js'

export {
  INLINE_THINK_TAG_PAIRS,
  InlineThinkSplitter,
  splitLeadingThinkBlock,
} from './inlineThink.js'

export {
  MAX_THINKING_BUDGET,
  MAX_TOKENS_VALUE,
  MIN_MAX_TOKENS_FOR_BUDGET,
  DEFAULT_RECTIFIER_CONFIG,
  OPENAI_REASONING_ITEM_PREFIX,
  shouldRectifyThinkingSignature,
  rectifyAnthropicRequest,
  rectifyPiMessages,
  shouldRectifyThinkingBudget,
  rectifyThinkingBudget,
  sanitizeReasoningItem,
  reasoningSummaryText,
  encodeOpenAIReasoningItem,
  decodeOpenAIReasoningItem,
  anthropicBlockFromOpenAIReasoningItem,
  openAIReasoningItemFromAnthropicBlock,
} from './rectifier.js'

export {
  DEFAULT_OPTIMIZER_CONFIG,
  countExistingCacheBreakpoints,
  injectCacheBreakpoints,
} from './cacheInjector.js'

export {
  ONE_M_CONTEXT_MARKER,
  PI_THINKING_LEVELS,
  PI_THINKING_PROFILES,
  PI_MODEL_CATALOG,
  stripOneMSuffix,
  stripOneMSuffixFromBody,
  ModelMapping,
  applyModelMapping,
  lookupPiModelCapabilities,
  isPiThinkingLevelMap,
} from './modelMapper.js'

export {
  SYSTEM_PROMPT,
  historyFromTurns,
  createLLMRouter,
  runTurn,
  diagnosisPrompt,
} from './router.js'

export {
  loadPi,
  loadPiProvider,
  warmPi,
  resolveConfiguredModelId,
  remoteModel,
  localModel,
  remoteStreamFn,
  litertStreamFn,
  toAgentTools,
  runPiTurn,
} from './pi.js'

export {
  buildRunners,
  maybePreloadLocal,
  localStream,
} from './engines.js'

export {
  bridgeHealthy,
  bridgeTurn,
} from './bridge.js'

export {
  getLocalStatus,
  onLocalStatus,
  localReady,
  ensureLocal,
} from './litert.js'

export {
  makeWorkspaceTools,
} from './tools.js'
