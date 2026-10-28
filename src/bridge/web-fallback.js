/**
 * @file The §6 web fallback shim — the bridge when there is no native shell.
 *
 * The shim answers exactly the same request types as a native shell, so the
 * app code never branches on the platform:
 *
 *   • haptics  → WebAudio synthesis of `haptics.json` (`web-audio-haptics.js`)
 *   • attach   → `<input type="file" multiple>`
 *   • notify   → the Notification API
 *   • search   → the in-memory library
 *   • window   → the Fullscreen API
 *   • journal  → a local activity log (browsers have no system journal)
 *
 * @module bridge/web-fallback
 */

import { BridgeError, CONTRACT_VERSION, REQUEST_TYPES } from './contract.js';
import { HapticSynthesizer, loadHapticsPrograms } from './web-audio-haptics.js';
import { seedThreads, files, seedAgents } from '../data.js';

function searchWorkspace(query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return [];
  const results = [];
  for (const t of seedThreads) {
    if (t.title.toLowerCase().includes(q) || (t.scope && t.scope.toLowerCase().includes(q))) {
      results.push({ id: t.id, kind: 'task', title: t.title, subtitle: t.scope || t.project });
    }
  }
  for (const f of files) {
    if (f.name.toLowerCase().includes(q) || f.folder.toLowerCase().includes(q)) {
      results.push({ id: f.name, kind: 'file', title: f.name, subtitle: f.folder });
    }
  }
  for (const a of seedAgents) {
    if (a.name.toLowerCase().includes(q) || a.phase.toLowerCase().includes(q)) {
      results.push({ id: a.id, kind: 'action', title: a.name, subtitle: a.phase });
    }
  }
  return results;
}

/**
 * @typedef {import('./contract.js').BridgeError} BridgeErrorType
 * @typedef {import('./transport.js').Envelope} Envelope
 */

/**
 * @typedef {object} Attachment
 * @property {string} id
 * @property {string} name
 * @property {string} path
 * @property {string} mimeType
 * @property {number} size
 * @property {'dock'|'drop'|'picker'|'share'|'intent'} source
 */

/**
 * Turn a `File` into a contract attachment.
 *
 * @param {File} file
 * @param {Attachment['source']} source
 * @param {number} ordinal
 * @returns {Attachment}
 */
function toAttachment(file, source, ordinal) {
  const name = file?.name ?? 'untitled';
  return {
    id: `att-${ordinal}-${name}`,
    name,
    path: '',
    mimeType: file?.type || 'application/octet-stream',
    size: Number(file?.size ?? 0),
    source,
  };
}

/**
 * Create the browser implementation of the bridge.
 *
 * @param {object} [options]
 * @param {Document} [options.doc]
 * @param {any} [options.win]
 * @param {(event: string, payload: any) => boolean} [options.emit] deliver an event to the app
 * @param {(intent: string, payload: Record<string, unknown>) => Promise<any>} [options.performIntent]
 * @param {(query: string) => any[]} [options.search]
 * @param {() => Promise<Record<string, any>>} [options.loadPrograms]
 * @param {(entry: any) => void} [options.onJournal]
 * @returns {object} the fallback
 */
