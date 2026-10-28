/**
 * @file Zode native bridge — contract constants.
 *
 * The single source of truth is `packages/shared/contract.md` (v1, FROZEN).
 * Every constant in this file mirrors that document. If the contract and this
 * file ever disagree, the contract wins and this file must be updated in the
 * same change.
 *
 * The point of this module is to make a mismatch *loud*: every request type and
 * every intent name is validated against the lists below, so a typo in the web
 * app (or a shell that drifted) throws immediately instead of silently
 * swallowing a message.
 *
 * @module bridge/contract
 */

/** Contract version implemented by this web app (contract §12). */
export const CONTRACT_VERSION = 1;

/**
 * Height of the top drag strip in CSS pixels (contract §5).
 * Must match `--drag-zone-height` in `packages/shared/tokens.css`.
 */
export const DRAG_ZONE_HEIGHT = 34;

/**
 * Every request type the web app may send to a native shell (contract §3).
 * @type {readonly string[]}
 */
export const REQUEST_TYPES = Object.freeze([
  'haptic.play',
  'haptic.stop',
  'attach.pick',
  'notify.post',
  'intent.perform',
  'journal.write',
  'search.query',
  'window.dragStart',
  'window.toggleFill',
  'window.setFullScreen',
  'window.isFullScreen',
  'app.openPath',
  'app.info',
]);

/**
 * Every cross-platform intent name (contract §4).
 * @type {readonly string[]}
 */
export const INTENT_NAMES = Object.freeze([
  'zode.search',
  'zode.play',
  'zode.pause',
  'zode.next',
  'zode.previous',
  'zode.agent.newTask',
  'zode.agent.stop',
  'zode.attach',
  'zode.show',
]);

/**
 * The five views the app can navigate to (contract §4, `zode.show`).
 * @type {readonly string[]}
 */
export const VIEW_NAMES = Object.freeze([
  'now-playing',
  'collection',
  'library',
  'search',
  'agent',
]);

/**
 * Capability flags reported through `window.zode.capabilities` (contract §2).
 * @type {readonly string[]}
 */
export const CAPABILITY_KEYS = Object.freeze([
  'haptics',
  'attachments',
  'notifications',
  'intents',
  'journal',
  'search',
  'windowControl',
]);

/**
 * Error codes carried by a failed response envelope (contract §1.2).
 * @type {readonly string[]}
 */
export const ERROR_CODES = Object.freeze([
  'unsupported',
  'invalid',
  'denied',
  'cancelled',
  'notFound',
  'internal',
]);

/**
 * Where an attachment came from (contract §2.1).
 * @type {readonly string[]}
 */
export const ATTACHMENT_SOURCES = Object.freeze([
  'dock',
  'drop',
  'picker',
  'share',
  'intent',
]);

/**
 * Result kinds returned by the search index (contract §2.1).
 * @type {readonly string[]}
 */
export const SEARCH_RESULT_KINDS = Object.freeze([
  'track',
  'album',
  'artist',
  'playlist',
  'task',
  'file',
  'action',
]);

/**
 * Native → JS event names carried by an event envelope (contract §1.2, §2.2).
 * @type {readonly string[]}
 */
export const EVENT_NAMES = Object.freeze([
  'attachment',
  'intent',
  'search',
  'deepLink',
  'notificationAction',
]);

/**
 * An error that carries a contract error code.
 *
 * The bridge rejects promises with this type so the app can branch on
 * `error.code` (contract §1.2) instead of parsing strings.
 */
export class BridgeError extends Error {
  /**
   * @param {string} code one of {@link ERROR_CODES}
   * @param {string} message human readable detail
   */
  constructor(code, message) {
    super(message);
    this.name = 'BridgeError';
    this.code = ERROR_CODES.includes(code) ? code : 'internal';
  }
}

/**
 * @param {unknown} type
 * @returns {boolean} true when `type` is a request type defined by contract §3
 */
export function isKnownRequestType(type) {
  return typeof type === 'string' && REQUEST_TYPES.includes(type);
}

/**
 * @param {unknown} intent
 * @returns {boolean} true when `intent` is an intent name defined by contract §4
 */
export function isKnownIntent(intent) {
  return typeof intent === 'string' && INTENT_NAMES.includes(intent);
}

/**
 * @param {unknown} view
 * @returns {boolean} true when `view` is one of the five app views
 */
export function isKnownView(view) {
  return typeof view === 'string' && VIEW_NAMES.includes(view);
}

/**
 * Throw a loud error when a request type is not part of contract §3.
 * @param {string} type
 * @returns {void}
 */
export function assertKnownRequestType(type) {
  if (!isKnownRequestType(type)) {
    throw new BridgeError(
      'invalid',
      `Unknown request type "${String(type)}". Contract v${CONTRACT_VERSION} defines: ${REQUEST_TYPES.join(', ')}`,
    );
  }
}

/**
 * Throw a loud error when an intent name is not part of contract §4.
 * @param {string} intent
 * @returns {void}
 */
export function assertKnownIntent(intent) {
  if (!isKnownIntent(intent)) {
    throw new BridgeError(
      'invalid',
      `Unknown intent "${String(intent)}". Contract v${CONTRACT_VERSION} defines: ${INTENT_NAMES.join(', ')}`,
    );
  }
}

/**
 * Throw a loud error when a view name is not one of the five app views.
 * @param {string} view
 * @returns {void}
 */
export function assertKnownView(view) {
  if (!isKnownView(view)) {
    throw new BridgeError(
      'invalid',
      `Unknown view "${String(view)}". Known views: ${VIEW_NAMES.join(', ')}`,
    );
  }
}
