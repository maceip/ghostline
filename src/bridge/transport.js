/**
 * @file Message envelope + transport detection (contract §1).
 *
 * The web app never touches a platform transport directly: this module is the
 * only place that knows how to hand an envelope to a shell.
 *
 *   macOS   → `window.webkit.messageHandlers.zode.postMessage(env)`
 *   Windows → `window.chrome.webview.postMessage(env)`
 *   Web     → the local fallback shim answers the request in-process (§6)
 *
 * @module bridge/transport
 */

import { assertKnownRequestType } from './contract.js';

/**
 * @typedef {object} Envelope
 * @property {string} id UUID echoed back by the shell on the response
 * @property {string} type one of the contract §3 request types
 * @property {Record<string, unknown>} payload type specific, always an object
 */

/**
 * @typedef {object} ResponseEnvelope
 * @property {string} id
 * @property {boolean} ok
 * @property {Record<string, unknown>} [result]
 * @property {{code: string, message: string}} [error]
 */

/**
 * @typedef {object} Transport
 * @property {'native'|'local'} kind
 * @property {'macos'|'windows'|'web'} platform
 * @property {(envelope: Envelope) => void|Promise<ResponseEnvelope>} post
 */

/**
 * Detect which shell (if any) is hosting the app.
 *
 * The order matters: a WebView2 build also exposes `window.chrome` but not
 * `window.chrome.webview`, and WKWebView exposes `window.webkit` but only
 * `webkit.messageHandlers.zode` identifies our handler.
 *
 * @param {any} [win] window-like object, defaults to `globalThis`
 * @returns {'macos'|'windows'|'web'}
 */
export function detectPlatform(win = globalThis) {
  const webkit = win && win.webkit;
  if (webkit && webkit.messageHandlers && webkit.messageHandlers.zode) return 'macos';
  const chrome = win && win.chrome;
  if (chrome && chrome.webview && typeof chrome.webview.postMessage === 'function') {
    return 'windows';
  }
  const androidBridge = win && win.ZodeAndroid;
  if (androidBridge && typeof androidBridge.postMessage === 'function') {
    return 'android';
  }
  return 'web';
}

/**
 * Create a RFC 4122-ish v4 UUID for the envelope id.
 *
 * `crypto.randomUUID` is used when available; otherwise we fall back to
 * `crypto.getRandomValues` and finally to `Math.random` so the bridge still
 * works in exotic webviews.
 *
 * @returns {string}
 */
export function createUuid() {
  const c = /** @type {any} */ (globalThis).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Build a request envelope (contract §1.2).
 *
 * @param {string} type request type, validated against contract §3
 * @param {Record<string, unknown>} [payload]
 * @returns {Envelope}
 */
export function createEnvelope(type, payload = {}) {
  assertKnownRequestType(type);
  return { id: createUuid(), type, payload: payload && typeof payload === 'object' ? payload : {} };
}

/**
 * Transport for a native shell: post the envelope, let the bridge await the
 * matching response envelope.
 *
 * @param {any} win
 * @param {'macos'|'windows'} platform
 * @returns {Transport}
 */
export function createNativeTransport(win, platform) {
  if (platform === 'android') {
    return {
      kind: 'native',
      platform,
      /** @param {Envelope} envelope */
      post(envelope) {
        win.ZodeAndroid.postMessage(JSON.stringify(envelope));
      },
    };
  }
  const handler =
    platform === 'macos'
      ? win.webkit.messageHandlers.zode
      : win.chrome.webview;
  return {
    kind: 'native',
    platform,
    /** @param {Envelope} envelope */
    post(envelope) {
      handler.postMessage(envelope);
    },
  };
}

/**
 * Transport for the plain browser: the local fallback answers the request and
 * hands back a response envelope (contract §6).
 *
 * @param {(type: string, payload: Record<string, unknown>) => Promise<unknown>|unknown} handleRequest
 * @returns {Transport}
 */
export function createLocalTransport(handleRequest) {
  return {
    kind: 'local',
    platform: 'web',
    /**
     * @param {Envelope} envelope
     * @returns {Promise<ResponseEnvelope>}
     */
    async post(envelope) {
      try {
        const result = await handleRequest(envelope.type, envelope.payload ?? {});
        return { id: envelope.id, ok: true, result: result ?? {} };
      } catch (error) {
        const code = /** @type {any} */ (error)?.code ?? 'internal';
        const message = /** @type {any} */ (error)?.message ?? String(error);
        return { id: envelope.id, ok: false, error: { code, message } };
      }
    },
  };
}
