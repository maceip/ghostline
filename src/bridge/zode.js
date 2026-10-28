/**
 * @file The Zode bridge — installs `window.zode` (contract §2).
 *
 * `window.zode` is the ONLY surface the app talks to. This module owns it and
 * routes every call to the right place:
 *
 *   • macOS / Windows → the native shell over the message envelope of §1
 *   • plain browser    → the local fallback shim of §6
 *
 * The app never imports a transport, and never branches on the platform.
 *
 * @module bridge/zode
 */

import {
  BridgeError,
  CONTRACT_VERSION,
  CAPABILITY_KEYS,
  assertKnownIntent,
  assertKnownRequestType,
} from './contract.js';
import {
  createEnvelope,
  createLocalTransport,
  createNativeTransport,
  detectPlatform,
} from './transport.js';
import { createWebFallback } from './web-fallback.js';

/** How long we wait for a native response before giving up (contract §12). */
const NATIVE_TIMEOUT_MS = 20000;

/**
 * Default capability matrix per platform.
 *
 * `haptics` is only `true` when a *real* haptic engine exists — the WebAudio
 * fallback is explicitly not one (contract §2, §7), so it is `false` everywhere
 * until a shell reports otherwise through `app.info`.
 *
 * @type {Record<'macos'|'windows'|'web', Record<string, boolean>>}
 */
const DEFAULT_CAPABILITIES = {
  macos: {
    haptics: false,
    attachments: true,
    notifications: true,
    intents: true,
    journal: true,
    search: true,
    windowControl: true,
  },
  windows: {
    haptics: false,
    attachments: true,
    notifications: true,
    intents: true,
    journal: false, // Windows has no system journal (contract §11)
    search: false, // Windows App Content Search needs MSIX identity (§10)
    windowControl: true,
  },
  android: {
    haptics: true,
    attachments: true,
    notifications: true,
    intents: true,
    journal: false,
    search: true,
    windowControl: false,
  },
  web: {
    haptics: false, // audio synthesis is not a haptic engine (contract §6)
    attachments: true,
    notifications: true,
    intents: true,
    journal: false, // browsers have no system journal
    search: true, // the in-memory library
    windowControl: true, // fill/fullscreen works; window dragging does not
  },
};

/**
 * @typedef {import('./contract.js').Attachment} Attachment
 * @typedef {import('./contract.js').IntentResult} IntentResult
 * @typedef {import('./contract.js').SearchResult} SearchResult
 */

/**
 * The bridge. One instance per window.
 */
export class ZodeBridge {
  /**
   * @param {object} [options]
   * @param {any} [options.win]
   * @param {Document} [options.doc]
   * @param {'macos'|'windows'|'web'} [options.platform]
   * @param {Record<string, boolean>} [options.capabilities]
   */
  constructor({ win, doc, platform, capabilities } = {}) {
    // In a browser `globalThis === window`; inside a DOM stub (self check)
    // the window object lives on `globalThis.window`.
    this.win = win ?? globalThis.window ?? globalThis;
    this.doc = doc ?? globalThis.document ?? globalThis.document;
    this.platform = platform ?? detectPlatform(this.win);

    /** @type {Record<string, boolean>} */
    this._capabilities = {
      ...DEFAULT_CAPABILITIES[this.platform],
      ...(capabilities ?? {}),
    };
    /** @type {Map<string, Set<Function>>} */
    this._listeners = new Map();
    /** @type {Map<string, Function>} */
    this._intentHandlers = new Map();
    /** @type {Map<string, {resolve: Function, reject: Function, timer: any}>} */
    this._pending = new Map();
    /** @type {any} */
    this._transport = null;
    /** @type {any} */
    this._fallback = null;
    /** @type {{version?: number, build?: string, deviceModel?: string}} */
    this.info = {};

    this._buildTransport();
    this.api = this._buildApi();
  }

