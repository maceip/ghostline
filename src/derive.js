// Pure derivations: everything the hub/zoom/settings display is computed here
// from the live state store (agents, turns, changeSets, gate, policy).
// No narrative numbers — if it shows on screen, it traces to state.
// Unit-tested in tests/derive.test.mjs.

export function fmtTokens(n) {
  if (!n) return '0'
  return n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(Math.round(n))
}

export function parseCeiling(v) {
  if (typeof v === 'number') return v
  const m = /^([\d.]+)\s*([kKmM]?)$/.exec(String(v || '500k'))
  if (!m) return 500000
  const mult = m[2].toLowerCase() === 'm' ? 1e6 : m[2] ? 1e3 : 1
  return Math.round(parseFloat(m[1]) * mult)
}

export function fleetCounts(agents) {
  const c = { running: 0, verified: 0, queued: 0, blocked: 0 }
  for (const a of agents) {
    if (a.state === 'running') c.running++
    else if (a.state === 'complete') c.verified++
    else if (a.state === 'blocked') c.blocked++
    else c.queued++
  }
  return c
}

/** token velocity = the sum of the rates of whatever is actually running */
export function fleetVelocity(agents) {
  return agents.filter((a) => a.state === 'running').reduce((n, a) => n + (a.rate || 0), 0)
}

export function epochTurnCounts(turns) {
  const m = new Map()
  for (const t of turns) if (t.epoch) m.set(t.epoch, (m.get(t.epoch) || 0) + 1)
  return m
}

export function facetPartition(turns) {
  const ix = turns.map((t, i) => ({ ...t, i }))
  return {
    all: ix,
    prompts: ix.filter((t) => t.actor === 'user' || t.kind === 'prompt'),
    decisions: ix.filter((t) => t.kind === 'decision' || t.decision),
    mutations: ix.filter((t) => t.kind === 'mutation'),
    pty: ix.filter((t) => (t.stdout || []).length > 0),
    artifacts: ix.filter((t) => (t.artifacts || []).length > 0),
  }
}

export function changeSetForThread(thread, changeSets) {
  if (!thread) return null
  const base = thread.title.replace(/ (UI|Demo).*/i, '')
  return changeSets.find((cs) => cs.task === thread.title || cs.task.startsWith(base) || thread.title.startsWith(cs.task)) || null
}

export function changeSetTotals(cs) {
  if (!cs) return { adds: 0, dels: 0, files: 0, hunks: 0, unreviewed: 0 }
  let adds = 0, dels = 0, hunks = 0, unreviewed = 0
  for (const f of cs.files) {
    adds += f.adds; dels += f.dels; hunks += f.hunks.length
    unreviewed += f.hunks.filter((h) => h.state === 'UNREVIEWED').length
  }
  return { adds, dels, files: cs.files.length, hunks, unreviewed }
}

/**
 * The polymorphic telemetry tile, derived. Priority: blocked gate > review-ready
 * change set > live worker phase (testing / mutating / exploring). Idle -> null
 * (demotes to a text row). `escalated` is decided by tilePolicy, not decoration.
 */
