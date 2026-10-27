import test from 'node:test'
import assert from 'node:assert/strict'
import { runTurn, historyFromTurns, diagnosisPrompt } from '../src/llm/router.js'

const cfg = (over = {}) => ({ mode: 'auto', provider: 'anthropic', apiKey: '', bridgeUrl: '', localModelUrl: 'm', ...over })
const ok = (text, label) => async () => ({ text, label })
const fail = (msg) => async () => { throw new Error(msg) }

test('auto with an api key uses remote and never touches local', async () => {
  let localCalled = false
  const r = await runTurn({
    config: cfg({ apiKey: 'sk-x' }), prompt: 'hi',
    runners: { bridge: fail('unused'), remote: ok('remote answer'), local: async () => { localCalled = true; return { text: 'local' } }, demo: ok('demo') },
  })
  assert.equal(r.engine, 'remote')
  assert.equal(r.text, 'remote answer')
  assert.equal(localCalled, false)
})

test('remote error routes to local in diagnose mode, tagged with the original error', async () => {
  let sawDiagnose = null
  const r = await runTurn({
    config: cfg({ apiKey: 'sk-x' }), prompt: 'explain the diff',
    runners: {
      bridge: fail('unused'), remote: fail('HTTP 401 invalid api key'),
      local: async (req) => { sawDiagnose = req.diagnoseError; return { text: 'your key is wrong; anyway…' } }, demo: ok('demo'),
    },
  })
  assert.equal(r.engine, 'local')
  assert.match(sawDiagnose, /401/)
  assert.match(r.fallbackFrom, /401/)
})

test('no key and no bridge goes straight to local (lazy first-chat path)', async () => {
  const r = await runTurn({
    config: cfg(), prompt: 'hi',
    runners: { bridge: fail('unused'), remote: fail('should not be called'), local: ok('local answer'), demo: ok('demo') },
  })
  assert.equal(r.engine, 'local')
})

test('bridge wins in auto when configured, and its failure falls through to remote', async () => {
  const r1 = await runTurn({
    config: cfg({ apiKey: 'sk', bridgeUrl: 'http://127.0.0.1:17861' }), prompt: 'hi',
    runners: { bridge: ok('from sidecar'), remote: ok('remote'), local: ok('local'), demo: ok('demo') },
  })
  assert.equal(r1.engine, 'bridge')
  const r2 = await runTurn({
    config: cfg({ apiKey: 'sk', bridgeUrl: 'http://127.0.0.1:17861' }), prompt: 'hi',
    runners: { bridge: fail('sidecar down'), remote: ok('remote'), local: ok('local'), demo: ok('demo') },
  })
  assert.equal(r2.engine, 'remote')
})

test('auto never silently fakes: when everything fails it throws with all causes', async () => {
  await assert.rejects(
    runTurn({
      config: cfg({ apiKey: 'sk' }), prompt: 'hi',
      runners: { bridge: fail('x'), remote: fail('HTTP 500'), local: fail('no WebGPU'), demo: ok('demo must not be used') },
    }),
    /all engines failed.*500.*WebGPU/,
  )
})

test('demo is explicit-only; local/remote modes are strict', async () => {
  const d = await runTurn({ config: cfg({ mode: 'demo', apiKey: 'sk' }), prompt: 'x', runners: { bridge: ok('b'), remote: ok('r'), local: ok('l'), demo: ok('demo!') } })
  assert.equal(d.engine, 'demo')
  await assert.rejects(runTurn({ config: cfg({ mode: 'local' }), prompt: 'x', runners: { bridge: ok('b'), remote: ok('r'), local: fail('no WebGPU'), demo: ok('d') } }), /WebGPU/)
})

test('empty engine output is an error, not an answer', async () => {
  await assert.rejects(
    runTurn({ config: cfg({ mode: 'local' }), prompt: 'x', runners: { bridge: ok('b'), remote: ok('r'), local: ok('   '), demo: ok('d') } }),
    /empty response/,
  )
})

test('historyFromTurns maps UI turns to chat history and drops empties', () => {
  const h = historyFromTurns([
    { actor: 'user', full: 'question', intent: 'q' },
    { actor: 'some-model', synthesis: 'answer' },
    { actor: 'queued', synthesis: '' },
    { actor: 'user', intent: 'follow-up' },
  ])
  assert.deepEqual(h, [
    { role: 'user', content: 'question' },
    { role: 'assistant', content: 'answer' },
    { role: 'user', content: 'follow-up' },
  ])
})

test('diagnosis prompt carries both the error and the original ask', () => {
  const p = diagnosisPrompt('review my diff', 'HTTP 401')
  assert.match(p, /401/)
  assert.match(p, /review my diff/)
})
