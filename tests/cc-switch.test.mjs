import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CIRCUIT_STATES,
  CircuitBreaker,
  CircuitBreakerRegistry,
  InlineThinkSplitter,
  splitLeadingThinkBlock,
  shouldRectifyThinkingSignature,
  rectifyAnthropicRequest,
  rectifyPiMessages,
  shouldRectifyThinkingBudget,
  rectifyThinkingBudget,
  anthropicBlockFromOpenAIReasoningItem,
  openAIReasoningItemFromAnthropicBlock,
  decodeOpenAIReasoningItem,
  OPENAI_REASONING_ITEM_PREFIX,
  countExistingCacheBreakpoints,
  injectCacheBreakpoints,
  stripOneMSuffix,
  stripOneMSuffixFromBody,
  ModelMapping,
  applyModelMapping,
  lookupPiModelCapabilities,
  isPiThinkingLevelMap,
  createLLMRouter,
} from '../src/llm/index.js'

// ============================================================================
// 1. CircuitBreaker & CircuitBreakerRegistry (ported from circuit_breaker.rs)
// ============================================================================
test('CircuitBreaker: closed -> open after failureThreshold, then half_open after cooldown, then closed after successThreshold', () => {
  let now = 1000
  const cb = new CircuitBreaker(
    { failureThreshold: 3, successThreshold: 2, timeoutSeconds: 60, maxHalfOpenRequests: 1 },
    () => now
  )

  assert.equal(cb.getState(), CIRCUIT_STATES.CLOSED)
  assert.equal(cb.allowRequest().allowed, true)

  cb.recordFailure(false, 'HTTP 502')
  cb.recordFailure(false, 'HTTP 502')
  assert.equal(cb.getState(), CIRCUIT_STATES.CLOSED)
  cb.recordFailure(false, 'HTTP 502')

  assert.equal(cb.getState(), CIRCUIT_STATES.OPEN)
  assert.equal(cb.allowRequest().allowed, false)
  assert.equal(cb.isAvailable(), false)

  // Advance clock past 60s timeout
  now += 61_000
  assert.equal(cb.isAvailable(), true)
  assert.equal(cb.getState(), CIRCUIT_STATES.HALF_OPEN)

  // First probe acquires the single half-open permit
  const firstProbe = cb.allowRequest()
  assert.equal(firstProbe.allowed, true)
  assert.equal(firstProbe.usedHalfOpenPermit, true)

  // Concurrent second request while probe is in-flight is rejected
  const secondProbe = cb.allowRequest()
  assert.equal(secondProbe.allowed, false)
  assert.equal(secondProbe.usedHalfOpenPermit, false)

  // First probe succeeds -> releases permit, stays half_open (needs 2 successes)
  cb.recordSuccess(firstProbe.usedHalfOpenPermit)
  assert.equal(cb.getState(), CIRCUIT_STATES.HALF_OPEN)

  // Next probe succeeds -> transitions to closed
  const thirdProbe = cb.allowRequest()
  assert.equal(thirdProbe.allowed, true)
  cb.recordSuccess(thirdProbe.usedHalfOpenPermit)
  assert.equal(cb.getState(), CIRCUIT_STATES.CLOSED)
})

test('CircuitBreaker: error rate threshold trips breaker even when consecutive failures < failureThreshold', () => {
  const cb = new CircuitBreaker({
    failureThreshold: 10,
    minRequests: 4,
    errorRateThreshold: 0.5,
  })
  cb.recordFailure(false)
  cb.recordSuccess(false)
  cb.recordSuccess(false)
  assert.equal(cb.getState(), CIRCUIT_STATES.CLOSED)
  // 2 failures out of 4 total = 50% >= 0.5 -> OPEN
  cb.recordFailure(false)
  assert.equal(cb.getState(), CIRCUIT_STATES.OPEN)
})

test('createLLMRouter: skips open primary circuit and routes directly to fallback without calling dead runner', async () => {
  let now = 10_000
  const router = createLLMRouter({
    circuitConfig: { failureThreshold: 2, timeoutSeconds: 30 },
    nowFn: () => now,
  })
  let remoteCalls = 0
  const runners = {
    bridge: async () => { throw new Error('unused') },
    remote: async () => { remoteCalls += 1; throw new Error('HTTP 529 overloaded') },
    local: async (req) => ({ text: `local handled (${req.diagnoseError || 'direct'})`, label: 'local' }),
    demo: async () => ({ text: 'demo' }),
  }
  const config = { mode: 'auto', apiKey: 'sk-test', bridgeUrl: '', circuitBreaker: { enabled: true, failureThreshold: 2, timeoutSeconds: 30 } }

  // Turn 1 & Turn 2 hit remote and fail -> trips remote circuit breaker
  await router.runTurn({ config, prompt: 'p1', runners })
  await router.runTurn({ config, prompt: 'p2', runners })
  assert.equal(remoteCalls, 2)
  assert.equal(router.getCircuitStats().remote.state, 'open')

  // Turn 3 fast-fails remote (circuit open) without invoking `runners.remote`!
  const r3 = await router.runTurn({ config, prompt: 'p3', runners })
  assert.equal(remoteCalls, 2, 'dead remote runner must not be invoked while circuit is open')
  assert.equal(r3.engine, 'local')
  assert.match(r3.fallbackFrom, /circuit open/)
})