export function createWebFallback({
  doc = globalThis.document,
  win = globalThis,
  emit = () => false,
  performIntent = async () => ({ ok: false, message: 'No intent handler registered' }),
  search = (query) => searchWorkspace(query),
  loadPrograms = () => loadHapticsPrograms(),
  onJournal = () => {},
} = {}) {
  /** @type {HapticSynthesizer} */
  const synth = new HapticSynthesizer({ programs: {} });
  /** @type {Promise<Record<string, any>>|null} */
  let programsPromise = null;
  let attachmentCounter = 0;
  /** @type {{title: string, body: string, date: string}[]} */
  const journalLog = [];

  const loadProgramsOnce = () => {
    if (!programsPromise) {
      programsPromise = loadPrograms().then((programs) => {
        synth.programs = programs ?? {};
        return synth.programs;
      });
    }
    return programsPromise;
  };

  // Browsers refuse to start an AudioContext before a user gesture, so we
  // unlock on the first interaction (contract §6 relies on real audio output).
  const unlockAudio = () => {
    synth.unlock().catch(() => {});
  };
  if (doc && typeof doc.addEventListener === 'function') {
    doc.addEventListener('pointerdown', unlockAudio, { once: true });
    doc.addEventListener('keydown', unlockAudio, { once: true });
  }

  // ---------------------------------------------------------------- picker
  /**
   * Show the browser file picker.
   * @returns {Promise<Attachment[]>}
   */
  const pickFiles = () =>
    new Promise((resolve) => {
      if (!doc || typeof doc.createElement !== 'function') {
        resolve([]);
        return;
      }
      const input = doc.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.setAttribute('data-zode-file-input', 'true');
      input.style.setProperty('position', 'fixed');
      input.style.setProperty('left', '-10000px');
      input.style.setProperty('width', '1px');
      input.style.setProperty('height', '1px');
      input.addEventListener('change', () => {
        const files = Array.from(input.files ?? []);
        const attachments = files.map((file) => toAttachment(file, 'picker', ++attachmentCounter));
        if (typeof input.remove === 'function') input.remove();
        resolve(attachments);
      });
      const body = doc.body ?? doc.documentElement;
      body.appendChild(input);
      input.click();
    });

  // ------------------------------------------------------------------ drop
  // Contract §8: dropping anywhere on the window must work. In a browser the
  // web view *is* the window, so the document level drop handler is the
  // equivalent of the native full-window drop target.
  if (doc && typeof doc.addEventListener === 'function') {
    doc.addEventListener('dragover', (event) => {
      event.preventDefault?.();
    });
    doc.addEventListener('drop', (event) => {
      event.preventDefault?.();
      const files = Array.from(event.dataTransfer?.files ?? []);
      for (const file of files) {
        const attachment = toAttachment(file, 'drop', ++attachmentCounter);
        emit('attachment', attachment);
      }
    });
  }

  // ------------------------------------------------------- notifications
  /**
   * Post a notification through the Notification API.
   * @param {{title: string, body: string, id?: string, urgency?: string}} options
   * @returns {Promise<void>}
   */
  const notify = async ({ title, body, id, urgency }) => {
    const Ctor =
      /** @type {any} */ (win).Notification ?? /** @type {any} */ (globalThis).Notification;
    if (!Ctor) return; // no Notification API — silently ignore
    try {
      if (Ctor.permission === 'granted') {
        new Ctor(title, { body, tag: id, requireInteraction: urgency === 'critical' });
        return;
      }
      if (Ctor.permission === 'default') {
        const permission = await Ctor.requestPermission();
        if (permission === 'granted') {
          new Ctor(title, { body, tag: id, requireInteraction: urgency === 'critical' });
        }
      }
    } catch {
      /* notifications are a nicety — never break the app over them */
    }
  };

  // ----------------------------------------------------------- fullscreen
  /**
   * @returns {boolean}
   */
  const isFullScreen = () => Boolean(doc?.fullscreenElement);

  /**
   * @param {boolean} fullScreen
   * @returns {Promise<boolean>} the resulting state
   */
  const setFullScreen = async (fullScreen) => {
    const root = doc?.documentElement;
    try {
      if (fullScreen && !isFullScreen()) {
        if (root?.requestFullscreen) {
          await root.requestFullscreen();
          return true;
        }
        return false;
      }
      if (!fullScreen && isFullScreen()) {
        if (doc?.exitFullscreen) {
          await doc.exitFullscreen();
        }
        return false;
      }
    } catch {
      return isFullScreen();
    }
    return isFullScreen();
  };

  // -------------------------------------------------------------- requests
  /**
   * Handle one request envelope. Mirrors the request table of contract §3.
   *
   * @param {string} type
   * @param {Record<string, any>} payload
   * @returns {Promise<Record<string, any>>}
   */
  const handleRequest = async (type, payload = {}) => {
    switch (type) {
      case 'haptic.play': {
        await loadProgramsOnce();
        await synth.play(String(payload.program ?? ''), { loop: Boolean(payload.loop) });
        return {};
      }
      case 'haptic.stop': {
        synth.stop(String(payload.program ?? ''));
        return {};
      }
      case 'attach.pick': {
        const attachments = await pickFiles();
        return { attachments };
      }
      case 'notify.post': {
        await notify(payload);
        return {};
      }
      case 'intent.perform': {
        const result = await performIntent(String(payload.intent ?? ''), payload.payload ?? {});
        return { result };
      }
      case 'journal.write': {
        const entry = {
          title: String(payload.title ?? ''),
          body: String(payload.body ?? ''),
          date: String(payload.date ?? new Date().toISOString()),
        };
        journalLog.push(entry);
        onJournal(entry);
        return {};
      }
      case 'search.query': {
        const results = search(String(payload.query ?? ''));
        return { results };
      }
      case 'window.dragStart': {
        // Browsers cannot move their own window — the native shells do this.
        return {};
      }
      case 'window.toggleFill': {
        const filling = await setFullScreen(!isFullScreen());
        return { filling };
      }
      case 'window.setFullScreen': {
        await setFullScreen(Boolean(payload.fullScreen));
        return {};
      }
      case 'window.isFullScreen': {
        return { fullScreen: isFullScreen() };
      }
      case 'app.openPath': {
        throw new BridgeError('unsupported', 'A browser cannot open a local path');
      }
      case 'app.info': {
        const navigatorRef = /** @type {any} */ (win).navigator ?? globalThis.navigator;
        return {
          version: CONTRACT_VERSION,
          build: 'web',
          platform: 'web',
          deviceModel: navigatorRef?.userAgent ?? 'browser',
        };
      }
      default:
        throw new BridgeError('unsupported', `Unknown request type "${String(type)}"`);
    }
  };

  return {
    platform: 'web',
    handleRequest,
    /** @param {string} type every request type of contract §3 is answered by the shim */
    supportsRequest: (type) => REQUEST_TYPES.includes(type),
    synth,
    journalLog,
    pickFiles,
    notify,
    isFullScreen,
    setFullScreen,
  };
}