  /**
   * Create the transport for this platform.
   * @returns {void}
   */
  _buildTransport() {
    if (this.platform === 'web') {
      this._fallback = createWebFallback({
        doc: this.doc,
        win: this.win,
        emit: (event, payload) => this.emit(event, payload),
        performIntent: (intent, payload) => this.dispatchIntent(intent, payload),
      });
      this._transport = createLocalTransport((type, payload) =>
        this._fallback.handleRequest(type, payload),
      );
    } else {
      this._transport = createNativeTransport(this.win, this.platform);
      // Ask the shell what it can do; the answer refines the capability matrix.
      this.refreshInfo().catch(() => {});
    }
  }

  /**
   * Ask the native shell for `app.info` and merge any capability hints.
   * @returns {Promise<void>}
   */
  async refreshInfo() {
    if (this.platform === 'web') return;
    try {
      const info = await this.request('app.info', {});
      this.info = info ?? {};
      const reported = /** @type {any} */ (info)?.capabilities;
      if (reported && typeof reported === 'object') {
        for (const key of CAPABILITY_KEYS) {
          if (typeof reported[key] === 'boolean') this._capabilities[key] = reported[key];
        }
      }
    } catch {
      // A shell that does not implement `app.info` is fine (contract §12 says
      // it must answer with `unsupported`, which we simply ignore).
    }
  }

  // ------------------------------------------------------------------ api

  /**
   * Build the `window.zode` object (contract §2).
   * @returns {any}
   */
  _buildApi() {
    const bridge = this;
    return {
      /** @returns {'macos'|'windows'|'web'} */
      get platform() {
        return bridge.platform;
      },
      /** @returns {1} */
      get version() {
        return CONTRACT_VERSION;
      },
      /** @returns {Record<string, boolean>} */
      get capabilities() {
        const snapshot = {};
        for (const key of CAPABILITY_KEYS) snapshot[key] = Boolean(bridge._capabilities[key]);
        return Object.freeze(snapshot);
      },

      /**
       * @param {string} program
       * @param {{loop?: boolean}} [opts]
       * @returns {Promise<void>}
       */
      haptic(program, opts) {
        return bridge
          .request('haptic.play', { program, ...(opts && opts.loop ? { loop: true } : {}) })
          .then(() => undefined);
      },

      /**
       * @param {string} program
       * @returns {Promise<void>}
       */
      hapticStop(program) {
        return bridge.request('haptic.stop', { program }).then(() => undefined);
      },

      /** @returns {Promise<Attachment[]>} */
      attach() {
        return bridge.request('attach.pick', {}).then((result) => result?.attachments ?? []);
      },

      /**
       * @param {(attachment: Attachment) => void} cb
       * @returns {() => void} unsubscribe
       */
      onAttachment(cb) {
        return bridge.on('attachment', cb);
      },

      /**
       * @param {{title: string, body: string, id?: string, urgency?: 'normal'|'critical'}} opts
       * @returns {Promise<void>}
       */
      notify(opts) {
        return bridge.request('notify.post', { ...opts }).then(() => undefined);
      },

      /**
       * @param {(action: {id: string, action: string}) => void} cb
       * @returns {() => void} unsubscribe
       */
      onNotificationAction(cb) {
        return bridge.on('notificationAction', cb);
      },

      /**
       * @param {string} intent
       * @param {Record<string, unknown>} [payload]
       * @returns {Promise<IntentResult>}
       */
      performIntent(intent, payload) {
        return bridge.performIntent(intent, payload);
      },

      /**
       * @param {(intent: {intent: string, payload: Record<string, unknown>}) => void} cb
       * @returns {() => void} unsubscribe
       */
      onIntent(cb) {
        return bridge.on('intent', cb);
      },

      /**
       * @param {{title: string, body: string, date?: string}} entry
       * @returns {Promise<void>}
       */
      journal(entry) {
        return bridge.request('journal.write', { ...entry }).then(() => undefined);
      },

      /**
       * @param {string} query
       * @returns {Promise<SearchResult[]>}
       */
      search(query) {
        return bridge.request('search.query', { query }).then((result) => result?.results ?? []);
      },

      /**
       * @param {(q: {query: string}) => void} cb
       * @returns {() => void} unsubscribe
       */
      onSearch(cb) {
        return bridge.on('search', cb);
      },

      /** Window control (contract §5). */
      window: {
        /**
         * @param {number} screenX
         * @param {number} screenY
         * @returns {void}
         */
        dragStart(screenX, screenY) {
          bridge
            .request('window.dragStart', { screenX: Number(screenX) || 0, screenY: Number(screenY) || 0 })
            .catch(() => {});
        },
        /** @returns {Promise<boolean>} true when the window is now filling the screen */
        toggleFillScreen() {
          return bridge
            .request('window.toggleFill', {})
            .then((result) => Boolean(result?.filling));
        },
        /** @param {boolean} fullScreen @returns {Promise<void>} */
        setFullScreen(fullScreen) {
          return bridge.request('window.setFullScreen', { fullScreen: Boolean(fullScreen) }).then(
            () => undefined,
          );
        },
        /** @returns {Promise<boolean>} */
        isFullScreen() {
          return bridge.request('window.isFullScreen', {}).then((result) => Boolean(result?.fullScreen));
        },
      },

      /**
       * @param {(url: string) => void} cb
       * @returns {() => void} unsubscribe
       */
      onDeepLink(cb) {
        return bridge.on('deepLink', cb);
      },

      /**
       * @param {string} path
       * @returns {Promise<void>}
       */
      openPath(path) {
        return bridge.request('app.openPath', { path }).then(() => undefined);
      },
    };
  }