export function tileForThread(thread, { agents, changeSets, gate, gateOpen }) {
  const mine = agents.filter((a) => a.threadId === thread.id)
  if (gateOpen && gate && thread.id === gate.threadId) {
    const verifier = mine.find((a) => a.state === 'blocked') || mine[0]
    return {
      phase: 'blocked', cause: gate.cause,
      big: `FAIL :${gate.line}`,
      sub: `${gate.file} · ${gate.by}`,
      tail: `? ${gate.question}`,
      progress: verifier?.progress ?? 0,
      lines: 0,
    }
  }
  const cs = changeSetForThread(thread, changeSets)
  const running = mine.filter((a) => a.state === 'running')
  const totals = changeSetTotals(cs)
  if (cs && totals.unreviewed > 0 && running.length === 0) {
    return {
      phase: 'ready',
      big: `+${totals.adds} −${totals.dels}`,
      sub: `${totals.files} files · ${String(totals.hunks).padStart(2, '0')} hunks`,
      tail: `${totals.unreviewed} unreviewed · review`,
      progress: 100,
      lines: totals.adds + totals.dels,
    }
  }
  const a = running[0]
  if (a) {
    if (a.phase === 'testing' && a.total) {
      return { phase: 'testing', big: `${a.pass} / ${a.total}`, sub: `suites green · ${a.total - a.pass} to go`, tail: a.tail || a.task, progress: a.progress, lines: 0 }
    }
    if ((a.adds || a.dels) != null && (a.adds || a.dels)) {
      return { phase: 'mutating', big: `+${a.adds || 0} −${a.dels || 0}`, sub: `live line delta · ${a.name}`, tail: a.tail || a.task, progress: a.progress, lines: (a.adds || 0) + (a.dels || 0) }
    }
    if (a.scanned != null) {
      return { phase: 'exploring', big: `${a.scanned} files`, sub: 'scanned AST nodes', tail: a.tail || a.task, progress: a.progress, lines: 0 }
    }
    return { phase: 'running', big: `${a.progress}%`, sub: a.phase || a.state, tail: a.tail || a.task, progress: a.progress, lines: 0 }
  }
  return null
}

/** policy decides whether a tile earns the solid accent. returns 'accent' | 'amber' | 'muted' */
export function escalationLevel(tile, policy) {
  if (!tile) return 'muted'
  if (tile.phase === 'blocked') {
    if (tile.cause === 'test-fail' && policy.onFail) return 'accent'
    if (tile.cause === 'ambiguity' && policy.onAmbiguity) return 'accent'
    if (tile.cause !== 'test-fail' && tile.cause !== 'ambiguity' && (policy.onFail || policy.onAmbiguity)) return 'accent'
    return 'amber'
  }
  if (tile.phase === 'ready' && policy.onBigDiff && tile.lines > policy.bigDiffLines) return 'accent'
  return 'muted'
}

/** auto-approve: hunks at or under the line budget go straight to STAGED */
export function applyAutoApprove(changeSets, policy) {
  const cap = policy.autoApproveUnder || 0
  if (!cap) return { changeSets, changed: 0 }
  let changed = 0
  const out = changeSets.map((cs) => ({
    ...cs,
    files: cs.files.map((f) => ({
      ...f,
      hunks: f.hunks.map((h) => {
        if (h.state === 'UNREVIEWED' && h.adds + h.dels <= cap) { changed++; return { ...h, state: 'STAGED', auto: true } }
        return h
      }),
    })),
  }))
  return { changeSets: changed ? out : changeSets, changed }
}

/** enforce the parallelism budget: excess running workers demote to queued */
export function applyParallelCap(agents, maxParallel) {
  let running = 0
  let changed = false
  const out = agents.map((a) => {
    if (a.state !== 'running') return a
    running++
    if (running > maxParallel) { changed = true; return { ...a, state: 'queued', phase: 'awaiting slot (cap)' } }
    return a
  })
  return { agents: changed ? out : agents, changed }
}

/** one fleet tick: running workers advance, tokens burn, suites pass. Pure given `rand`. */
export function tickAgents(agents, dtSec, rand = Math.random) {
  const events = []
  const out = agents.map((a) => {
    if (a.state !== 'running') return a
    const progress = Math.min(100, a.progress + 1 + Math.floor(rand() * 3))
    const next = { ...a, progress, tokens: Math.round((a.tokens || 0) + (a.rate || 0) * dtSec), tools: (a.tools || 0) + (rand() > 0.6 ? 1 : 0) }
    if (next.total && next.pass < next.total && rand() > 0.55) next.pass++
    if (next.adds != null && rand() > 0.5) next.adds += Math.floor(rand() * 4)
    if (next.scanned != null && rand() > 0.5) next.scanned += 1
    if (progress >= 100) {
      next.state = 'complete'; next.phase = 'complete'; next.rate = 0
      if (next.total) next.pass = next.total
      events.push(`${a.name} complete · ${a.task}`)
    }
    return next
  })
  return { agents: out, events }
}

