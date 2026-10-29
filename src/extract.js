// Grounded multi-resolution extraction & dynamic epoch segmentation.
// Modeled on google/langextract: every extracted entity/symbol/file/decision carries
// exact character offsets [start, end) into the source turn text so the UI can
// highlight grounded spans in-place, filter by hot words, and compress turns across Z0-Z3.

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'only', 'have', 'has',
  'are', 'was', 'were', 'will', 'would', 'should', 'could', 'before', 'after', 'until',
  'when', 'where', 'what', 'who', 'why', 'how', 'all', 'any', 'some', 'every', 'other',
  'more', 'most', 'less', 'least', 'than', 'then', 'them', 'they', 'their', 'there',
  'here', 'over', 'under', 'across', 'through', 'between', 'without', 'within',
  'about', 'against', 'during', 'first', 'second', 'third', 'next', 'last', 'now',
  'done', 'complete', 'running', 'queued', 'blocked', 'spawned', 'worker', 'workers',
  'turn', 'turns', 'epoch', 'epochs', 'file', 'files', 'line', 'lines', 'code', 'test',
  'tests', 'suite', 'suites', 'pass', 'passed', 'green', 'check', 'checked', 'checking',
  'read', 'write', 'written', 'edit', 'edited', 'patch', 'patched', 'survey', 'surveyed',
  'make', 'made', 'keep', 'kept', 'stay', 'stays', 'need', 'needs', 'want', 'wants',
  'use', 'used', 'using', 'call', 'calls', 'called', 'caller', 'callers', 'path', 'paths',
  'one', 'two', 'three', 'four', 'five', 'six', 'new', 'old', 'clean', 'full', 'open',
  'true', 'false', 'null', 'none', 'nothing', 'everything', 'anything', 'something',
  'also', 'just', 'like', 'still', 'even', 'back', 'down', 'well', 'good', 'work',
  'working', 'works', 'used', 'user', 'users', 'folder', 'directory', 'current',
])

const IGNORED_UPPER_SYMBOLS = new Set([
  'YOU', 'TURN', 'NOW', 'THU', 'FRI', 'MON', 'TUE', 'WED', 'SAT', 'SUN',
  'PASS', 'FAIL', 'RUN', 'YES', 'NO', 'THE', 'AND', 'FOR', 'WITH', 'THIS',
  'THAT', 'FROM', 'INTO', 'NOT', 'ALL', 'ARE', 'WAS', 'WERE', 'BUT', 'CAN',
  'OUT', 'USE', 'NEW', 'OLD', 'ONE', 'TWO', 'GET', 'SET', 'PUT', 'END',
  'TODO', 'NOTE', 'INFO', 'WARN', 'TRUE', 'FALSE', 'NULL', 'NONE', 'HTTP', 'HTTPS',
])

const DECISION_PHRASES = [
  'RS256 only',
  'HS fallback rejected',
  'fail-open by silence',
  'fail-open',
  'fail closed',
  'fail-closed',
  'Strict DPoP + PCR0',
  'strict DPoP + PCR0',
  'write-new-then-retire',
  'write-then-retire',
  'no silent nulls',
  'downgrade path',
  'reachability-checked',
]

const KNOWN_TECH_TOKENS = [
  'PKCS#11',
  'RSA-2048',
  'PCR0_STRICT',
  'PCR0',
  'DPoP',
  'RS256',
  'HS256',
  'ES256',
  'JWT',
  'Keychain',
  'SIEM',
  'AST',
  'LiteRT-LM',
  'ExecuTorch',
  'PyTorch',
  'MobileNet',
  'Qualcomm',
  'VENTUNO',
  'QNN',
  'NPU',
  'ADB',
  'ONNX',
]

const FILLER_OPENER_RE = /^(?:I['’]ll|I['’]m|I\s+will|I\s+am|Let\s+me|Sure\b|Okay\b|Alright\b|Now\s+I['’]ll|Next\s+I['’]ll)\b/i

// Fast bounded memoization cache for extractTurnSpans and enrichTurn
const SPAN_CACHE = new Map()
const MAX_SPAN_CACHE = 2500
let ENRICH_CACHE = new WeakMap()

