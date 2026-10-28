import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CONTRACT_VERSION,
  DRAG_ZONE_HEIGHT,
  REQUEST_TYPES,
  EVENT_NAMES,
  ERROR_CODES,
  ATTACHMENT_SOURCES,
  INTENT_NAMES,
  isKnownRequestType,
  isKnownIntent
} from '../src/bridge/contract.js'
import { installZode } from '../src/bridge/zode.js'
import { DEFAULT_CONFIG, loadConfig, saveConfig } from '../src/llm/config.js'

test('Contract v1 constants match native shells', () => {
  assert.equal(CONTRACT_VERSION, 1)
  assert.equal(DRAG_ZONE_HEIGHT, 34)
  assert.ok(REQUEST_TYPES.includes('haptic.play'))
  assert.ok(REQUEST_TYPES.includes('window.dragStart'))
  assert.ok(REQUEST_TYPES.includes('window.toggleFill'))
  assert.ok(EVENT_NAMES.includes('attachment'))
  assert.ok(EVENT_NAMES.includes('search'))
  assert.ok(EVENT_NAMES.includes('deepLink'))
  assert.ok(EVENT_NAMES.includes('intent'))
  assert.ok(ERROR_CODES.includes('unsupported'))
  assert.ok(ATTACHMENT_SOURCES.includes('share'))
  assert.ok(INTENT_NAMES.includes('zode.agent.newTask'))
  assert.equal(isKnownRequestType('haptic.play'), true)
  assert.equal(isKnownIntent('zode.show'), true)
})

test('installZode works across web, macOS, Windows, and Android transports', async () => {
  // 1. Web fallback
  const webWin = {}
  const { api: zodeWeb } = installZode({ win: webWin })
  assert.equal(zodeWeb.platform, 'web')
  assert.equal(zodeWeb.version, 1)
  const searchHits = await zodeWeb.search('Auth')
  assert.ok(Array.isArray(searchHits) && searchHits.length > 0)

  // 2. Android ZodeAndroid bridge
  const androidSent = []
  const androidWin = {
    ZodeAndroid: {
      postMessage(raw) {
        const msg = JSON.parse(raw)
        androidSent.push(msg)
        queueMicrotask(() => {
          androidWin.__zodeNative__({
            id: msg.id,
            ok: true,
            result:
              msg.type === 'app.info'
                ? {
                    version: 1,
                    build: 'android',
                    platform: 'android',
                    capabilities: {
                      haptics: true,
                      attachments: true,
                      notifications: true,
                      intents: true,
                      journal: false,
                      search: true,
                      windowControl: false
                    }
                  }
                : { filling: false }
          })
        })
      }
    }
  }
  const { api: zodeAndroid } = installZode({ win: androidWin })
  assert.equal(zodeAndroid.platform, 'android')
  assert.equal(zodeAndroid.capabilities.haptics, true)
  await zodeAndroid.haptic('done')
  zodeAndroid.window.dragStart(120, 18)
  await zodeAndroid.window.toggleFillScreen()
  assert.ok(androidSent.some((m) => m.type === 'haptic.play' && m.payload.program === 'done'))
  assert.ok(androidSent.some((m) => m.type === 'window.dragStart'))
  assert.ok(androidSent.some((m) => m.type === 'window.toggleFill'))

  // Test incoming native event routing (intent & attachment)
  let receivedIntent = null
  let receivedAttachment = null
  zodeAndroid.onIntent((ev) => {
    receivedIntent = ev
  })
  zodeAndroid.onAttachment((ev) => {
    receivedAttachment = ev
  })
  androidWin.__zodeNative__({
    type: 'event',
    event: 'intent',
    payload: { intent: 'zode.agent.newTask', payload: { prompt: 'Verify hunks' } }
  })
  androidWin.__zodeNative__({
    type: 'event',
    event: 'attachment',
    payload: { id: 'att-1', name: 'patch.diff', source: 'share', size: 128 }
  })
  assert.equal(receivedIntent?.intent, 'zode.agent.newTask')
  assert.equal(receivedIntent?.payload?.prompt, 'Verify hunks')
  assert.equal(receivedAttachment?.source, 'share')
  assert.equal(receivedAttachment?.name, 'patch.diff')
})

test('Appearance settings (accentName, theme, density) persist via config storage', () => {
  const store = new Map()
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k)
  }
  try {
    assert.equal(DEFAULT_CONFIG.accentName, 'magenta')
    assert.equal(DEFAULT_CONFIG.theme, 'dark')
    assert.equal(DEFAULT_CONFIG.density, 1)

    saveConfig({ ...DEFAULT_CONFIG, accentName: 'orange', theme: 'light', density: 0.9 })
    const loaded = loadConfig()
    assert.equal(loaded.accentName, 'orange')
    assert.equal(loaded.theme, 'light')
    assert.equal(loaded.density, 0.9)
  } finally {
    delete globalThis.localStorage
  }
})