import { cleanDisplayText } from './extract.js'

/** proportional Z0 weight -> grid span class (1, w2, w2 h2) by relative size */
export function treemapSpan(weight, maxWeight) {
  if (!maxWeight || weight <= 0) return ''
  const r = weight / maxWeight
  if (r >= 0.66) return 'w2 h2'
  if (r >= 0.34) return 'w2'
  return ''
}

/**
 * Derives the Visual Session "Album Art" & Human-Voice Index for the Z0 Sky Map.
 * Robot filler prose is excluded from the headline and search index; only the
 * human's own prompts, folder/file blast radius, struggle rhythm, and Git landmarks
 * are surfaced for episodic orienteering.
 */
export function deriveSessionSignature(thread, turns = [], changeSets = [], agents = [], filesCatalog = []) {
  if (!thread) return null
  const cs = changeSetForThread(thread, changeSets)
  const totals = changeSetTotals(cs)
  const humanPrompts = turns
    .filter((t) => t.actor === 'user' || t.kind === 'prompt')
    .map((t) => cleanDisplayText(t.full || t.intent || t.summary || ''))
    .filter(Boolean)

  const decisions = turns
    .filter((t) => t.kind === 'decision' || t.decision)
    .map((t) => cleanDisplayText(t.decision || t.summary || ''))
    .filter(Boolean)

  const csFiles = cs ? cs.files.map((f) => f.name) : []
  const turnArtifactFiles = turns
    .flatMap((t) => t.artifacts || [])
    .filter((a) => /\.(kt|ts|cpp|c|md|json|mjs|js)$/.test(a))
  const filesTouched = [...new Set([...csFiles, ...turnArtifactFiles])]

  const folderSet = new Set()
  if (thread.scope) folderSet.add(thread.scope.replace(/^:/, ''))
  if (thread.project) folderSet.add(thread.project)
  for (const fname of filesTouched) {
    const fObj = filesCatalog.find((x) => x.name === fname)
    if (fObj?.folder) folderSet.add(fObj.folder)
  }
  const blastFolders = [...folderSet]

  const actorSet = new Set(
    turns.map((t) => t.actor).filter((a) => a && a !== 'user' && !a.startsWith('queued')),
  )
  for (const a of agents) {
    if (a.threadId === thread.id) actorSet.add(a.name)
  }
  const subagentsCount = Math.max(1, actorSet.size)

  const rawRhythm = turns.map((t, i) => {
    const hay = `${t.summary || ''} ${(t.stdout || []).join(' ')} ${(t.trace || []).join(' ')}`
    const isFail = /\b(FAIL|REJECTED|EXC_BAD_ACCESS|SIGSEGV|401|collision|fail-open|corrupt)\b/i.test(hay)
    if (t.actor === 'user' || t.kind === 'prompt') return { kind: 'prompt', turn: i + 1, label: 'human prompt' }
    if (isFail) return { kind: 'fail', turn: i + 1, label: 'friction / failure spike' }
    if (t.kind === 'mutation') return { kind: 'mutation', turn: i + 1, label: 'code mutation' }
    if (t.kind === 'decision' || t.decision) return { kind: 'decision', turn: i + 1, label: 'architectural decision' }
    return { kind: 'ok', turn: i + 1, label: 'verified step' }
  })

  const frictionCount = rawRhythm.filter((r) => r.kind === 'fail').length

  // Condense rhythm into at most 16 visual sparkline bars while preserving fail & prompt spikes
  const maxBars = 16
  let struggleSeries = rawRhythm
  if (rawRhythm.length > maxBars) {
    struggleSeries = []
    const step = rawRhythm.length / maxBars
    for (let b = 0; b < maxBars; b++) {
      const slice = rawRhythm.slice(Math.floor(b * step), Math.max(Math.floor(b * step) + 1, Math.floor((b + 1) * step)))
      const pick = slice.find((s) => s.kind === 'fail')
        || slice.find((s) => s.kind === 'mutation')
        || slice.find((s) => s.kind === 'decision')
        || slice.find((s) => s.kind === 'prompt')
        || slice[0]
      if (pick) struggleSeries.push(pick)
    }
  }

  const weight = turns.length + filesTouched.length * 5 + totals.hunks * 3 + subagentsCount * 3 + frictionCount * 4
  const isHero = turns.length >= 6 || filesTouched.length >= 2 || totals.hunks >= 3
  const spanClass = isHero ? 'w2 h2' : (filesTouched.length >= 1 || turns.length >= 4 ? 'w2' : '')

  return {
    id: thread.id,
    title: thread.title,
    project: thread.project,
    age: thread.age,
    status: thread.status,
    timeWindow: thread.timeWindow || 'NOW · THIS WEEK',
    landmark: thread.landmark || (thread.scope ? `scope ${thread.scope}` : thread.project),
    humanPrompts,
    humanHeadline: humanPrompts[0] || thread.title,
    humanFollowup: humanPrompts.length > 1 ? humanPrompts[humanPrompts.length - 1] : null,
    decisions,
    blastFolders,
    filesTouched,
    filesCount: Math.max(totals.files, filesTouched.length),
    hunksCount: totals.hunks,
    adds: totals.adds,
    dels: totals.dels,
    subagentsCount,
    turnsCount: turns.length,
    frictionCount,
    struggleSeries,
    weight,
    isHero,
    spanClass,
  }
}