function workspaceKey(workspace) {
  if (!workspace) return '0:0'
  const fLen = workspace.files?.length || 0
  const csLen = workspace.changeSets?.length || 0
  return `${fLen}:${csLen}`
}

/**
 * Clean Codex / Markdown / XML wrapper noise from a line before displaying in compact Z1/Z2 summaries.
 */
export function cleanDisplayText(raw) {
  let s = String(raw || '').trim()
  if (!s) return ''
  // Unwrap Codex <send_user_message_question_reply> JSON payloads
  if (s.includes('<send_user_message_question_reply>')) {
    const m = /"answer"\s*:\s*"([^"]+)"/.exec(s)
    if (m) s = m[1]
    else s = s.replace(/<\/?send_user_message_question_reply>/g, '').trim()
  }
  // Strip <image ...>...</image> and other XML tags
  s = s.replace(/<image\b[^>]*>[\s\S]*?<\/image>/gi, '')
  s = s.replace(/<\/?[a-zA-Z_][a-zA-Z0-9_.-]*(?:\s+[^>]*)?>/g, ' ')
  // Convert markdown links [label](url) -> label
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
  // Strip markdown emphasis / headings / inline code ticks
  s = s.replace(/(\*\*|__|`)/g, '')
  s = s.replace(/^#+\s+/gm, '')
  s = s.replace(/\s+/g, ' ').trim()
  return s
}

/**
 * Clip text cleanly at a word boundary so Z1/Z2 summaries never chop mid-word.
 */
function clipWords(str, maxLen = 56) {
  const clean = String(str || '').trim()
  if (clean.length <= maxLen) return clean
  const slice = clean.slice(0, maxLen - 1)
  const lastSpace = slice.lastIndexOf(' ')
  const cut = lastSpace >= Math.floor(maxLen * 0.55) ? slice.slice(0, lastSpace) : slice
  return `${cut.replace(/[,:;—–-]+$/, '').trim()}…`
}

/**
 * Extract character-grounded spans from `text`.
 * Every span satisfies: `text.slice(span.start, span.end) === span.text`.
 */
export function extractTurnSpans(text, workspace = {}) {
  const src = String(text || '')
  if (!src) return []

  const cacheKey = `${workspaceKey(workspace)}::${src}`
  const cached = SPAN_CACHE.get(cacheKey)
  if (cached) return cached

  const knownFiles = new Set((workspace.files || []).map((f) => f.name))
  const changeSetFiles = new Set(
    (workspace.changeSets || []).flatMap((cs) => (cs.files || []).map((f) => f.name))
  )

  const candidates = []

  const pushCandidate = (start, end, kind, key, target, priority) => {
    if (start < 0 || end <= start || end > src.length) return
    const raw = src.slice(start, end)
    candidates.push({ start, end, text: raw, kind, cls: kind, key, label: key, target, priority })
  }

  // 1. File and file:line references (highest priority: 40)
  const fileRe = /\b([A-Za-z0-9_.-]+\.(?:kt|kts|js|jsx|mjs|cjs|ts|tsx|py|swift|cs|md|json|jsonl|css|html|sh|zsh|bash|cpp|cc|c|h|hpp|rs|go|java|gradle|toml|yaml|yml|sql|pte|onnx|tflite|plist|xml))(?::(\d+)(?:[–-](\d+))?)?\b/g
  for (const m of src.matchAll(fileRe)) {
    const fullMatch = m[0]
    const fileName = m[1]
    // Skip version-like numbers such as 0.1.0 or v1.2.c
    if (/^\d/.test(fileName) || fileName.length < 4) continue
    const lineNum = m[2] ? Number(m[2]) : undefined
    const start = m.index
    const end = start + fullMatch.length
    const inChangeSet = changeSetFiles.has(fileName)
    const inCollection = knownFiles.has(fileName)
    const target = inChangeSet
      ? { type: 'hunk', file: fileName, line: lineNum }
      : inCollection
        ? { type: 'file', file: fileName, line: lineNum }
        : { type: 'hotword', hotword: fileName }
    pushCandidate(start, end, 'file', fileName, target, 40)
  }

  // 2. Grounded architectural decision phrases & markers (priority: 35)
  for (const phrase of DECISION_PHRASES) {
    let idx = src.indexOf(phrase)
    while (idx !== -1) {
      const end = idx + phrase.length
      const canon = phrase.toLowerCase() === 'fail-closed' ? 'fail closed'
        : phrase.toLowerCase() === 'write-then-retire' ? 'write-new-then-retire'
        : phrase.toLowerCase() === 'strict dpop + pcr0' ? 'Strict DPoP + PCR0'
        : phrase
      pushCandidate(idx, end, 'decision', canon, { type: 'hotword', hotword: canon }, 35)
      idx = src.indexOf(phrase, end)
    }
  }
  const decMarkerRe = /\b(DECISION|INVARIANT|REJECTED|BLOCKED)\b/g
  for (const m of src.matchAll(decMarkerRe)) {
    const key = m[1]
    pushCandidate(m.index, m.index + m[0].length, 'decision', key, { type: 'hotword', hotword: key }, 34)
  }

  // 3. Explicit known crypto/protocol/system tokens (priority: 32)
  for (const tok of KNOWN_TECH_TOKENS) {
    const escaped = tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`(?<![\\w])${escaped}(?![\\w])`, 'g')
    for (const m of src.matchAll(re)) {
      pushCandidate(m.index, m.index + m[0].length, 'symbol', tok, { type: 'hotword', hotword: tok }, 32)
    }
  }

  // 4. Function calls like verifyToken(), getLegacy(), rotateKey(), verifyDpop(...) (priority: 30)
  const fnRe = /\b([a-zA-Z_][a-zA-Z0-9_]{2,})\(\)/g
  for (const m of src.matchAll(fnRe)) {
    const key = `${m[1]}()`
    pushCandidate(m.index, m.index + m[0].length, 'symbol', key, { type: 'hotword', hotword: key }, 30)
  }

  // 5. CamelCase / PascalCase / UPPER_SNAKE identifiers (priority: 28)
  const idRe = /\b(?:[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+|[A-Z]{2,}[A-Z0-9_]+)\b/g
  for (const m of src.matchAll(idRe)) {
    const word = m[0]
    if (word.length < 3 || word.length > 28) continue
    if (IGNORED_UPPER_SYMBOLS.has(word)) continue
    pushCandidate(m.index, m.index + word.length, 'symbol', word, { type: 'hotword', hotword: word }, 28)
  }

  // 6. Module / Gradle / Port targets like :9379, :nucleus-macos26:jvmTest, :ui:runComposeUiTest (priority: 26)
  const modRe = /(?:^|[\s(])(:[a-zA-Z0-9_:-]{2,})\b/g
  for (const m of src.matchAll(modRe)) {
    const mod = m[1]
    const offset = m.index + m[0].indexOf(mod)
    pushCandidate(offset, offset + mod.length, 'symbol', mod, { type: 'hotword', hotword: mod }, 26)
  }

  // 7. Metrics & deltas like +48 / −12, 29 suites green, 29/29 suites, 497 MB (priority: 20)
  const metricRe = /(?:\+\d+\s*\/\s*[−-]\d+|\b\d+(?:\s*\/\s*\d+)?\s+(?:suites?\s+green|suites?|tests?\s+passing|files?)\b|\b\d+(?:\.\d+)?\s*(?:MB|GB|tok\/s)\b)/g
  for (const m of src.matchAll(metricRe)) {
    pushCandidate(m.index, m.index + m[0].length, 'metric', m[0], { type: 'hotword', hotword: m[0] }, 20)
  }

  // Resolve overlaps: higher priority wins, then earlier start, then longer span
  candidates.sort((a, b) => (b.priority - a.priority) || (a.start - b.start) || ((b.end - b.start) - (a.end - a.start)))

  const accepted = []
  for (const c of candidates) {
    const overlaps = accepted.some((a) => c.start < a.end && c.end > a.start)
    if (!overlaps) {
      const { priority: _p, ...clean } = c
      accepted.push(clean)
    }
  }

  accepted.sort((a, b) => a.start - b.start)

  if (SPAN_CACHE.size >= MAX_SPAN_CACHE) {
    const firstKey = SPAN_CACHE.keys().next().value
    SPAN_CACHE.delete(firstKey)
  }
  SPAN_CACHE.set(cacheKey, accepted)
  return accepted
}

/**
 * Splits `text` into contiguous segments `[{ text, span }]` using grounded character offsets.
 * Invariant: `segments.map(s => s.text).join('') === String(text || '')`.
 */
export function segmentGroundedText(text, workspace = {}) {
  const src = String(text || '')
  if (!src) return []
  const spans = extractTurnSpans(src, workspace)
  if (!spans.length) return [{ text: src, span: null }]

  const out = []
  let cursor = 0
  for (const span of spans) {
    if (span.start > cursor) {
      out.push({ text: src.slice(cursor, span.start), span: null })
    }
    out.push({ text: src.slice(span.start, span.end), span })
    cursor = span.end
  }
  if (cursor < src.length) {
    out.push({ text: src.slice(cursor), span: null })
  }
  return out
}

/**
 * Canonical deduplicated text for a turn so we never scan identical strings 3x per turn.
 */
function canonicalTurnText(turn) {
  if (!turn) return ''
  const parts = new Set()
  if (turn.full) parts.add(turn.full)
  if (turn.synthesis && turn.synthesis !== turn.full) parts.add(turn.synthesis)
  if (turn.decision && !String(turn.full || '').includes(turn.decision)) parts.add(turn.decision)
  if (turn.summary && !String(turn.full || '').includes(turn.summary)) parts.add(turn.summary)
  if (turn.actor === 'user' && turn.intent && turn.intent !== turn.full) parts.add(turn.intent)
  return [...parts].join(' \n ')
}

/**
 * Aggregate the highest-salience grounded Hot Words across a turn collection.
 */
export function deriveHotWords(turns = [], workspace = {}, limit = 10) {
  const byKey = new Map()
  const KIND_WEIGHT = { file: 2.8, decision: 2.9, symbol: 2.1, metric: 1.3 }

  turns.forEach((t, idx) => {
    const turnIndex = typeof t.i === 'number' ? t.i : idx
    const text = canonicalTurnText(t)
    const spans = extractTurnSpans(text, workspace)
    const seenInTurn = new Set()
    for (const s of spans) {
      if (seenInTurn.has(s.key)) continue
      seenInTurn.add(s.key)
      let entry = byKey.get(s.key)
      if (!entry) {
        entry = {
          key: s.key,
          label: s.key,
          kind: s.kind,
          cls: s.kind,
          count: 0,
          turns: [],
          target: s.target,
          score: 0,
        }
        byKey.set(s.key, entry)
      }
      entry.count += 1
      entry.turns.push(turnIndex)
      entry.score += KIND_WEIGHT[s.kind] || 1
      if (s.kind === 'file' && entry.kind !== 'file') {
        entry.kind = 'file'
        entry.cls = 'file'
        entry.target = s.target
      }
    }
  })

  return [...byKey.values()]
    .sort((a, b) => (b.score - a.score) || (b.count - a.count) || a.key.localeCompare(b.key))
    .slice(0, limit)
}

/**
 * Check if a turn matches an active hot-word filter key.
 */
export function turnMatchesHotWord(turn, hotWordKey, workspace = {}) {
  if (!hotWordKey) return true
  const needle = String(hotWordKey).toLowerCase()
  const text = canonicalTurnText(turn)
  const spans = extractTurnSpans(text, workspace)
  if (spans.some((s) => s.key.toLowerCase() === needle)) return true
  if ((turn.artifacts || []).some((a) => String(a).toLowerCase() === needle)) return true
  return false
}

/**
 * Enrich a turn (live or seeded) with multi-resolution Z1/Z2/Z3 fields & grounded metadata:
 * - Classifies `kind` ('prompt' | 'decision' | 'mutation' | 'pty' | 'synthesis')
 * - Extracts `decision` sentence when an architectural rule/verdict is present
 * - Produces distinct `summary` (Z1 Col 2, <=56 chars), `synthesis` (Z1 Col 3), and `full` (Z3)
 * - Extracts referenced workspace `artifacts`
 */
export function enrichTurn(turn, workspace = {}) {
  if (!turn || typeof turn !== 'object') return turn
  const wsKey = workspaceKey(workspace)
  const cached = ENRICH_CACHE.get(turn)
  if (cached && cached.wsKey === wsKey) return cached.value

  const rawFull = String(turn.full || turn.synthesis || turn.intent || '').trim()
  if (!rawFull) return turn

  const spans = extractTurnSpans(rawFull, workspace)
  const cleanedFull = cleanDisplayText(rawFull)
  const sentences = cleanedFull
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4)

  // Score sentences so Z1 summary & Z1 synthesis skip conversational filler ("I'll check...")
  const scoredSentences = sentences.map((s, idx) => {
    const sSpans = extractTurnSpans(s, workspace)
    let score = sSpans.length * 2.2
    if (FILLER_OPENER_RE.test(s)) score -= 3.5
    if (/\b(decision|verified|installed|complete|blocked|failed|error|fixed|matches|downloaded|staged|passed|must|only|rejected|invariant)\b/i.test(s)) {
      score += 2.5
    }
    if (idx === 0 && !FILLER_OPENER_RE.test(s)) score += 1.0
    return { s, idx, score }
  })
  const bestSentences = [...scoredSentences].sort((a, b) => (b.score - a.score) || (a.idx - b.idx))

  // 1. Detect decision sentence if not already set
  let decision = turn.decision
  if (!decision && turn.actor !== 'user') {
    const decisionCandidate = bestSentences.find(({ s }) =>
      !FILLER_OPENER_RE.test(s) &&
      /\b(decision|rejected|must|only|fail-open|fail-closed|fail closed|strict|frozen|throws|never|invariant|blocked)\b/i.test(s)
    )
    if (decisionCandidate) {
      decision = clipWords(decisionCandidate.s.replace(/^decision:\s*/i, ''), 115)
    }
  }

  // 2. Classify turn.kind if not explicitly set
  let kind = turn.kind
  if (!kind) {
    if (turn.actor === 'user') {
      kind = 'prompt'
    } else if (decision) {
      kind = 'decision'
    } else if (/\b(hunks?|staged|rewritten|edited|wrote|added|deleted|patched|committed|\+\d+)/i.test(rawFull)) {
      kind = 'mutation'
    } else if ((turn.stdout || []).length > 0) {
      kind = 'pty'
    } else {
      kind = 'synthesis'
    }
  }

  // 3. Multi-resolution Z1 Col 3 synthesis (condensed 1-2 highest-salience sentences when `full` is long)
  let synthesis = turn.synthesis
  if ((!synthesis || synthesis === rawFull) && sentences.length > 2) {
    const topTwo = bestSentences
      .slice(0, 2)
      .sort((a, b) => a.idx - b.idx)
      .map((x) => x.s)
    synthesis = topTwo.join(' ')
  } else if (!synthesis) {
    synthesis = cleanedFull || rawFull
  }

  // 4. Telegraphic Z1 Col 2 summary (<= 56 chars, word-boundary clipped, filler-free)
  let summary = turn.summary
  const isNaiveSlice =
    !summary ||
    summary === 'working…' ||
    summary === rawFull.slice(0, 72) ||
    summary === `"${rawFull.slice(0, 52)}${rawFull.length > 52 ? '…' : ''}"`

  if (isNaiveSlice && turn.state !== 'running') {
    const topSymbols = [...new Set(spans.filter((s) => s.kind !== 'metric').map((s) => s.key))].slice(0, 2)
    const primarySentence = (decision || bestSentences[0]?.s || sentences[0] || cleanedFull)
      .replace(/^["']|["']$/g, '')
      .trim()

    if (turn.actor === 'user') {
      const clean = primarySentence.replace(/[.?!]+$/, '')
      summary = `"${clipWords(clean, 48)}"`
    } else if (topSymbols.length >= 1 && !primarySentence.startsWith(topSymbols[0]) && primarySentence.length > 44) {
      const clause = primarySentence.split(/[—:;]/)[0].trim()
      summary = clipWords(`${topSymbols[0]} · ${clause}`, 56)
    } else {
      summary = clipWords(primarySentence, 56)
    }
  }

  // 5. Auto-link file artifacts mentioned in the turn
  const detectedFiles = spans
    .filter((s) => s.kind === 'file')
    .map((s) => s.key)
  const artifacts = [...new Set([...(turn.artifacts || []), ...detectedFiles])]

  const enriched = {
    ...turn,
    kind,
    ...(decision ? { decision } : {}),
    summary: summary || turn.summary,
    synthesis,
    full: rawFull,
    artifacts,
  }
  ENRICH_CACHE.set(turn, { wsKey, value: enriched })
  return enriched
}

/**
 * Extract candidate hot-word tokens for an epoch slice.
 */
function sliceCandidateTokens(slice, workspace) {
  const hot = deriveHotWords(slice, workspace, 6)
  const tokenScores = new Map()

  for (const h of hot) {
    const clean = h.key
      .replace(/\(\)$/, '')
      .replace(/\.(kt|kts|md|js|jsx|ts|tsx|py|sh|cpp|c|h|json|yaml|yml|toml|swift|cs)$/i, '')
      .replace(/^:/, '')
      .toUpperCase()
    if (clean.length >= 2 && !IGNORED_UPPER_SYMBOLS.has(clean)) {
      tokenScores.set(clean, (tokenScores.get(clean) || 0) + h.score * 2.2)
    }
  }

  for (const t of slice) {
    const words = cleanDisplayText(t.summary || t.synthesis || t.intent || '')
      .replace(/[^a-zA-Z0-9_#-]+/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 3 && w.length <= 16 && !STOPWORDS.has(w.toLowerCase()))
    for (const w of words) {
      const up = w.toUpperCase()
      if (IGNORED_UPPER_SYMBOLS.has(up)) continue
      tokenScores.set(up, (tokenScores.get(up) || 0) + 1)
    }
  }

  return { hot, tokenScores }
}

/**
 * Compute Zune-style 1-2 word uppercase Hot-Word Headers across all slices using TF-IDF
 * so long 200-turn sessions get distinct, meaningful epoch titles instead of repeating the same global keyword.
 */
function buildEpochsFromSlices(slices, startEpochNum = 1, workspace = {}, usedNames = new Set()) {
  const sliceData = slices.map((slice) => sliceCandidateTokens(slice, workspace))
  const totalSlices = Math.max(1, slices.length)

  // Document frequency across slices
  const df = new Map()
  for (const { tokenScores } of sliceData) {
    for (const tok of tokenScores.keys()) {
      df.set(tok, (df.get(tok) || 0) + 1)
    }
  }

  return slices.map((slice, idx) => {
    const epochNum = startEpochNum + idx
    const { hot, tokenScores } = sliceData[idx]

    // Rank tokens by TF * IDF so slice-distinctive terms rise to the top
    const ranked = [...tokenScores.entries()]
      .map(([tok, tf]) => {
        const docFreq = df.get(tok) || 1
        const idf = Math.log(1 + totalSlices / docFreq) + 0.4
        return [tok, tf * idf]
      })
      .sort((a, b) => b[1] - a[1])

    let chosenName = `EPOCH ${epochNum}`
    for (const [cand] of ranked) {
      const clipped = cand.length > 14 ? cand.slice(0, 14) : cand
      if (!usedNames.has(clipped)) {
        chosenName = clipped
        break
      }
    }
    // If single top word was already used, combine top 2 words into a 2-word Zune header
    if (usedNames.has(chosenName) && ranked.length >= 2) {
      const w1 = ranked[0][0].slice(0, 8)
      for (let j = 1; j < Math.min(ranked.length, 6); j++) {
        const w2 = ranked[j][0].slice(0, 8)
        if (w1 !== w2) {
          const pair = `${w1} ${w2}`
          if (!usedNames.has(pair)) {
            chosenName = pair
            break
          }
        }
      }
    }
    usedNames.add(chosenName)

    const decisionTurn = slice.find((t) => t.decision || t.kind === 'decision')
    const firstTurn = slice[0] || {}
    const lastTurn = slice[slice.length - 1] || {}
    const rawSummary = decisionTurn?.decision
      || lastTurn.summary
      || lastTurn.synthesis
      || firstTurn.summary
      || firstTurn.intent
      || `${slice.length} turns in epoch`

    return {
      n: epochNum,
      name: chosenName,
      when: String(firstTurn.age || 'NOW').toUpperCase(),
      anchor: typeof firstTurn.i === 'number' ? firstTurn.i : 0,
      count: slice.length,
      summary: clipWords(cleanDisplayText(rawSummary), 115),
      hotWords: hot.slice(0, 3),
    }
  })
}

/**
 * Dynamic Hot-Word Epoch Segmentation.
 * - Preserves canonical seedEpochs on `board` when at default epoch config (everyTurns=15),
 *   while enriching each epoch with live turn counts and extracted `hotWords`, AND automatically
 *   mints new epochs (E07+) when additional turns are added or when `everyTurns` / `onCommit`
 *   in Settings Domain 04 slices the timeline more finely.
 * - For all other threads (`siem`, `e2e`, `auth`, 200-turn Codex imports, or user-created threads),
 *   dynamically segments turns into TF-IDF hot-word epochs so `[z]` Epoch Jump Grid and `Z3` Epoch Strip
 *   work fast and cleanly at any scale (from 4 turns to 200+ turns).
 */
export function deriveEpochs(turns = [], seedEpochs = [], epochConfig = {}, workspace = {}, threadId = 'board') {
  const everyTurns = Number(epochConfig?.everyTurns) || 15
  const onCommit = epochConfig?.onCommit !== false
  const indexed = turns.map((t, i) => ({ ...enrichTurn(t, workspace), i }))

  if (!indexed.length) {
    return [{
      n: 1,
      name: 'KICKOFF',
      when: 'NOW',
      anchor: 0,
      count: 0,
      summary: 'No turns recorded yet — press i to start.',
      hotWords: [],
    }]
  }

  const useSeededBase =
    threadId === 'board' &&
    Array.isArray(seedEpochs) &&
    seedEpochs.length > 0 &&
    everyTurns === 15

  if (useSeededBase) {
    const usedNames = new Set()
    const result = seedEpochs.map((ep) => {
      usedNames.add(ep.name)
      const bucket = indexed.filter((t) => t.epoch === ep.n)
      const hot = deriveHotWords(bucket, workspace, 3)
      return {
        ...ep,
        count: bucket.length,
        hotWords: hot,
      }
    })

    const unbucketed = indexed.filter((t) => !t.epoch || t.epoch > seedEpochs.length)
    if (unbucketed.length > 0) {
      const chunkSize = Math.max(2, everyTurns)
      const extraSlices = []
      for (let offset = 0; offset < unbucketed.length; offset += chunkSize) {
        extraSlices.push(unbucketed.slice(offset, offset + chunkSize))
      }
      result.push(...buildEpochsFromSlices(extraSlices, result.length + 1, workspace, usedNames))
    }
    return result
  }

  // Scale step size cleanly for both compact threads (<15 turns) and 200-turn marathon sessions
  const step = indexed.length >= everyTurns * 2
    ? everyTurns
    : everyTurns === 10
      ? Math.max(2, Math.ceil(indexed.length / 6))
      : everyTurns === 25
        ? Math.max(4, Math.ceil(indexed.length / 2))
        : Math.max(3, Math.ceil(indexed.length / 4))

  const minCommitLen = Math.max(2, Math.floor(step * 0.65))
  const slices = []
  let current = []

  for (const t of indexed) {
    current.push(t)
    const isCommitMutation =
      onCommit &&
      current.length >= minCommitLen &&
      (t.kind === 'mutation' || /\b(staged|commit|complete)\b/i.test(t.summary || ''))
    if (current.length >= step || isCommitMutation) {
      slices.push(current)
      current = []
    }
  }
  if (current.length > 0) {
    // Merge tiny trailing remainder (<2 turns) into the last epoch when we already have multiple epochs
    if (current.length === 1 && slices.length >= 2) {
      slices[slices.length - 1].push(...current)
    } else {
      slices.push(current)
    }
  }

  return buildEpochsFromSlices(slices, 1, workspace, new Set())
}

/**
 * Assign each turn in `turns` its resolved epoch number `epoch` based on `derivedEpochs`.
 */
export function assignTurnEpochs(turns = [], derivedEpochs = [], workspace = {}) {
  if (!turns.length) return []
  const sortedEpochs = [...derivedEpochs].sort((a, b) => a.anchor - b.anchor)
  return turns.map((t, i) => {
    const enriched = enrichTurn(t, workspace)
    let epNum = enriched.epoch || 1
    for (const ep of sortedEpochs) {
      if (i >= ep.anchor) epNum = ep.n
    }
    return { ...enriched, i, epoch: epNum }
  })
}
