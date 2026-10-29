// Streaming & non-streaming inline <think> / <thinking> block splitter
// (ported from farion1231/cc-switch src-tauri/src/proxy/providers/inline_think.rs).
//
// Many OpenAI-compatible and local models (DeepSeek, MiniMax, Qwen, Gemma/LiteRT, Ollama/vLLM)
// emit reasoning inline at the start of `content` wrapped in `<think>...</think>` or
// `<thinking>...</thinking>`.
//
// `InlineThinkSplitter` is a chunk-boundary-invariant state machine (`Detecting` -> `Reasoning` -> `Text`):
// - `Detecting`: holds back a prefix that could still complete an opening `<think>` or `<thinking>` tag.
// - `Reasoning`: immediately emits reasoning deltas while holding back only the shortest tail that could
//   be a prefix of a closing tag (`</think>` or `</thinking>`) plus adjacent newline separators.
// - `Text`: streams visible answer text straight through.
// - Tolerates mismatched open/close pairs (e.g. `<think>... </thinking>`) so a mismatched tag never
//   swallows the entire response into reasoning.

export const INLINE_THINK_TAG_PAIRS = Object.freeze([
  ['<think>', '</think>'],
  ['<thinking>', '</thinking>'],
])

const THINK_SEPARATOR_RE_START = /^[\r\n]+/
const THINK_SEPARATOR_RE_END = /[\r\n]+$/

function trimStartSeparators(s) {
  return s.replace(THINK_SEPARATOR_RE_START, '')
}

function trimEndSeparators(s) {
  return s.replace(THINK_SEPARATOR_RE_END, '')
}

function trimBothSeparators(s) {
  return trimEndSeparators(trimStartSeparators(s))
}

function leadingThinkPrefixDecision(buffer) {
  const trimmed = buffer.trimStart()
  if (!trimmed) return 'need_more'

  for (const [openTag] of INLINE_THINK_TAG_PAIRS) {
    if (trimmed.startsWith(openTag)) return 'reasoning'
  }
  for (const [openTag] of INLINE_THINK_TAG_PAIRS) {
    if (openTag.startsWith(trimmed)) return 'need_more'
  }
  return 'text'
}

function stripLeadingThinkOpenTag(text) {
  const afterWs = text.trimStart()
  for (const [openTag] of INLINE_THINK_TAG_PAIRS) {
    if (afterWs.startsWith(openTag)) {
      return afterWs.slice(openTag.length)
    }
  }
  return null
}

function findThinkCloseTag(text) {
  let best = null
  for (const [, closeTag] of INLINE_THINK_TAG_PAIRS) {
    const idx = text.indexOf(closeTag)
    if (idx !== -1 && (best === null || idx < best.index)) {
      best = { index: idx, closeTag }
    }
  }
  return best
}

function reasoningHoldbackLen(buffer) {
  let partialCloseTag = 0
  for (const [, closeTag] of INLINE_THINK_TAG_PAIRS) {
    for (let len = closeTag.length - 1; len >= 1; len--) {
      if (buffer.endsWith(closeTag.slice(0, len))) {
        if (len > partialCloseTag) partialCloseTag = len
        break
      }
    }
  }
  const body = buffer.slice(0, buffer.length - partialCloseTag)
  const trimmedBody = trimEndSeparators(body)
  return buffer.length - trimmedBody.length
}

function nonEmpty(text) {
  return text && text.length > 0 ? text : null
}

/**
 * Non-streaming helper: splits a leading `<think>...</think>` or `<thinking>...</thinking>`
 * block into `{ thinking, text }`. Returns `null` if the text does not start with a closed think block.
 */
export function splitLeadingThinkBlock(text) {
  if (typeof text !== 'string') return null
  const body = stripLeadingThinkOpenTag(text)
  if (body === null) return null
  const close = findThinkCloseTag(body)
  if (!close) return null
  const thinking = trimBothSeparators(body.slice(0, close.index))
  const answer = trimStartSeparators(body.slice(close.index + close.closeTag.length))
  return { thinking, text: answer }
}

export class InlineThinkSplitter {
  constructor() {
    this.mode = 'detecting' // 'detecting' | 'reasoning' | 'text'
    this.buffer = ''
    this.stripSeparator = false
  }

  /**
   * Feed one content delta into the state machine.
   * Returns `{ thinking: string | null, text: string | null }`.
   */
  push(delta) {
    if (!delta) return { thinking: null, text: null }

    if (this.mode === 'text') {
      return { thinking: null, text: this._pushText(delta) }
    }

    if (this.mode === 'detecting') {
      this.buffer += delta
      const decision = leadingThinkPrefixDecision(this.buffer)
      if (decision === 'need_more') {
        return { thinking: null, text: null }
      }
      if (decision === 'reasoning') {
        this.mode = 'reasoning'
        this.stripSeparator = true
        this.buffer = stripLeadingThinkOpenTag(this.buffer) ?? ''
        return this._drainReasoning()
      }
      this.mode = 'text'
      const text = this.buffer
      this.buffer = ''
      return { thinking: null, text: nonEmpty(text) }
    }

    // mode === 'reasoning'
    this.buffer += delta
    return this._drainReasoning()
  }

  _pushText(delta) {
    if (!this.stripSeparator) {
      return nonEmpty(delta)
    }
    const rest = trimStartSeparators(delta)
    if (!rest) {
      return null
    }
    this.stripSeparator = false
    return rest
  }

  _drainReasoning() {
    if (this.stripSeparator) {
      const rest = trimStartSeparators(this.buffer)
      this.buffer = rest
      if (!this.buffer) {
        return { thinking: null, text: null }
      }
      this.stripSeparator = false
    }

    const close = findThinkCloseTag(this.buffer)
    if (close) {
      const buffered = this.buffer
      this.buffer = ''
      this.mode = 'text'
      this.stripSeparator = true
      const thinking = nonEmpty(trimEndSeparators(buffered.slice(0, close.index)))
      const text = this._pushText(buffered.slice(close.index + close.closeTag.length))
      return { thinking, text }
    }

    const holdback = reasoningHoldbackLen(this.buffer)
    const splitAt = this.buffer.length - holdback
    const thinking = this.buffer.slice(0, splitAt)
    this.buffer = this.buffer.slice(splitAt)
    return { thinking: nonEmpty(thinking), text: null }
  }

  /**
   * Flush any held-back tail at stream end / tool boundary / EOF. Idempotent.
   * Unclosed think blocks flush as `thinking` so reasoning is never lost;
   * incomplete opening tags in `detecting` flush as `text`.
   */
  flush() {
    const buffered = this.buffer
    this.buffer = ''
    const wasReasoning = this.mode === 'reasoning'
    this.mode = 'text'
    this.stripSeparator = false
    if (wasReasoning) {
      return { thinking: nonEmpty(buffered), text: null }
    }
    return { thinking: null, text: nonEmpty(buffered) }
  }

  hasPendingContent() {
    return this.buffer.trim().length > 0
  }
}
