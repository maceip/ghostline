import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_CONFIG, loadConfig, remoteConfigured, bridgeConfigured } from '../src/llm/config.js'

test('config defaults: auto mode, lazy local model, motion families all configurable', () => {
  assert.equal(DEFAULT_CONFIG.mode, 'auto')
  assert.match(DEFAULT_CONFIG.localModelUrl, /\.litertlm$/)
  assert.equal(DEFAULT_CONFIG.bgPreload, true)
  assert.ok(DEFAULT_CONFIG.remoteTimeoutMs >= 5000, 'remote needs a real timeout budget')
  for (const k of ['tilt', 'spotlight', 'glow', 'shimmer', 'cascade']) {
    assert.equal(typeof DEFAULT_CONFIG.motion[k], 'boolean', `motion.${k} must be a toggle`)
  }
})

test('loadConfig falls back to defaults without storage', () => {
  const c = loadConfig()
  assert.equal(c.mode, DEFAULT_CONFIG.mode)
  assert.equal(remoteConfigured(c), false)
  assert.equal(bridgeConfigured(c), false)
  assert.equal(remoteConfigured({ ...c, apiKey: ' sk-x ' }), true)
  assert.equal(bridgeConfigured({ ...c, bridgeUrl: 'http://127.0.0.1:17861' }), true)
})
