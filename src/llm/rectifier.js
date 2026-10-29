// Multi-turn Thinking Signature & Thinking Budget Rectifiers + Cross-Protocol Reasoning Bridge
// (ported from farion1231/cc-switch:
//   - src-tauri/src/proxy/thinking_rectifier.rs
//   - src-tauri/src/proxy/thinking_budget_rectifier.rs
//   - src-tauri/src/proxy/providers/reasoning_bridge.rs)
//
// Zero runtime dependencies. Works on both raw Anthropic/OpenAI JSON payloads (`rectifyAnthropicRequest`,
// `rectifyThinkingBudget`) and `pi` (`@mariozechner/pi-ai`) message histories (`rectifyPiMessages`).

export const MAX_THINKING_BUDGET = 32000
export const MAX_TOKENS_VALUE = 64000
export const MIN_MAX_TOKENS_FOR_BUDGET = MAX_THINKING_BUDGET + 1

export const DEFAULT_RECTIFIER_CONFIG = Object.freeze({
  enabled: true,
  requestThinkingSignature: true,
  requestThinkingBudget: true,
})

export const OPENAI_REASONING_ITEM_PREFIX = 'ccswitch-openai-reasoning-v1:'
const REPLAYABLE_REASONING_FIELDS = ['type', 'id', 'summary', 'encrypted_content']

/**
 * Detect whether an upstream provider error was caused by an invalid/mismatched thinking signature
 * or thinking/tool_use block ordering constraint across turns (7 distinct failure scenarios from cc-switch).
 */
export function shouldRectifyThinkingSignature(errorMessage, config = DEFAULT_RECTIFIER_CONFIG) {
  const cfg = { ...DEFAULT_RECTIFIER_CONFIG, ...config }
  if (!cfg.enabled || !cfg.requestThinkingSignature) return false
  if (!errorMessage || typeof errorMessage !== 'string') return false

  const lower = errorMessage.toLowerCase()

  // Scenario 1: Invalid 'signature' in 'thinking' block
  if (
    lower.includes('invalid') &&
    lower.includes('signature') &&
    lower.includes('thinking') &&
    lower.includes('block')
  ) {
    return true
  }

  // Scenario 1b: Gemini / 3rd-party gateway "Thought signature is not valid"
  if (
    lower.includes('thought signature') &&
    (lower.includes('not valid') || lower.includes('invalid'))
  ) {
    return true
  }

  // Scenario 2: Assistant message must start with a thinking block
  if (lower.includes('must start with a thinking block')) {
    return true
  }

  // Scenario 3: Expected `thinking` or `redacted_thinking`, but found `tool_use`
  if (
    lower.includes('expected') &&
    (lower.includes('thinking') || lower.includes('redacted_thinking')) &&
    lower.includes('found') &&
    lower.includes('tool_use')
  ) {
    return true
  }

  // Scenario 4: signature: Field required
  if (lower.includes('signature') && lower.includes('field required')) {
    return true
  }

  // Scenario 5: xxx.signature: Extra inputs are not permitted
  if (lower.includes('signature') && lower.includes('extra inputs are not permitted')) {
    return true
  }

  // Scenario 6: thinking or redacted_thinking blocks cannot be modified
  if (
    (lower.includes('thinking') || lower.includes('redacted_thinking')) &&
    lower.includes('cannot be modified')
  ) {
    return true
  }

  // Scenario 7: Illegal / invalid request fallback
  if (
    lower.includes('非法请求') ||
    lower.includes('illegal request') ||
    lower.includes('invalid request')
  ) {
    return true
  }

  return false
}

function shouldRemoveTopLevelThinking(body, messages) {
  const thinkingType = body?.thinking?.type
  if (thinkingType !== 'enabled') return false

  const lastAssistant = [...(messages || [])].reverse().find((m) => m?.role === 'assistant')
  const content = Array.isArray(lastAssistant?.content) ? lastAssistant.content : null
  if (!content || content.length === 0) return false

  const firstBlockType = content[0]?.type
  const missingThinkingPrefix = firstBlockType !== 'thinking' && firstBlockType !== 'redacted_thinking'
  if (!missingThinkingPrefix) return false

  return content.some((b) => b?.type === 'tool_use' || b?.type === 'toolCall')
}

/**
 * Rectify an Anthropic-format request body in place (or return a rectified clone if needed):
 * - Removes `thinking` and `redacted_thinking` blocks from `messages[*].content`
 * - Removes orphaned `signature` fields from non-thinking content blocks
 * - Removes top-level `thinking` when `thinking.type === 'enabled'` and the last assistant
 *   turn has `tool_use` without a leading thinking block.
 */
