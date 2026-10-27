import test from 'node:test'
import assert from 'node:assert/strict'
import { seedThreads, seedTurns, seedChangeSets, files, seedAgents, seedEpochs, seedGate, seedInvariants } from '../src/data.js'

const HUNK_STATES = new Set(['STAGED', 'UNREVIEWED', 'REJECTED', 'INSTRUCTED'])

test('every seeded thread has a turn timeline (conversation matrix col 2 never empty)', () => {
  for (const t of seedThreads) {
    assert.ok(Array.isArray(seedTurns[t.id]), `missing turns for thread ${t.id}`)
    assert.ok(seedTurns[t.id].length > 0, `empty timeline for thread ${t.id}`)
  }
})

test('every turn carries a full payload (col 3 + Enter reader have something to show)', () => {
  for (const [id, turns] of Object.entries(seedTurns)) {
    turns.forEach((tn, i) => {
      for (const k of ['actor', 'age', 'summary', 'intent', 'synthesis', 'full']) {
        assert.ok(typeof tn[k] === 'string' && tn[k].length > 0, `turn ${id}[${i}] missing ${k}`)
      }
      assert.ok(Array.isArray(tn.stats) && Array.isArray(tn.artifacts), `turn ${id}[${i}] stats/artifacts must be arrays`)
      if (tn.state === 'running') assert.ok(tn.progress > 0 && tn.progress < 100, `running turn ${id}[${i}] needs a live progress`)
    })
  }
})

test('every change-set file breaks into well-formed, triageable hunks (review col 2/3)', () => {
  assert.ok(seedChangeSets.length >= 2, 'need at least two change sets to group by task')
  for (const cs of seedChangeSets) {
    assert.ok(cs.files.length > 0, `change set ${cs.id} has no files`)
    for (const f of cs.files) {
      assert.ok(f.hunks.length > 0, `${cs.task}/${f.name} has no hunks`)
      // declared file delta must equal the sum of its hunks — the index must not lie
      assert.equal(f.hunks.reduce((n, h) => n + h.adds, 0), f.adds, `${f.name} +lines do not sum across hunks`)
      assert.equal(f.hunks.reduce((n, h) => n + h.dels, 0), f.dels, `${f.name} -lines do not sum across hunks`)
      for (const h of f.hunks) {
        assert.ok(HUNK_STATES.has(h.state), `${f.name} hunk in unknown state ${h.state}`)
        for (const k of ['range', 'fn', 'tag', 'by', 'rationale', 'verification']) {
          assert.ok(h[k]?.length > 0, `${f.name} hunk ${h.fn} missing ${k}`)
        }
        assert.ok(h.lines.length > 0 && h.lines.every(([s]) => ['+', '-', ' '].includes(s)), `${f.name} hunk ${h.fn} has malformed diff lines`)
      }
    }
  }
})

test('telemetry tiles: at most 8, polymorphic phases, every tiled thread carries a big numeral', () => {
  const tiled = seedThreads.filter((t) => t.tile)
  assert.ok(tiled.length >= 2 && tiled.length <= 8, `expected 2..8 tiles, got ${tiled.length}`)
  for (const t of tiled) {
    assert.ok(['blocked', 'ready', 'testing', 'running', 'exploring'].includes(t.tile.phase), `thread ${t.id} tile phase ${t.tile.phase}`)
    for (const k of ['big', 'sub', 'tail']) assert.ok(t.tile[k]?.length > 0, `thread ${t.id} tile missing ${k}`)
    assert.ok(t.tile.progress >= 0 && t.tile.progress <= 100, `thread ${t.id} tile progress out of range`)
    assert.ok(t.scope?.startsWith(':'), `thread ${t.id} needs a module scope for tile zone 1`)
  }
  assert.ok(tiled.some((t) => t.tile.phase === 'blocked'), 'spec requires one hot interrupt tile to judge the pattern by')
  assert.ok(seedThreads.some((t) => !t.tile), 'idle threads must exist to prove demotion to text rows')
})

test('epochs segment the long session and every anchor lands on a real turn', () => {
  assert.ok(seedEpochs.length >= 4, 'multi-day session needs several epochs')
  assert.deepEqual(seedEpochs.map((e) => e.n), seedEpochs.map((_, i) => i + 1), 'epochs are numbered 01..N in order')
  const board = seedTurns.board
  for (const e of seedEpochs) {
    assert.ok(board[e.anchor], `epoch E${e.n} anchor ${e.anchor} has no turn`)
    assert.ok(e.turns > 0 && e.summary.length > 0 && e.when.length > 0, `epoch E${e.n} incomplete`)
  }
  for (const t of board) {
    if (t.epoch) assert.ok(seedEpochs.some((e) => e.n === t.epoch), `turn epoch ${t.epoch} not in seedEpochs`)
  }
  assert.ok(board.some((t) => t.kind === 'decision' && t.decision), 'Z2 ledger / decisions facet needs decision turns')
  assert.ok(board.some((t) => t.kind === 'mutation'), 'mutations facet needs a mutation turn')
})

test('the interrupt gate resolves against a real blocked verifier and thread', () => {
  assert.ok(seedThreads.some((t) => t.id === seedGate.threadId), 'gate thread must exist')
  assert.ok(seedAgents.some((a) => a.name === seedGate.by && a.state === 'blocked'), 'gate must be held by a blocked agent')
  for (const k of ['text', 'question', 'yes', 'no']) assert.ok(seedGate[k]?.length > 0, `gate missing ${k}`)
  for (const g of seedInvariants) assert.ok(['PASS', 'FAIL', 'RUN'].includes(g.state), `invariant ${g.name} state ${g.state}`)
  assert.ok(seedInvariants.some((g) => g.state === 'FAIL'), 'the gate exists because an invariant is red')
})

test('artifact links that claim to be files resolve into the collection', () => {
  const names = new Set(files.map((f) => f.name))
  for (const turns of Object.values(seedTurns)) {
    for (const tn of turns) {
      for (const a of tn.artifacts) {
        if (/\.(md|kt|ts)$/.test(a)) assert.ok(names.has(a), `turn artifact ${a} does not exist in collection files`)
      }
    }
  }
})
