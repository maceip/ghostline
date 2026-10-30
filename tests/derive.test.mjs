import test from 'node:test'
import assert from 'node:assert/strict'
import { seedThreads, seedAgents, seedTurns, seedChangeSets, seedGate, seedEpochs, files } from '../src/data.js'
import {
  fmtTokens, parseCeiling, fleetCounts, fleetVelocity, epochTurnCounts,
  facetPartition, changeSetForThread, changeSetTotals, tileForThread,
  escalationLevel, applyAutoApprove, applyParallelCap, tickAgents, treemapSpan,
  deriveSessionSignature, matchSessionOrienteering, deriveSessionConcepts,
  deriveEpochs, assignTurnEpochs,
} from '../src/derive.js'

const POLICY = { onFail: true, onAmbiguity: true, onBigDiff: true, bigDiffLines: 250, autoApproveUnder: 0 }
const ctx = (over = {}) => ({ agents: seedAgents, changeSets: seedChangeSets, gate: seedGate, gateOpen: true, ...over })

test('tiles are derived from state: blocked gate, review-ready totals, live worker phase', () => {
  const byId = Object.fromEntries(seedThreads.map((t) => [t.id, tileForThread(t, ctx())]))
  assert.equal(byId.board.phase, 'blocked')
  assert.equal(byId.board.big, `FAIL :${seedGate.line}`)
  assert.equal(byId.siem.phase, 'ready')
  const totals = changeSetTotals(changeSetForThread(seedThreads.find((t) => t.id === 'siem'), seedChangeSets))
  assert.equal(byId.siem.big, `+${totals.adds} −${totals.dels}`, 'ready tile numeral must be the real change-set sum')
  assert.equal(byId.auth.phase, 'mutating')
  const a5 = seedAgents.find((a) => a.id === 'a5')
  assert.equal(byId.auth.big, `+${a5.adds} −${a5.dels}`)
  assert.equal(byId.e2e, null, 'idle thread earns no tile')
})

test('resolving the gate re-derives the board tile from its running tester', () => {
  const board = seedThreads.find((t) => t.id === 'board')
  const tile = tileForThread(board, ctx({ gateOpen: false }))
  assert.equal(tile.phase, 'testing')
  const a1 = seedAgents.find((a) => a.id === 'a1')
  assert.equal(tile.big, `${a1.pass} / ${a1.total}`)
})

test('escalation policy actually controls the accent', () => {
  const blocked = tileForThread(seedThreads[0], ctx())
  assert.equal(escalationLevel(blocked, POLICY), 'accent')
  assert.equal(escalationLevel(blocked, { ...POLICY, onFail: false, onAmbiguity: false }), 'amber', 'policy off must demote the pink to amber')
  const ready = tileForThread(seedThreads.find((t) => t.id === 'siem'), ctx())
  assert.equal(escalationLevel(ready, POLICY), 'muted')
  assert.equal(escalationLevel(ready, { ...POLICY, bigDiffLines: 10 }), 'accent', 'big-diff rule escalates an oversized ready set')
  assert.equal(escalationLevel(ready, { ...POLICY, bigDiffLines: 10, onBigDiff: false }), 'muted')
})

test('auto-approve stages only hunks at or under the budget', () => {
  const { changeSets, changed } = applyAutoApprove(seedChangeSets, { ...POLICY, autoApproveUnder: 20 })
  assert.ok(changed > 0)
  for (const cs of changeSets) for (const f of cs.files) for (const h of f.hunks) {
    if (h.auto) assert.ok(h.adds + h.dels <= 20 && h.state === 'STAGED')
  }
  assert.equal(applyAutoApprove(seedChangeSets, POLICY).changed, 0, 'budget 0 stages nothing')
})

test('parallel cap demotes excess runners; velocity sums only running rates', () => {
  const { agents, changed } = applyParallelCap(seedAgents, 1)
  assert.ok(changed)
  assert.equal(agents.filter((a) => a.state === 'running').length, 1)
  assert.equal(applyParallelCap(seedAgents, 10).changed, false)
  const expected = seedAgents.filter((a) => a.state === 'running').reduce((n, a) => n + a.rate, 0)
  assert.equal(fleetVelocity(seedAgents), expected)
  assert.ok(expected > 0)
})

test('fleet tick advances progress, burns tokens, completes workers deterministically', () => {
  const { agents, events } = tickAgents([{ id: 'x', name: 'w', task: 't', state: 'running', progress: 99, tokens: 1000, rate: 100, pass: 1, total: 2, tools: 0 }], 2, () => 0.9)
  assert.equal(agents[0].state, 'complete')
  assert.equal(agents[0].tokens, 1200)
  assert.equal(agents[0].pass, 2)
  assert.equal(events.length, 1)
  const idle = tickAgents(seedAgents, 1, () => 0.1)
  assert.equal(idle.agents.find((a) => a.id === 'a4').tokens, 0, 'queued workers burn nothing')
})