// ============================================================================
// 2. InlineThinkSplitter & splitLeadingThinkBlock (ported from inline_think.rs)
// ============================================================================
function runSplitter(deltas) {
  const splitter = new InlineThinkSplitter()
  let thinking = ''
  let text = ''
  for (const d of deltas) {
    const out = splitter.push(d)
    if (out.thinking) thinking += out.thinking
    if (out.text) text += out.text
  }
  const tail = splitter.flush()
  if (tail.thinking) thinking += tail.thinking
  if (tail.text) text += tail.text
  return { thinking, text }
}

test('InlineThinkSplitter: splits <think> and <thinking>, tolerates mismatched tags, and is chunk-size invariant', () => {
  assert.deepEqual(runSplitter(['<think>a</think>b']), { thinking: 'a', text: 'b' })
  assert.deepEqual(runSplitter(['<thinking>a</thinking>b']), { thinking: 'a', text: 'b' })
  assert.deepEqual(runSplitter(['<think>a</thinking>b']), { thinking: 'a', text: 'b' })

  const response = '  \n<think>\r\nrea\nson\n</think>\r\n\n    return 42\n'
  const expected = { thinking: 'rea\nson', text: '    return 42\n' }
  assert.deepEqual(runSplitter([response]), expected)

  for (let chunkLen = 1; chunkLen < response.length; chunkLen++) {
    const parts = []
    for (let i = 0; i < response.length; i += chunkLen) {
      parts.push(response.slice(i, i + chunkLen))
    }
    assert.deepEqual(runSplitter(parts), expected, `chunkLen=${chunkLen}`)
  }

  // Held-back partial close tag that turns out not to be a close tag is released
  assert.deepEqual(
    runSplitter(['<think>a </th', 'ree> b</think>c']),
    { thinking: 'a </three> b', text: 'c' }
  )

  // Non-streaming helper matches
  assert.deepEqual(
    splitLeadingThinkBlock(' <thinking>\nrea\nson\n</thinking>\n\n    answer'),
    { thinking: 'rea\nson', text: '    answer' }
  )
  assert.equal(splitLeadingThinkBlock('hi <think>a</think>'), null)
})

// ============================================================================
// 3. Thinking Signature & Budget Rectifiers + Reasoning Bridge
// ============================================================================
test('shouldRectifyThinkingSignature & rectifyAnthropicRequest: detects all 7 failure modes and cleans payload', () => {
  assert.equal(shouldRectifyThinkingSignature('messages.1.content.0: Invalid `signature` in `thinking` block'), true)
  assert.equal(shouldRectifyThinkingSignature('Unable to submit request because Thought signature is not valid'), true)
  assert.equal(shouldRectifyThinkingSignature('a final `assistant` message must start with a thinking block'), true)
  assert.equal(shouldRectifyThinkingSignature('Expected `thinking` or `redacted_thinking`, but found `tool_use`'), true)
  assert.equal(shouldRectifyThinkingSignature('***.signature: Field required'), true)
  assert.equal(shouldRectifyThinkingSignature('xxx.signature: Extra inputs are not permitted'), true)
  assert.equal(shouldRectifyThinkingSignature('thinking or redacted_thinking blocks in the response cannot be modified'), true)
  assert.equal(shouldRectifyThinkingSignature('Request timeout'), false)

  const body = {
    model: 'claude-test',
    thinking: { type: 'enabled', budget_tokens: 1024 },
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 't', signature: 'sig' },
          { type: 'text', text: 'hello', signature: 'sig_text' },
          { type: 'tool_use', id: 'toolu_1', name: 'WebSearch', input: {}, signature: 'sig_tool' },
          { type: 'redacted_thinking', data: 'r', signature: 'sig_redacted' },
        ],
      },
    ],
  }

  const res = rectifyAnthropicRequest(body)
  assert.equal(res.applied, true)
  assert.equal(res.removedThinkingBlocks, 1)
  assert.equal(res.removedRedactedThinkingBlocks, 1)
  assert.equal(res.removedSignatureFields, 2)
  assert.equal(body.messages[0].content.length, 2)
  assert.equal(body.messages[0].content[0].signature, undefined)
  // Because removing the leading thinking block left tool_use without a thinking prefix while thinking.type === 'enabled',
  // top-level thinking is also removed:
  assert.equal(body.thinking, undefined)

  const piCleaned = rectifyPiMessages([
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'hmm', signature: 'bad' },
        { type: 'text', text: 'answer', signature: 'orphan' },
      ],
    },
  ])
  assert.equal(piCleaned.applied, true)
  assert.deepEqual(piCleaned.messages[0].content, [{ type: 'text', text: 'answer' }])
})

