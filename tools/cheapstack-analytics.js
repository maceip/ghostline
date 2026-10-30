// GENERATED from gcp-cheap-stack clients/typescript v1.0.0 - do not edit; regenerate with npm run build there.
/**
 * Cheap Stack Analytics — a tiny, fail-open analytics client.
 *
 * Replaces the slice of Google Analytics / Heap / Firebase that a solo
 * developer actually uses: sessions, screens, custom events, and errors,
 * shipped to your own cheap-stack ingest (Cloud Run -> BigQuery).
 *
 * Rules baked in:
 * - FAIL-OPEN: analytics never throws into the host app and never blocks UI.
 *   Network failures drop events after bounded retries.
 * - PRIVACY-LEAN: no fingerprinting. An anonymous id + a user id you choose
 *   to identify() with. Never send prompt text, secrets, or file contents.
 * - Sessions: 30-minute inactivity timeout (configurable), heartbeat carries
 *   elapsed session duration so "how long" is answerable from BigQuery.
 */
const DEFAULT_ENDPOINT = 'https://cheap-stack-api-4mvkrnysdq-uc.a.run.app';
const ANON_KEY = 'cs.anonId';
const SESSION_KEY = 'cs.session';
function defaultStorage() {
    try {
        return globalThis.localStorage ?? null;
    }
    catch {
        return null;
    }
}
function defaultId() {
    const c = globalThis.crypto;
    if (c?.randomUUID)
        return c.randomUUID();
    return `id-${Date.now()}-${Math.floor(Math.random() * 1e12)}`;
}
export class Analytics {
    cfg;
    nowFn;
    idFn;
    storage;
    queue = [];
    flushTimer = null;
    heartbeatTimer = null;
    sessionId = '';
    sessionStartedAt = 0;
    lastActiveAt = 0;
    userId;
    anonymousId;
    flushing = false;
    constructor(config) {
        if (!config.app)
            throw new Error('AnalyticsConfig.app is required');
        this.cfg = {
            app: config.app,
            endpoint: (config.endpoint ?? DEFAULT_ENDPOINT).replace(/\/$/, ''),
            token: config.token ?? '',
            release: config.release ?? '',
            platform: config.platform ?? (typeof window !== 'undefined' ? 'web' : 'node'),
            sessionTimeoutMs: config.sessionTimeoutMs ?? 30 * 60_000,
            heartbeatMs: config.heartbeatMs ?? 60_000,
            flushIntervalMs: config.flushIntervalMs ?? 5_000,
            maxBatch: config.maxBatch ?? 25,
            autoPageviews: config.autoPageviews ?? true,
            autoErrors: config.autoErrors ?? true,
            fetchImpl: config.fetchImpl,
        };
        this.nowFn = config.nowFn ?? (() => Date.now());
        this.idFn = config.idFn ?? defaultId;
        this.storage = config.storage === undefined ? defaultStorage() : config.storage;
        this.anonymousId = this.readStored(ANON_KEY) ?? this.idFn();
        this.writeStored(ANON_KEY, this.anonymousId);
        this.resumeOrStartSession('init');
        this.startTimers();
        if (typeof window !== 'undefined') {
            if (this.cfg.autoPageviews)
                this.installPageviews();
            if (this.cfg.autoErrors)
                this.installErrorHandlers();
            document?.addEventListener?.('visibilitychange', () => {
                if (document.visibilityState === 'hidden')
                    this.onHidden();
                else
                    this.resumeOrStartSession('visible');
            });
            window.addEventListener?.('pagehide', () => this.onHidden());
        }
    }
    // ---------- public API ----------
    identify(userId, traits = {}) {
        this.userId = userId;
        this.track('identify', traits);
    }
    track(name, props = {}) {
        this.resumeOrStartSession('track');
        this.enqueue(name, props);
    }
    screen(name, props = {}) {
        this.track('screen', { screen: name, ...props });
    }
    pageView(path) {
        const p = path ?? (typeof location !== 'undefined' ? location.pathname : '');
        this.track('page_view', { path: p });
    }
    captureError(error, context = {}) {
        const e = error instanceof Error ? error : new Error(String(error));
        this.enqueue('error', {
            message: e.message.slice(0, 500),
            name: e.name,
            stack: (e.stack ?? '').slice(0, 2000),
            ...context,
        });
        void this.flush();
    }
    /** Send queued events now. Never throws. */
    async flush() {
        if (this.flushing || this.queue.length === 0)
            return;
        if (!this.cfg.token) {
            this.queue = [];
            return;
        } // fail-open: nowhere to send
        this.flushing = true;
        try {
            const doFetch = this.cfg.fetchImpl ?? globalThis.fetch?.bind(globalThis);
            if (!doFetch) {
                this.queue = [];
                return;
            }
            while (this.queue.length > 0) {
                const batch = this.queue.splice(0, this.cfg.maxBatch);
                for (const ev of batch) {
                    try {
                        const res = await doFetch(`${this.cfg.endpoint}/api/events/${encodeURIComponent(this.cfg.app)}`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.cfg.token}` },
                            body: JSON.stringify({ kind: ev.kind, detail: JSON.stringify(ev.detail) }),
                            keepalive: true,
                        });
                        if (!res.ok)
                            throw new Error(`HTTP ${res.status}`);
                    }
                    catch {
                        // One retry, then drop. Telemetry must never wedge the queue.
                        try {
                            await doFetch(`${this.cfg.endpoint}/api/events/${encodeURIComponent(this.cfg.app)}`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.cfg.token}` },
                                body: JSON.stringify({ kind: ev.kind, detail: JSON.stringify(ev.detail) }),
                                keepalive: true,
                            });
                        }
                        catch { /* dropped */ }
                    }
                }
            }
        }
        catch { /* fail-open */ }
        finally {
            this.flushing = false;
        }
    }
    shutdown() {
        this.endSession('shutdown');
        if (this.flushTimer)
            clearInterval(this.flushTimer);
        if (this.heartbeatTimer)
            clearInterval(this.heartbeatTimer);
        void this.flush();
    }
    get currentSessionId() { return this.sessionId; }
    // ---------- internals ----------
    readStored(k) {
        try {
            return this.storage?.getItem(k) ?? null;
        }
        catch {
            return null;
        }
    }
    writeStored(k, v) {
        try {
            this.storage?.setItem(k, v);
        }
        catch { /* private mode */ }
    }
    resumeOrStartSession(reason) {
        const now = this.nowFn();
        // In-memory session wins (covers storage-less runtimes like Node/tests).
        if (this.sessionId && now - this.lastActiveAt <= this.cfg.sessionTimeoutMs) {
            this.lastActiveAt = now;
            this.persistSession();
            return;
        }
        const stored = this.readStored(SESSION_KEY);
        let parsed = null;
        try {
            parsed = stored ? JSON.parse(stored) : null;
        }
        catch {
            parsed = null;
        }
        const idleTooLong = !parsed || now - parsed.last > this.cfg.sessionTimeoutMs;
        if (idleTooLong) {
            this.sessionId = this.idFn();
            this.sessionStartedAt = now;
            this.lastActiveAt = now;
            this.persistSession();
            this.enqueue('session_start', { reason });
        }
        else {
            this.sessionId = parsed.id;
            this.sessionStartedAt = parsed.startedAt;
            this.lastActiveAt = now;
            this.persistSession();
        }
    }
    persistSession() {
        this.writeStored(SESSION_KEY, JSON.stringify({
            id: this.sessionId, startedAt: this.sessionStartedAt, last: this.lastActiveAt,
        }));
    }
    endSession(reason) {
        if (!this.sessionId)
            return;
        this.enqueue('session_end', { reason });
    }
    onHidden() {
        this.enqueue('session_heartbeat', { reason: 'hidden' });
        // sendBeacon survives page unload; fetch keepalive is the fallback in flush().
        void this.flush();
    }
    enqueue(kind, props) {
        const now = this.nowFn();
        this.lastActiveAt = now;
        this.queue.push({
            kind,
            detail: {
                ts: new Date(now).toISOString(),
                sessionId: this.sessionId,
                anonymousId: this.anonymousId,
                userId: this.userId,
                release: this.cfg.release || undefined,
                platform: this.cfg.platform,
                sessionMs: Math.max(0, now - this.sessionStartedAt),
                props,
            },
        });
        if (this.queue.length > 500)
            this.queue.splice(0, this.queue.length - 500); // bounded memory
        this.persistSession();
    }
    startTimers() {
        this.flushTimer = setInterval(() => void this.flush(), this.cfg.flushIntervalMs);
        this.flushTimer.unref?.();
        if (this.cfg.heartbeatMs > 0) {
            this.heartbeatTimer = setInterval(() => {
                if (typeof document === 'undefined' || document.visibilityState !== 'hidden') {
                    this.enqueue('session_heartbeat', {});
                }
            }, this.cfg.heartbeatMs);
            this.heartbeatTimer.unref?.();
        }
    }
    installPageviews() {
        this.pageView();
        const orig = history.pushState.bind(history);
        history.pushState = (...args) => {
            orig(...args);
            this.pageView();
        };
        window.addEventListener('popstate', () => this.pageView());
    }
    installErrorHandlers() {
        window.addEventListener('error', (e) => {
            this.captureError(e.error ?? new Error(e.message), { source: 'window.onerror' });
        });
        window.addEventListener('unhandledrejection', (e) => {
            this.captureError(e.reason, { source: 'unhandledrejection' });
        });
    }
}
/** Convenience singleton. */
let instance = null;
export function init(config) {
    instance ??= new Analytics(config);
    return instance;
}
export function analytics() {
    if (!instance)
        throw new Error('call init() first');
    return instance;
}