test('facets and epochs partition the real turns with no invented counts', () => {
  const turns = seedTurns.board
  const f = facetPartition(turns)
  assert.equal(f.all.length, turns.length)
  assert.equal(f.prompts.length, turns.filter((t) => t.actor === 'user').length)
  assert.ok(f.decisions.length >= 3 && f.mutations.length >= 2 && f.pty.length >= 2)
  const counts = epochTurnCounts(turns)
  assert.equal([...counts.values()].reduce((a, b) => a + b, 0), turns.length)
  for (const e of seedEpochs) {
    assert.equal(turns[e.anchor].epoch, e.n, `epoch E${e.n} anchor must land inside the epoch`)
  }
  const anchors = seedEpochs.map((e) => e.anchor)
  assert.deepEqual(anchors, [...anchors].sort((a, b) => a - b), 'anchors strictly increase')
  assert.equal(new Set(anchors).size, anchors.length, 'anchors are unique — teleportation lands somewhere distinct')
})

test('misc: token formatting, ceilings, treemap spans, fleet counts sum to fleet', () => {
  assert.equal(fmtTokens(48200), '48.2k')
  assert.equal(parseCeiling('2.5M'), 2500000)
  assert.equal(parseCeiling('250k'), 250000)
  assert.equal(treemapSpan(10, 10), 'w2 h2')
  assert.equal(treemapSpan(4, 10), 'w2')
  assert.equal(treemapSpan(1, 10), '')
  const c = fleetCounts(seedAgents)
  assert.equal(c.running + c.verified + c.queued + c.blocked, seedAgents.length)
})

test('deriveSessionSignature & matchSessionOrienteering: human-voice indexing, struggle sparkline, and landmark orienteering', () => {
  const refreshThread = seedThreads.find((t) => t.id === 'refresh-race')
  const sig = deriveSessionSignature(refreshThread, seedTurns['refresh-race'], seedChangeSets, seedAgents, files)
  assert.ok(sig.humanHeadline.includes('why does token refresh randomly log me out'), 'headline must be the human prompt, not robot filler')
  assert.ok(sig.humanFollowup.includes('revert the Redis lock'), 'followup must capture human steering prompt')
  assert.ok(sig.blastFolders.includes('fragments.auth'), 'blastFolders must include fragments.auth')
  assert.equal(sig.filesCount, 2, 'refresh-race touches 2 files')
  assert.ok(sig.frictionCount >= 2, 'refresh-race has >= 2 friction/failure spikes')
  assert.equal(sig.isHero, true, '6-turn, 2-file high-friction session is a hero session')
  assert.equal(sig.tileFace.big, '+52 −12', 'tileFace.big must derive +52 -12 from cs-refresh')

  // Matches human prompt
  const mPrompt = matchSessionOrienteering(sig, 'randomly log me out')
  assert.equal(mPrompt.matched, true)
  assert.equal(mPrompt.matchedBy, 'your prompt')

  // Matches git landmark
  const mLandmark = matchSessionOrienteering(sig, 'v2.1.0')
  assert.equal(mLandmark.matched, true)
  assert.equal(mLandmark.matchedBy, 'git landmark')

  // Matches folder/file blast radius
  const mFile = matchSessionOrienteering(sig, 'RefreshGraceWindow.kt')
  assert.equal(mFile.matched, true)
  assert.equal(mFile.matchedBy, 'folder · file')

  // Does NOT match robot-only prose that is absent from human prompts/landmarks/decisions
  const mRobotFiller = matchSessionOrienteering(sig, 'sibling tab presenting R1')
  assert.equal(mRobotFiller.matched, false, 'robot filler prose must be muted in Z0 orienteering index')
})

test('deriveSessionConcepts: distills 200-turn Codex session into ranked concepts, chronological heat strips, and 3 historical eras', () => {
  const wsCtx = { files, folders: [], changeSets: seedChangeSets }
  const rawTurns = seedTurns.codex
  const epochs = deriveEpochs(rawTurns, seedEpochs, { onCommit: true, everyTurns: 15 }, wsCtx, 'codex')
  const turns = assignTurnEpochs(rawTurns, epochs, wsCtx)
  const conceptData = deriveSessionConcepts(turns, epochs, wsCtx)

  assert.ok(conceptData.concepts.length >= 8, `expected >= 8 extracted concepts on 200-turn session, got ${conceptData.concepts.length}`)
  assert.equal(conceptData.eras.length, 3, 'expected 3 chronological eras (early, middle, late)')
  assert.ok(conceptData.rawLineEstimate > 80000, `expected > 80k raw line estimate for 200-turn session, got ${conceptData.rawLineEstimate}`)

  const execConcept = conceptData.concepts.find((c) => c.label.toLowerCase().includes('executorch'))
  assert.ok(execConcept, 'expected ExecuTorch among top concepts')
  assert.equal(execConcept.epochHeat.length, epochs.length, 'each concept must have an epochHeat bucket for every epoch')
})