export function rectifyAnthropicRequest(body) {
  const result = {
    applied: false,
    removedThinkingBlocks: 0,
    removedRedactedThinkingBlocks: 0,
    removedSignatureFields: 0,
  }

  if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) {
    return result
  }

  for (const msg of body.messages) {
    if (!Array.isArray(msg?.content)) continue

    const newContent = []
    let contentModified = false

    for (const block of msg.content) {
      const bType = block?.type
      if (bType === 'thinking') {
        result.removedThinkingBlocks += 1
        contentModified = true
        continue
      }
      if (bType === 'redacted_thinking') {
        result.removedRedactedThinkingBlocks += 1
        contentModified = true
        continue
      }
      if (block && typeof block === 'object' && ('signature' in block || 'thinkingSignature' in block)) {
        const clone = { ...block }
        delete clone.signature
        delete clone.thinkingSignature
        result.removedSignatureFields += 1
        contentModified = true
        newContent.push(clone)
        continue
      }
      newContent.push(block)
    }

    if (contentModified) {
      result.applied = true
      msg.content = newContent
    }
  }

  if (shouldRemoveTopLevelThinking(body, body.messages)) {
    delete body.thinking
    result.applied = true
  }

  return result
}

/**
 * Sanitize a `pi` (`@mariozechner/pi-ai`) message transcript when switching providers or retrying
 * after a thinking-signature rejection. Strips `thinking` / `redacted_thinking` content parts and
 * orphaned signatures while preserving all text and tool call blocks.
 */
export function rectifyPiMessages(messages = []) {
  let applied = false
  const cleaned = messages.map((m) => {
    if (!m || typeof m !== 'object') return m
    if (!Array.isArray(m.content)) return m
    let modified = false
    const nextContent = []
    for (const part of m.content) {
      if (part?.type === 'thinking' || part?.type === 'redacted_thinking') {
        modified = true
        continue
      }
      if (part && typeof part === 'object' && ('signature' in part || 'thinkingSignature' in part)) {
        const copy = { ...part }
        delete copy.signature
        delete copy.thinkingSignature
        modified = true
        nextContent.push(copy)
        continue
      }
      nextContent.push(part)
    }
    if (!modified) return m
    applied = true
    return {
      ...m,
      content: nextContent.length ? nextContent : [{ type: 'text', text: '' }],
    }
  })
  return { messages: cleaned, applied }
}

/**
 * Detect whether an upstream provider error was caused by an Anthropic `thinking.budget_tokens >= 1024`
 * constraint violation.
 */
export function shouldRectifyThinkingBudget(errorMessage, config = DEFAULT_RECTIFIER_CONFIG) {
  const cfg = { ...DEFAULT_RECTIFIER_CONFIG, ...config }
  if (!cfg.enabled || !cfg.requestThinkingBudget) return false
  if (!errorMessage || typeof errorMessage !== 'string') return false

  const lower = errorMessage.toLowerCase()
  const hasBudgetRef = lower.includes('budget_tokens') || lower.includes('budget tokens')
  const hasThinkingRef = lower.includes('thinking')
  const has1024Constraint =
    lower.includes('greater than or equal to 1024') ||
    lower.includes('>= 1024') ||
    (lower.includes('1024') && lower.includes('input should be'))

  return hasBudgetRef && hasThinkingRef && has1024Constraint
}

function snapshotBudget(body) {
  return {
    maxTokens: typeof body?.max_tokens === 'number' ? body.max_tokens : null,
    thinkingType: typeof body?.thinking?.type === 'string' ? body.thinking.type : null,
    thinkingBudgetTokens: typeof body?.thinking?.budget_tokens === 'number' ? body.thinking.budget_tokens : null,
  }
}

/**
 * Rectify an Anthropic request body's `thinking.budget_tokens` and `max_tokens`:
 * - Skips `adaptive` thinking requests
 * - Sets `thinking.type = 'enabled'` and `thinking.budget_tokens = 32000`
 * - Ensures `max_tokens >= 32001` (sets to `64000` if smaller or missing)
 */