/**
 * Matches a session on the Z0 Sky Map strictly against human-remembered signals:
 *  1. Your own human prompts (what your fingers typed)
 *  2. Temporal / Git landmarks (release tags, PRs, sprint windows)
 *  3. Folder & file blast radius
 *  4. Session title & architectural decisions
 * Generic robot filler prose is never searched.
 */
export function matchSessionOrienteering(sig, rawQuery) {
  const q = String(rawQuery || '').trim().toLowerCase()
  if (!q) return { matched: true, matchedBy: null, snippet: null }
  const tokens = q.split(/\s+/).filter(Boolean)
  const matchesAll = (text) => {
    const low = String(text || '').toLowerCase()
    return tokens.every((tok) => low.includes(tok))
  }

  const hitPrompt = (sig.humanPrompts || []).find((p) => matchesAll(p))
  if (hitPrompt) return { matched: true, matchedBy: 'your prompt', snippet: hitPrompt }

  if (matchesAll(`${sig.landmark} ${sig.timeWindow} ${sig.age}`)) {
    return { matched: true, matchedBy: 'git landmark', snippet: sig.landmark }
  }

  const folderFileHay = [...(sig.blastFolders || []), ...(sig.filesTouched || []), sig.project || '']
  const hitPath = folderFileHay.find((f) => matchesAll(f))
  if (hitPath || matchesAll(folderFileHay.join(' '))) {
    return { matched: true, matchedBy: 'folder · file', snippet: hitPath || sig.blastFolders.join(' · ') }
  }

  const hitDecision = [sig.title, ...(sig.decisions || [])].find((d) => matchesAll(d))
  if (hitDecision) return { matched: true, matchedBy: 'decision', snippet: hitDecision }

  return { matched: false, matchedBy: null, snippet: null }
}

export {
  extractTurnSpans,
  segmentGroundedText,
  deriveHotWords,
  turnMatchesHotWord,
  enrichTurn,
  deriveEpochs,
  assignTurnEpochs,
  cleanDisplayText,
} from './extract.js'