  /**
   * Install `window.zode` and the native event entry point.
   * @returns {any} the `window.zode` object
   */
  install() {
    this.win.zode = this.api;
    // Both shells deliver native events by evaluating `window.__zodeNative__(…)`
    // in the page (contract §1.1).
    this.win.__zodeNative__ = (message) => this.handleNativeMessage(message);
    return this.api;
  }

  // -------------------------------------------------------------- requests

  /**
   * Send a request to the shell (or the local fallback).
   *
   * @param {string} type one of the request types of contract §3
   * @param {Record<string, unknown>} [payload]
   * @returns {Promise<Record<string, any>>}
   */
  async request(type, payload = {}) {
    assertKnownRequestType(type);
    const envelope = createEnvelope(type, payload);

    if (this._transport.kind === 'local') {
      const response = await this._transport.post(envelope);
      if (!response.ok) {
        throw new BridgeError(
          response.error?.code ?? 'internal',
          response.error?.message ?? `Request "${type}" failed`,
        );
      }
      return response.result ?? {};
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(envelope.id);
        reject(new BridgeError('internal', `Native request "${type}" timed out`));
      }, NATIVE_TIMEOUT_MS);
      this._pending.set(envelope.id, { resolve, reject, timer });
      try {
        this._transport.post(envelope);
      } catch (error) {
        this._pending.delete(envelope.id);
        clearTimeout(timer);
        reject(new BridgeError('internal', `Could not post "${type}": ${String(error)}`));
      }
    });
  }

  /**
   * Handle a message pushed by the native shell.
   *
   * @param {any} message an envelope from contract §1.2
   * @returns {void}
   */
  handleNativeMessage(message) {
    if (!message || typeof message !== 'object') return;

    if (message.type === 'event') {
      this.emit(String(message.event), message.payload ?? {});
      return;
    }

    if (typeof message.id === 'string') {
      const pending = this._pending.get(message.id);
      if (!pending) return; // unknown response — drop it
      this._pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.ok) pending.resolve(message.result ?? {});
      else {
        pending.reject(
          new BridgeError(
            message.error?.code ?? 'internal',
            message.error?.message ?? 'The native shell reported an error',
          ),
        );
      }
    }
  }

  // -------------------------------------------------------------- listeners

  /**
   * Subscribe to a native event.
   *
   * @param {string} event
   * @param {Function} cb
   * @returns {() => void} unsubscribe (safe to call twice)
   */
  on(event, cb) {
    if (typeof cb !== 'function') {
      throw new TypeError(`zode.on("${event}") needs a function`);
    }
    let bucket = this._listeners.get(event);
    if (!bucket) {
      bucket = new Set();
      this._listeners.set(event, bucket);
    }
    bucket.add(cb);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      bucket.delete(cb);
      if (bucket.size === 0) this._listeners.delete(event);
    };
  }

  /**
   * Deliver an event to its listeners.
   *
   * Contract §2.2: a native event with no listener is dropped, never buffered.
   *
   * @param {string} event
   * @param {any} payload
   * @returns {boolean} true when at least one listener received the event
   */
  emit(event, payload) {
    const bucket = this._listeners.get(event);
    if (!bucket || bucket.size === 0) return false;
    for (const cb of [...bucket]) {
      try {
        cb(payload);
      } catch (error) {
        console.error(`[zode] listener for "${event}" threw`, error);
      }
    }
    return true;
  }

  // ---------------------------------------------------------------- intents

  /**
   * Register an app level intent handler (contract §4).
   *
   * @param {string} intent
   * @param {(payload: Record<string, unknown>) => any} handler
   * @returns {() => void} unsubscribe
   */
  registerIntentHandler(intent, handler) {
    assertKnownIntent(intent);
    if (typeof handler !== 'function') {
      throw new TypeError(`Intent "${intent}" needs a function handler`);
    }
    this._intentHandlers.set(intent, handler);
    return () => {
      if (this._intentHandlers.get(intent) === handler) this._intentHandlers.delete(intent);
    };
  }

  /**
   * Run an intent.
   *
   * The app's own handler wins; when there is none the request is forwarded to
   * the native shell so it can implement the intent natively.
   *
   * @param {string} intent
   * @param {Record<string, unknown>} [payload]
   * @returns {Promise<IntentResult>}
   */
  async performIntent(intent, payload = {}) {
    assertKnownIntent(intent);
    const handler = this._intentHandlers.get(intent);
    if (handler) {
      try {
        const value = await handler(payload ?? {});
        return { ok: true, value };
      } catch (error) {
        return { ok: false, message: String(/** @type {any} */ (error)?.message ?? error) };
      }
    }
    if (this.platform === 'web') {
      return { ok: false, message: `No handler for intent "${intent}"` };
    }
    const result = await this.request('intent.perform', { intent, payload });
    return {
      ok: result?.ok !== false,
      value: result?.value,
      message: result?.message,
    };
  }

  /**
   * Handle an intent that arrived from outside the app (Siri, Shortcuts,
   * Spotlight, App Actions).
   *
   * @param {string} intent
   * @param {Record<string, unknown>} [payload]
   * @returns {Promise<IntentResult>}
   */
  async dispatchIntent(intent, payload = {}) {
    assertKnownIntent(intent);
    const handler = this._intentHandlers.get(intent);
    if (!handler) {
      return { ok: false, message: `No handler for intent "${intent}"` };
    }
    try {
      const value = await handler(payload ?? {});
      return { ok: true, value };
    } catch (error) {
      return { ok: false, message: String(/** @type {any} */ (error)?.message ?? error) };
    }
  }
}

/**
 * Install the bridge into a window.
 *
 * @param {object} [options] see {@link ZodeBridge}
 * @returns {{bridge: ZodeBridge, api: any}} the bridge and the `window.zode` object
 */
export function installZode(options = {}) {
  const bridge = new ZodeBridge(options);
  bridge.install();
  return { bridge, api: bridge.api };
}