export function rectifyThinkingBudget(body) {
  const before = snapshotBudget(body)
  if (!body || typeof body !== 'object' || before.thinkingType === 'adaptive') {
    return { applied: false, before, after: { ...before } }
  }

  if (!body.thinking || typeof body.thinking !== 'object' || Array.isArray(body.thinking)) {
    body.thinking = {}
  }

  body.thinking.type = 'enabled'
  body.thinking.budget_tokens = MAX_THINKING_BUDGET

  if (before.maxTokens === null || before.maxTokens < MIN_MAX_TOKENS_FOR_BUDGET) {
    body.max_tokens = MAX_TOKENS_VALUE
  }

  const after = snapshotBudget(body)
  const applied =
    before.maxTokens !== after.maxTokens ||
    before.thinkingType !== after.thinkingType ||
    before.thinkingBudgetTokens !== after.thinkingBudgetTokens

  return { applied, before, after }
}

// ---- Cross-Protocol Reasoning Bridge (OpenAI Responses <-> Anthropic Messages) ----

function toBase64Url(str) {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(str, 'utf8').toString('base64url')
  }
  const bytes = new TextEncoder().encode(str)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(b64url) {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(b64url, 'base64url').toString('utf8')
  }
  const padded = b64url.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64url.length + 3) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

export function sanitizeReasoningItem(item) {
  if (!item || typeof item !== 'object') return {}
  const out = {}
  for (const field of REPLAYABLE_REASONING_FIELDS) {
    if (field in item && item[field] !== undefined) {
      out[field] = item[field]
    }
  }
  return out
}

export function reasoningSummaryText(item) {
  if (!Array.isArray(item?.summary)) return ''
  return item.summary
    .filter((p) => (p?.type === 'summary_text' || p?.type === 'reasoning_text') && typeof p.text === 'string')
    .map((p) => p.text)
    .join('')
}

export function encodeOpenAIReasoningItem(item) {
  if (item?.type !== 'reasoning') return null
  try {
    const jsonStr = JSON.stringify(sanitizeReasoningItem(item))
    return `${OPENAI_REASONING_ITEM_PREFIX}${toBase64Url(jsonStr)}`
  } catch {
    return null
  }
}

export function decodeOpenAIReasoningItem(encoded) {
  if (typeof encoded !== 'string' || !encoded.startsWith(OPENAI_REASONING_ITEM_PREFIX)) return null
  const payload = encoded.slice(OPENAI_REASONING_ITEM_PREFIX.length)
  try {
    const item = JSON.parse(fromBase64Url(payload))
    return item?.type === 'reasoning' ? sanitizeReasoningItem(item) : null
  } catch {
    return null
  }
}

export function anthropicBlockFromOpenAIReasoningItem(item) {
  if (item?.type !== 'reasoning') return null
  const text = reasoningSummaryText(item)
  const hasEncrypted = typeof item.encrypted_content === 'string' && item.encrypted_content.length > 0
  if (hasEncrypted) {
    const envelope = encodeOpenAIReasoningItem(item)
    if (!envelope) return null
    return {
      type: 'thinking',
      thinking: text,
      signature: envelope,
    }
  }
  return text ? { type: 'thinking', thinking: text } : null
}

export function openAIReasoningItemFromAnthropicBlock(block) {
  if (!block || typeof block !== 'object') return null
  if (block.type === 'thinking' && typeof block.signature === 'string') {
    return decodeOpenAIReasoningItem(block.signature)
  }
  if (block.type === 'redacted_thinking' && typeof block.data === 'string') {
    return decodeOpenAIReasoningItem(block.data)
  }
  return null
}

// ---- Responses Opaque State Rectifier (ported from opaque_state_rectifier.rs) ----

export const ENCRYPTED_FUNCTION_OUTPUT_REJECTION =
  'Encrypted function output content could not be decrypted or decoded.'
export const ENCRYPTED_PART_PLACEHOLDER = '[encrypted content omitted]'

function isForeignResourceRejection(msg) {
  return typeof msg === 'string' && msg.includes('created under a different') && msg.includes('resource')
}

function isOpaqueRejectionMessage(msg) {
  if (typeof msg !== 'string') return false
  return (
    (msg.startsWith('The encrypted content') && msg.includes('could not be verified')) ||
    (msg.includes('was not issued to this caller') &&
      (msg.includes('encrypted_content') || msg.includes('reasoning'))) ||
    (msg.includes("Invalid 'input[") && msg.includes('Expected an ID that begins with')) ||
    (msg.includes('not found') && msg.includes('Items are not persisted when')) ||
    isForeignResourceRejection(msg)
  )
}

function stripMismatchedItemId(item, itemType) {
  if (!item || typeof item !== 'object' || typeof item.id !== 'string') return false
  const id = item.id
  const expectedPrefix =
    itemType === 'message' ? 'msg_' :
    itemType === 'function_call' ? 'fc_' :
    itemType === 'function_call_output' ? 'fco_' :
    itemType === 'reasoning' ? 'rs_' : null
  if (expectedPrefix && !id.startsWith(expectedPrefix)) {
    delete item.id
    return true
  }
  return false
}

