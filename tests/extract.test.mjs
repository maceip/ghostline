import { test } from 'node:test'
import assert from 'node:assert/strict'
import { files, folders, seedTurns, seedEpochs, seedChangeSets } from '../src/data.js'
import {
  extractTurnSpans,
  segmentGroundedText,
  deriveHotWords,
  turnMatchesHotWord,
  enrichTurn,
  deriveEpochs,
  assignTurnEpochs,
  facetPartition,
} from '../src/derive.js'

const workspace = { files, folders, changeSets: seedChangeSets }

test('extractTurnSpans grounds every span to exact [start, end) character offsets', () => {
  const sample = 'DECISION: verifyToken() in AuthAndVaultStore.kt:84 enforces PCR0 attestation and DPoP across 29/29 suites in 41s.'
  const spans = extractTurnSpans(sample, workspace)
  assert.ok(spans.length >= 5, `expected at least 5 grounded spans, got ${spans.length}`)

  for (let i = 0; i < spans.length; i++) {
    const s = spans[i]
    assert.equal(
      sample.slice(s.start, s.end),
      s.text,
      `span ${i} (${s.cls}) text mismatch at [${s.start}, ${s.end})`,
    )
    if (i > 0) {
      assert.ok(spans[i - 1].end <= s.start, `spans ${i - 1} and ${i} overlap`)
    }
  }

  const fileSpan = spans.find((s) => s.cls === 'file')
  assert.ok(fileSpan, 'expected a grounded file:line span')
  assert.equal(fileSpan.text, 'AuthAndVaultStore.kt:84')
  assert.deepEqual(fileSpan.target, { type: 'hunk', file: 'AuthAndVaultStore.kt', line: 84 })

  const symSpan = spans.find((s) => s.cls === 'symbol' && s.text.startsWith('verifyToken'))
  assert.ok(symSpan, 'expected grounded symbol span for verifyToken()')

  const decSpan = spans.find((s) => s.cls === 'decision')
  assert.ok(decSpan, 'expected grounded decision marker span')
})

test('segmentGroundedText is lossless and preserves exact character sequence across all seed turns', () => {
  for (const [tid, turns] of Object.entries(seedTurns)) {
    for (const t of turns) {
      for (const field of [t.full, t.synthesis, t.intent, t.decision]) {
        if (!field) continue
        const segs = segmentGroundedText(field, workspace)
        const reconstructed = segs.map((s) => s.text).join('')
        assert.equal(reconstructed, field, `lossless round-trip failed in thread ${tid}`)
      }
    }
  }
})

test('deriveHotWords extracts ranked hot words and turnMatchesHotWord filters accurately', () => {
  const boardTurns = seedTurns.board.map((t, i) => ({ ...t, i }))
  const hotWords = deriveHotWords(boardTurns, workspace, 10)
  assert.ok(hotWords.length >= 4, 'expected ranked hot words from board thread')

  for (const hw of hotWords) {
    const matching = boardTurns.filter((t) => turnMatchesHotWord(t, hw.key, workspace))
    assert.equal(
      matching.length,
      hw.count,
      `hot word ${hw.label} (${hw.key}) count=${hw.count} must match turnMatchesHotWord filter count=${matching.length}`,
    )
  }
})

test('enrichTurn generates multi-resolution Z1 summary, Z1 synthesis, Z2 decision, and Z3 full text', () => {
  const longText = [
    'Inspected the token verification pipeline across the auth module.',
    'DECISION: pin ES256 and require DPoP proof in AuthAndVaultStore.kt:84 before touching VaultKeyring.kt.',
    'Ran 29/29 suites in 41s with zero regressions.',
    'Additional implementation notes follow in the full trace below for Z3 readers.',
  ].join(' ')

  const raw = {
    actor: 'agent',
    intent: 'Harden token verification in AuthAndVaultStore.kt and decide on DPoP enforcement.',
    synthesis: longText,
    full: longText,
  }
  const enriched = enrichTurn(raw, workspace)

  assert.equal(enriched.kind, 'decision')
  assert.ok(enriched.decision.includes('DPoP'), `expected extracted decision sentence, got: ${enriched.decision}`)
  assert.ok(enriched.summary.length <= 57, `expected compact Z1 summary <=57 chars, got ${enriched.summary.length}: ${enriched.summary}`)
  assert.notEqual(enriched.summary, enriched.full, 'Z1 summary must be compressed relative to Z3 full text')
  assert.notEqual(enriched.synthesis, enriched.full, 'Z1 synthesis (1-2 sentences) must be distinct from Z3 full text')
  assert.ok(enriched.artifacts.includes('AuthAndVaultStore.kt'), 'expected referenced workspace file in artifacts')
  assert.ok(enriched.artifacts.includes('VaultKeyring.kt'), 'expected VaultKeyring.kt in artifacts')

  // Verify facetPartition includes the enriched turn in decisions and artifacts
  const facets = facetPartition([enriched])
  assert.equal(facets.decisions.length, 1)
  assert.equal(facets.artifacts.length, 1)
})

