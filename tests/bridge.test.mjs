import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { bridgeTurn, bridgeHealthy } from '../src/llm/bridge.js'
import { runTurn } from '../src/llm/router.js'

/* loopback proof of the native-bridge leg: a real HTTP sidecar speaking
   BRIDGE.md (health + SSE turn), driven through the real router chain.
   This is the same wire a claude/codex sidecar would implement. */
function stubSidecar() {
  const seen = { bodies: [] }
  const server = createServer(async (req, res) => {
    if (req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ name: 'stub', version: '1' })); return }
    if (req.url === '/v1/turn') {
      let body = ''
      for await (const chunk of req) body += chunk
      seen.bodies.push(JSON.parse(body))
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: {"type":"trace","text":"stub · read 2 files"}\n')
      res.write('data: {"type":"token","text":"strict DPoP"}\n')
      res.write('data: {"type":"token","text":" verified."}\n')
      res.write('data: {"type":"done"}\n')
      res.end()
      return
    }
    res.writeHead(404); res.end()
  })
  return { server, seen }
}

test('bridge leg: health, SSE streaming, and router integration over real HTTP', async () => {
  const { server, seen } = stubSidecar()
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${server.address().port}`
  try {
    assert.equal(await bridgeHealthy(url), true)
    const tokens = []
    const traces = []
    const config = { mode: 'auto', bridgeUrl: url, apiKey: '', provider: 'anthropic', model: 'x' }
    const runners = {
      bridge: (req, hooks) => bridgeTurn(url, { sessionId: hooks.sessionId, ...req }, hooks),
      remote: async () => { throw new Error('remote must not be reached') },
      local: async () => { throw new Error('local must not be reached') },
      demo: async () => { throw new Error('demo must not be reached') },
    }
    const result = await runTurn({
      config, prompt: 'verify the fallback', history: [{ role: 'user', content: 'earlier' }], runners,
      hooks: { sessionId: 'board', onToken: (t) => tokens.push(t), onTrace: (t) => traces.push(t) },
    })
    assert.equal(result.engine, 'bridge')
    assert.equal(result.text, 'strict DPoP verified.')
    assert.deepEqual(tokens, ['strict DPoP', 'strict DPoP verified.'])
    assert.deepEqual(traces, ['stub · read 2 files'])
    assert.equal(seen.bodies[0].sessionId, 'board')
    assert.equal(seen.bodies[0].prompt, 'verify the fallback')
    assert.equal(seen.bodies[0].messages[0].content, 'earlier')
  } finally {
    server.close()
  }
})

test('bridge leg: unreachable sidecar fails loudly, never silently', async () => {
  assert.equal(await bridgeHealthy('http://127.0.0.1:1'), false)
  await assert.rejects(() => bridgeTurn('http://127.0.0.1:1', { sessionId: 's', system: '', history: [], prompt: 'x' }), /not reachable/)
})