/**
 * Detect whether an upstream OpenAI Responses error was caused by opaque state (`encrypted_content`,
 * foreign `id` prefixes like MiniMax's `070ff2_msg_3`, or Azure cross-resource item IDs).
 */
export function detectOpaqueStateRejection(errorMessageOrPayload, config = DEFAULT_RECTIFIER_CONFIG) {
  const cfg = { ...DEFAULT_RECTIFIER_CONFIG, ...config }
  if (!cfg.enabled) return null
  if (!errorMessageOrPayload) return null

  const text = typeof errorMessageOrPayload === 'string'
    ? errorMessageOrPayload
    : JSON.stringify(errorMessageOrPayload)

  let parsed = typeof errorMessageOrPayload === 'object' ? errorMessageOrPayload : null
  if (!parsed) {
    try { parsed = JSON.parse(text) } catch { parsed = null }
  }

  const messages = [
    parsed?.error?.message,
    parsed?.message,
    typeof parsed?.error === 'string' ? parsed.error : null,
    parsed?.detail,
    text,
  ].filter((m) => typeof m === 'string')

  const isCoded =
    parsed?.error?.code === 'invalid_encrypted_content' ||
    (parsed?.code === 'invalid-argument' &&
      typeof parsed?.error === 'string' &&
      (parsed.error.startsWith('Could not decode the compaction blob') ||
        parsed.error.startsWith('Could not decrypt the provided encrypted_content')))

  const isMsgMatch =
    text.trim() === ENCRYPTED_FUNCTION_OUTPUT_REJECTION ||
    messages.includes(ENCRYPTED_FUNCTION_OUTPUT_REJECTION) ||
    messages.some(isOpaqueRejectionMessage)

  if (!isCoded && !isMsgMatch) return null

  return {
    reasoning: true,
    compaction: messages.some((m) => m.includes('compaction')),
    itemIds: messages.some(isForeignResourceRejection),
  }
}

/**
 * Rectify an OpenAI Responses `body.input` array in place by removing un-verifiable `reasoning`
 * items, replacing `encrypted_content` parts in `function_call_output` / historical `agent_message`
 * items with `[encrypted content omitted]`, and stripping foreign/cross-resource item IDs while
 * preserving `call_id` linkage.
 */
export function rectifyOpaqueState(body, rejection = { reasoning: true, compaction: false, itemIds: false }) {
  const result = {
    applied: false,
    removedReasoningItems: 0,
    replacedEncryptedParts: 0,
    removedForeignIds: 0,
  }
  if (!body || typeof body !== 'object' || !Array.isArray(body.input)) {
    return result
  }

  const replaceEncryptedInArray = (arr) => {
    if (!Array.isArray(arr)) return 0
    let count = 0
    for (let i = 0; i < arr.length; i++) {
      const part = arr[i]
      if (part?.type === 'encrypted_content' && part.encrypted_content) {
        arr[i] = { type: 'input_text', text: ENCRYPTED_PART_PLACEHOLDER }
        count += 1
      }
    }
    return count
  }

  const rectified = []
  for (let i = 0; i < body.input.length; i++) {
    const item = body.input[i]
    if (!item || typeof item !== 'object') {
      rectified.push(item)
      continue
    }
    const itemType = item.type || ''
    if (itemType === 'reasoning' && rejection.reasoning) {
      result.removedReasoningItems += 1
      continue
    }
    const clone = { ...item }
    if ((itemType === 'function_call_output' || itemType === 'custom_tool_call_output') && rejection.reasoning) {
      if (Array.isArray(clone.output)) {
        clone.output = [...clone.output]
        result.replacedEncryptedParts += replaceEncryptedInArray(clone.output)
      }
    }
    if (itemType === 'agent_message' && rejection.reasoning && i < body.input.length - 1) {
      if (Array.isArray(clone.content)) {
        clone.content = [...clone.content]
        result.replacedEncryptedParts += replaceEncryptedInArray(clone.content)
      }
    }
    if (rejection.itemIds && itemType !== 'item_reference' && 'id' in clone) {
      delete clone.id
      result.removedForeignIds += 1
    } else if (rejection.reasoning && stripMismatchedItemId(clone, itemType)) {
      result.removedForeignIds += 1
    }
    rectified.push(clone)
  }

  body.input = rectified
  result.applied =
    result.removedReasoningItems + result.replacedEncryptedParts + result.removedForeignIds > 0
  return result
}

