import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildEngineEvent, buildCircuitEvent, createTelemetryHooks } from '../src/llm/telemetry.js'

test('engine event carries metadata only, no prompt fields', () => {
  const e = buildEngineEvent('remote', { latencyMs: 42 })
  assert.equal(e.kind, 'llm-engine')
  const d = JSON.parse(e.detail)
  assert.deepEqual(Object.keys(d).sort(), ['engine', 'latencyMs'])
  assert.equal(d.engine, 'remote')
})

test('circuit event reduces snapshot to leg states', () => {
  const e = buildCircuitEvent({ remote: { state: 'open' }, local: { state: 'closed' } })
  assert.deepEqual(JSON.parse(e.detail), { legs: { remote: 'open', local: 'closed' } })
})

test('hooks call ingestFn with app zode and never throw on failure', async () => {
  const calls = []
  const hooks = createTelemetryHooks({ ingestFn: async (...a) => { calls.push(a) } })
  hooks.onEngine('local')
  hooks.onCircuit({ local: { state: 'closed' } })
  await new Promise(r => setTimeout(r, 20))
  assert.equal(calls.length, 2)
  assert.equal(calls[0][0], 'zode')

  const bad = createTelemetryHooks({ ingestFn: async () => { throw new Error('down') } })
  bad.onEngine('remote') // must not throw
  await new Promise(r => setTimeout(r, 20))
})
