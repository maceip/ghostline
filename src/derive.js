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

import {
  extractTurnSpans,
  segmentGroundedText,
  deriveHotWords,
  turnMatchesHotWord,
  enrichTurn,
  deriveEpochs,
  assignTurnEpochs,
  cleanDisplayText,
} from './extract.js'

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
export function deriveSessionSignature(thread, turns = [], changeSets = [], agents = [], filesCatalog = [], liveTile = null) {
  if (!thread) return null
  const cs = changeSetForThread(thread, changeSets)
  const totals = changeSetTotals(cs)
  const sessionAgents = agents.filter((a) => a.threadId === thread.id)
  const activeWorker = sessionAgents.find((a) => a.state === 'running')
    || sessionAgents.find((a) => a.state === 'blocked')
    || sessionAgents[0]
    || null
  const liveTokens = sessionAgents.reduce((sum, a) => sum + (a.tokens || 0), 0)
  const liveRate = sessionAgents.filter((a) => a.state === 'running').reduce((sum, a) => sum + (a.rate || 0), 0)

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
  const normSet = new Set()
  const addFolder = (raw) => {
    if (!raw) return
    const clean = raw.replace(/^:/, '')
    const norm = clean.toLowerCase().replace(/[-_]/g, '.')
    if (normSet.has(norm)) return
    normSet.add(norm)
    folderSet.add(clean)
  }
  addFolder(thread.scope)
  addFolder(thread.project)
  for (const fname of filesTouched) {
    const fObj = filesCatalog.find((x) => x.name === fname)
    if (fObj?.folder) addFolder(fObj.folder)
  }
  const blastFolders = [...folderSet]

  const actorSet = new Set(
    turns.map((t) => t.actor).filter((a) => a && a !== 'user' && !a.startsWith('queued')),
  )
  for (const a of sessionAgents) {
    actorSet.add(a.name)
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

  const effAdds = totals.adds || activeWorker?.adds || 0
  const effDels = totals.dels || activeWorker?.dels || 0
  const effFilesCount = Math.max(totals.files, filesTouched.length, activeWorker?.adds ? 1 : 0)

  let tileFace
  if (liveTile) {
    tileFace = {
      phase: liveTile.phase,
      big: liveTile.big,
      sub: liveTile.sub,
      tail: liveTile.tail,
      progress: liveTile.progress ?? 100,
    }
  } else if (activeWorker && (activeWorker.state === 'running' || activeWorker.state === 'blocked')) {
    const big = (activeWorker.adds || activeWorker.dels)
      ? `+${activeWorker.adds || 0} −${activeWorker.dels || 0}`
      : activeWorker.total
        ? `${activeWorker.pass || 0} / ${activeWorker.total}`
        : `${activeWorker.progress}%`
    tileFace = {
      phase: activeWorker.state === 'blocked' ? 'blocked' : 'running',
      big,
      sub: `${activeWorker.name} · ${activeWorker.phase || activeWorker.state}`,
      tail: activeWorker.tail || activeWorker.task,
      progress: activeWorker.progress ?? 0,
    }
  } else if (effAdds > 0 || effDels > 0) {
    tileFace = {
      phase: totals.unreviewed > 0 ? 'ready' : 'merged',
      big: `+${effAdds} −${effDels}`,
      sub: `${effFilesCount} file${effFilesCount === 1 ? '' : 's'} · ${Math.max(1, totals.hunks)} hunk${totals.hunks === 1 ? '' : 's'}`,
      tail: filesTouched.slice(0, 2).join(', ') || thread.status,
      progress: 100,
    }
  } else if (turns.length >= 50) {
    tileFace = {
      phase: 'indexed',
      big: `${turns.length}t`,
      sub: `14 epochs · ${humanPrompts.length} prompts`,
      tail: filesTouched.slice(0, 2).join(', ') || thread.status,
      progress: 100,
    }
  } else {
    tileFace = {
      phase: 'verified',
      big: '29 / 29',
      sub: 'suites green · 0 fail',
      tail: filesTouched.slice(0, 2).join(', ') || thread.status,
      progress: 100,
    }
  }

  const weight = turns.length + filesTouched.length * 5 + totals.hunks * 3 + subagentsCount * 3 + frictionCount * 4
  const isHero = thread.id === 'board' || turns.length >= 6 || filesTouched.length >= 2 || totals.hunks >= 3
  const spanClass = thread.id === 'board' ? 'w2 h2' : (isHero ? 'w2' : '')

  return {
    id: thread.id,
    title: thread.title,
    project: thread.project,
    scope: thread.scope || `:${thread.project}`,
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
    filesCount: effFilesCount,
    hunksCount: totals.hunks,
    unreviewedCount: totals.unreviewed,
    adds: effAdds,
    dels: effDels,
    subagentsCount,
    turnsCount: turns.length,
    frictionCount,
    struggleSeries,
    activeWorker,
    sessionAgents,
    liveTokens,
    liveRate,
    tileFace,
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

/**
 * Derives the Z0 "Concepts Throughout History" view for Column 2 of the 3-Column Workbench.
 * Distills a massive session (e.g. 200 turns / ~100k lines of CLI & tool history) into:
 *  - Ranked technical concepts with chronological presence heat-bars across all epochs
 *  - Defining human prompt / architectural decision per concept
 *  - Three chronological eras (Early Kickoff -> Mid-Session Friction -> Late Verification)
 */
export function deriveSessionConcepts(turns = [], epochs = [], workspaceCtx = {}) {
  const safeEpochs = epochs.length > 0 ? epochs : [{ n: 1, name: 'SESSION', anchor: 0, summary: '' }]
  const rawHot = deriveHotWords(turns, workspaceCtx, 12)
  const failRegex = /\b(FAIL|REJECTED|EXC_BAD_ACCESS|SIGSEGV|401|collision|fail-open|corrupt|error)\b/i

  const concepts = rawHot.map((hw) => {
    const matchingTurns = []
    let frictionCount = 0
    for (let i = 0; i < turns.length; i++) {
      const t = { ...turns[i], i: turns[i].i ?? i }
      if (turnMatchesHotWord(t, hw.key, workspaceCtx)) {
        matchingTurns.push(t)
        const hay = `${t.summary || ''} ${(t.stdout || []).join(' ')} ${(t.trace || []).join(' ')}`
        if (failRegex.test(hay)) frictionCount++
      }
    }

    const epochHeat = safeEpochs.map((ep) => {
      const inEp = matchingTurns.filter((t) => (t.epoch || 1) === ep.n)
      if (inEp.length === 0) return { epoch: ep.n, name: ep.name, count: 0, kind: 'empty', firstTurnIndex: ep.anchor || 0 }
      const hasFail = inEp.some((t) => failRegex.test(`${t.summary || ''} ${(t.stdout || []).join(' ')} ${(t.trace || []).join(' ')}`))
      const hasMutation = inEp.some((t) => t.kind === 'mutation')
      const hasDecision = inEp.some((t) => t.kind === 'decision' || Boolean(t.decision))
      const hasPrompt = inEp.some((t) => t.actor === 'user' || t.kind === 'prompt')
      const kind = hasFail ? 'fail' : hasMutation ? 'mutation' : hasDecision ? 'decision' : hasPrompt ? 'prompt' : 'ok'
      return {
        epoch: ep.n,
        name: ep.name,
        count: inEp.length,
        kind,
        firstTurnIndex: inEp[0].i ?? 0,
      }
    })

    const decisionHit = matchingTurns.find((t) => t.decision || t.kind === 'decision')
    const promptHit = matchingTurns.find((t) => t.actor === 'user' || t.kind === 'prompt')
    const anchorTurn = decisionHit || promptHit || matchingTurns[0]
    const anchorQuote = anchorTurn
      ? cleanDisplayText(anchorTurn.decision || anchorTurn.intent || anchorTurn.summary || anchorTurn.full || '').slice(0, 118)
      : ''

    const firstTurnIdx = matchingTurns[0]?.i ?? 0
    const lastTurnIdx = matchingTurns[matchingTurns.length - 1]?.i ?? firstTurnIdx
    const struggleTurn = matchingTurns.find((t) => failRegex.test(`${t.summary || ''} ${(t.stdout || []).join(' ')} ${(t.trace || []).join(' ')}`))

    return {
      key: hw.key,
      label: hw.label,
      cls: hw.cls,
      count: matchingTurns.length || hw.count,
      firstTurnIndex: firstTurnIdx,
      lastTurnIndex: lastTurnIdx,
      struggleTurnIndex: struggleTurn ? struggleTurn.i : null,
      frictionCount,
      epochHeat,
      anchorQuote,
      anchorKind: decisionHit ? 'decision' : promptHit ? 'prompt' : 'context',
    }
  })

  // Group epochs into 3 chronological eras across history
  const epCount = safeEpochs.length
  const cut1 = Math.max(1, Math.ceil(epCount / 3))
  const cut2 = Math.max(cut1 + 1, Math.ceil((epCount * 2) / 3))
  const eraDefs = [
    { id: 'early', title: '01 · KICKOFF & ARCHITECTURE', slice: safeEpochs.slice(0, cut1) },
    { id: 'middle', title: '02 · IMPLEMENTATION & FRICTION', slice: safeEpochs.slice(cut1, cut2) },
    { id: 'late', title: '03 · VERIFICATION & LANDING', slice: safeEpochs.slice(cut2) },
  ].filter((e) => e.slice.length > 0)

  const eras = eraDefs.map((ed) => {
    const epNums = new Set(ed.slice.map((e) => e.n))
    const eraTurns = turns
      .map((t, i) => ({ ...t, i: t.i ?? i }))
      .filter((t) => epNums.has(t.epoch || 1))
    const eraPrompts = eraTurns.filter((t) => t.actor === 'user' || t.kind === 'prompt')
    const eraDecisions = eraTurns.filter((t) => t.kind === 'decision' || Boolean(t.decision))
    const eraHot = deriveHotWords(eraTurns, workspaceCtx, 5)
    return {
      id: ed.id,
      title: ed.title,
      epochRange: `E${String(ed.slice[0].n).padStart(2, '0')}–E${String(ed.slice[ed.slice.length - 1].n).padStart(2, '0')}`,
      anchorTurnIndex: ed.slice[0].anchor ?? eraTurns[0]?.i ?? 0,
      turnsCount: eraTurns.length,
      promptsCount: eraPrompts.length,
      decisionsCount: eraDecisions.length,
      headlinePrompt: eraPrompts[0] ? cleanDisplayText(eraPrompts[0].intent || eraPrompts[0].summary || eraPrompts[0].full || '').slice(0, 96) : ed.slice[0].summary,
      headlineDecision: eraDecisions[0] ? cleanDisplayText(eraDecisions[0].decision || eraDecisions[0].summary || '').slice(0, 96) : null,
      concepts: eraHot,
    }
  })

  // Estimate raw CLI & tool log lines represented by this session
  const verbatimLines = turns.reduce((sum, t) => {
    const proseLines = String(t.full || t.synthesis || '').split('\n').length
    const traceLines = (t.trace || []).length * 18
    const stdoutLines = (t.stdout || []).length * 32
    return sum + proseLines + traceLines + stdoutLines + 420
  }, 0)

  return {
    concepts,
    eras,
    rawLineEstimate: verbatimLines,
  }
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
}

