import test from 'node:test'
import assert from 'node:assert/strict'
import { seedThreads, seedAgents, seedTurns, seedChangeSets, seedGate, seedEpochs } from '../src/data.js'
import {
  fmtTokens, parseCeiling, fleetCounts, fleetVelocity, epochTurnCounts,
  facetPartition, changeSetForThread, changeSetTotals, tileForThread,
  escalationLevel, applyAutoApprove, applyParallelCap, tickAgents, treemapSpan,
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