test('shouldRectifyThinkingBudget & rectifyThinkingBudget: normalizes budget_tokens to 32000 and max_tokens to 64000', () => {
  assert.equal(
    shouldRectifyThinkingBudget('thinking.budget_tokens: Input should be greater than or equal to 1024'),
    true
  )
  assert.equal(shouldRectifyThinkingBudget('budget_tokens must be less than max_tokens'), false)

  const body = {
    model: 'claude-test',
    thinking: { type: 'enabled', budget_tokens: 512 },
    max_tokens: 1024,
  }
  const r = rectifyThinkingBudget(body)
  assert.equal(r.applied, true)
  assert.equal(body.thinking.budget_tokens, 32000)
  assert.equal(body.max_tokens, 64000)
})

test('Reasoning Bridge: round-trips OpenAI Responses reasoning items through Anthropic thinking signatures and strips output-only fields', () => {
  const item = {
    id: 'rs_3',
    type: 'reasoning',
    summary: [{ type: 'summary_text', text: 'Need a tool.' }],
    encrypted_content: 'opaque',
    status: 'completed',
    content: [{ type: 'reasoning_text', text: 'output-only plaintext' }],
  }
  const block = anthropicBlockFromOpenAIReasoningItem(item)
  assert.equal(block.type, 'thinking')
  assert.equal(block.thinking, 'Need a tool.')
  assert.ok(block.signature.startsWith(OPENAI_REASONING_ITEM_PREFIX))

  const restored = openAIReasoningItemFromAnthropicBlock(block)
  assert.deepEqual(restored, {
    id: 'rs_3',
    type: 'reasoning',
    summary: [{ type: 'summary_text', text: 'Need a tool.' }],
    encrypted_content: 'opaque',
  })
  assert.deepEqual(decodeOpenAIReasoningItem(block.signature), restored)
})

// ============================================================================
// 4. Prompt Cache Breakpoint Injector (ported from cache_injector.rs)
// ============================================================================
test('injectCacheBreakpoints: injects up to 4 ephemeral cache breakpoints across tools, system, latest message, and prior user anchor', () => {
  const body = {
    model: 'claude-sonnet-4-5',
    tools: [{ name: 'tool1' }, { name: 'tool2' }],
    system: 'You are a helpful assistant',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'first' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'result' }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'hmm' },
          { type: 'text', text: 'latest' },
        ],
      },
    ],
  }

  const res = injectCacheBreakpoints(body)
  assert.deepEqual(res.injected, ['tools', 'system', 'msgs-latest', 'msgs-prior-user'])
  assert.equal(countExistingCacheBreakpoints(body), 4)
  assert.deepEqual(body.tools[1].cache_control, { type: 'ephemeral' })
  assert.deepEqual(body.system[0].cache_control, { type: 'ephemeral' })
  assert.deepEqual(body.messages[3].content[1].cache_control, { type: 'ephemeral' })
  assert.equal(body.messages[3].content[0].cache_control, undefined, 'never puts cache_control on thinking block')
  assert.deepEqual(body.messages[0].content[0].cache_control, { type: 'ephemeral' })
})

// ============================================================================
// 5. Tiered Model Mapper & Pi Model Catalog (ported from model_mapper.rs & piModelCatalog.ts)
// ============================================================================
test('ModelMapping & stripOneMSuffix: maps tier aliases, degrades fable -> opus, preserves subagent, and strips [1M]', () => {
  const mapping = new ModelMapping({
    ANTHROPIC_MODEL: 'default-model',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'haiku-mapped',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'sonnet-mapped',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'opus-mapped',
    CLAUDE_CODE_SUBAGENT_MODEL: 'anthropic/claude-opus-5.5',
  })

  assert.equal(mapping.mapModel('claude-sonnet-4-5-20250929'), 'sonnet-mapped')
  assert.equal(mapping.mapModel('claude-haiku-4-5'), 'haiku-mapped')
  // Fable falls back to opus when fableModel is unset
  assert.equal(mapping.mapModel('claude-fable-5[1m]'), 'opus-mapped')
  // Subagent catalog id maps back to configured subagent model instead of being swallowed by default
  assert.equal(mapping.mapModel('claude-opus-5-5[1M]'), 'opus-mapped')

  const subOnly = new ModelMapping({
    ANTHROPIC_MODEL: 'glm-5',
    CLAUDE_CODE_SUBAGENT_MODEL: 'anthropic/claude-opus-5.5',
  })
  assert.equal(subOnly.mapModel('claude-opus-5-5[1M]'), 'anthropic/claude-opus-5.5')

  const { body: mappedBody } = applyModelMapping({ model: 'claude-sonnet-4-6' }, { sonnetModel: 'deepseek-v4-pro [1M]' })
  const wireBody = stripOneMSuffixFromBody(mappedBody)
  assert.equal(wireBody.model, 'deepseek-v4-pro')
  assert.equal(stripOneMSuffix('claude-opus-5.5[1M]'), 'claude-opus-5.5')

  const cap = lookupPiModelCapabilities('claude-opus-5.5[1M]')
  assert.equal(cap.name, 'Claude Opus 5.5')
  assert.equal(cap.reasoning, true)
  assert.equal(cap.contextWindow, 1000000)
  assert.equal(isPiThinkingLevelMap(cap.thinkingLevelMap), true)
  assert.deepEqual(cap.compat, { forceAdaptiveThinking: true })
})