test('200-turn Codex session history: fast (<100ms cold, <15ms warm), lossless grounding, and distinct TF-IDF epochs', () => {
  const codexTurns = seedTurns.codex
  assert.equal(codexTurns.length, 200, 'expected 200 real turns from ~/.codex/sessions')

  const t0 = performance.now()
  const epochs15 = deriveEpochs(codexTurns, seedEpochs, { everyTurns: 15, onCommit: true }, workspace, 'codex')
  const assigned = assignTurnEpochs(codexTurns, epochs15, workspace)
  const hotWords = deriveHotWords(assigned, workspace, 12)
  for (const t of assigned) {
    const segs = segmentGroundedText(t.full, workspace)
    assert.equal(segs.map((s) => s.text).join(''), t.full)
  }
  const coldMs = performance.now() - t0

  const w0 = performance.now()
  const epochsWarm = deriveEpochs(codexTurns, seedEpochs, { everyTurns: 15, onCommit: true }, workspace, 'codex')
  const assignedWarm = assignTurnEpochs(codexTurns, epochsWarm, workspace)
  const hotWarm = deriveHotWords(assignedWarm, workspace, 12)
  for (const t of assignedWarm) segmentGroundedText(t.full, workspace)
  const warmMs = performance.now() - w0

  assert.ok(coldMs < 120, `200-turn cold pass took ${coldMs.toFixed(2)}ms (must be <120ms)`)
  assert.ok(warmMs < 20, `200-turn warm pass took ${warmMs.toFixed(2)}ms (must be <20ms)`)
  assert.ok(hotWarm.length >= 10)

  // Every epoch across the 200-turn session has a unique Zune hot-word header and valid turn counts summing to 200
  assert.ok(epochs15.length >= 12 && epochs15.length <= 18, `expected 12..18 epochs for 200 turns at everyTurns=15, got ${epochs15.length}`)
  const epochNames = epochs15.map((e) => e.name)
  assert.equal(new Set(epochNames).size, epochNames.length, `expected unique epoch headers across 200 turns, got: ${epochNames.join(', ')}`)
  const totalCount = epochs15.reduce((sum, e) => sum + e.count, 0)
  assert.equal(totalCount, 200, 'epoch turn counts must sum to 200')

  // Domain hot words extracted from the real ExecuTorch / VENTUNO Codex rollout
  const hwKeys = new Set(hotWords.map((h) => h.key))
  assert.ok(hwKeys.has('ExecuTorch'), 'expected ExecuTorch in top hot words')
  assert.ok(hwKeys.has('VENTUNO'), 'expected VENTUNO in top hot words')
  assert.ok(hwKeys.has('NPU'), 'expected NPU in top hot words')

  // Verify hot-word filtering on all 200 turns
  for (const hw of hotWords) {
    const matches = assigned.filter((t) => turnMatchesHotWord(t, hw.key, workspace))
    assert.equal(matches.length, hw.count, `hot word ${hw.key} count mismatch on 200-turn session`)
  }
})

test('deriveEpochs dynamically segments non-board threads and honors config.epochs.everyTurns', () => {
  // 1. Non-board thread (siem) gets real epochs with extracted hotWords
  const siemEpochs = deriveEpochs(seedTurns.siem, seedEpochs, { everyTurns: 15, onCommit: true }, workspace, 'siem')
  assert.ok(siemEpochs.length >= 1)
  assert.ok(siemEpochs[0].name.length > 0)
  assert.ok(Array.isArray(siemEpochs[0].hotWords))

  // 2. Synthetic long thread segments dynamically according to everyTurns (10 vs 25)
  const syntheticTurns = Array.from({ length: 24 }, (_, i) => ({
    actor: i % 2 === 0 ? 'user' : 'm1_worker_1',
    age: `${24 - i}m`,
    intent: i < 12 ? 'Refactor AuthAndVaultStore.kt verifyToken() for DPoP' : 'Wire SIEM telemetry in MacosChromeApp.kt',
    synthesis: i < 12
      ? 'Updated verifyToken() in AuthAndVaultStore.kt:84 to enforce DPoP.'
      : 'Connected SIEM event stream in MacosChromeApp.kt with 12/12 tests passing.',
    full: i < 12
      ? 'Updated verifyToken() in AuthAndVaultStore.kt:84 to enforce DPoP.'
      : 'Connected SIEM event stream in MacosChromeApp.kt with 12/12 tests passing.',
  }))

  const ep10 = deriveEpochs(syntheticTurns, seedEpochs, { everyTurns: 10, onCommit: false }, workspace, 'custom')
  const ep25 = deriveEpochs(syntheticTurns, seedEpochs, { everyTurns: 25, onCommit: false }, workspace, 'custom')
  assert.ok(ep10.length > ep25.length, `everyTurns=10 (${ep10.length} epochs) should produce more epochs than everyTurns=25 (${ep25.length} epochs)`)

  const assigned = assignTurnEpochs(syntheticTurns, ep10, workspace)
  assert.equal(assigned.length, syntheticTurns.length)
  assert.ok(assigned.every((t) => typeof t.epoch === 'number' && t.epoch >= 1))
})
