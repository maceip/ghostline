/**
 * @file WebAudio haptic waveform synthesiser.
 *
 * Turns a program from `packages/shared/haptics.json` into WebAudio nodes.
 *
 *   • one `OscillatorNode` per track, running at the track's `carrierHz`
 *   • the amplitude follows the track's intensity curve, applied to a
 *     `GainNode` with `setValueCurveAtTime`
 *   • the track's sharpness curve is mapped onto a subtle lowpass
 *     `BiquadFilterNode`, so dull programs sound dull and crisp programs
 *     sound crisp
 *   • `transient` tracks are short, exponentially decaying gain envelopes
 *   • `working` loops seamlessly: every iteration of the program is scheduled
 *     ahead of time with a look-ahead scheduler, so the loop point is
 *     inaudible
 *
 * NOTE FOR THE WINDOWS SHELL: the Windows shell MIRRORS this renderer. Windows
 * desktops have no rich haptic API (only a coarse on/off `IVibrationDevice`),
 * so contract §7 requires the waveform to be synthesised as audio through
 * WASAPI instead. Keep this file clean and well commented — it is the
 * reference implementation for that mirror, and the envelope/curve semantics
 * here are the ones the contract demands every renderer reproduce.
 *
 * @module bridge/web-audio-haptics
 */

import { BridgeError } from './contract.js';

/** Number of points used when resampling an intensity curve. */
const CURVE_POINTS = 128;

/** Look-ahead used by the loop scheduler, in seconds. */
const LOOP_LOOKAHEAD_S = 0.4;

/** How often the loop scheduler wakes up, in milliseconds. */
const LOOP_TICK_MS = 100;

/** Duration of a synthesised transient, in seconds. */
const TRANSIENT_S = 0.05;

/**
 * Clamp a number into the 0..1 range.
 * @param {number} value
 * @returns {number}
 */
function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * Map a sharpness value (0..1) onto a lowpass cutoff in Hz.
 *
 * 0 → 320 Hz (very dull, "thud"), 1 → 7.5 kHz (bright, "click").
 *
 * @param {number} sharpness
 * @returns {number} cutoff frequency in Hz
 */
export function sharpnessToCutoffHz(sharpness) {
  return 320 + clamp01(sharpness) * 7200;
}

/**
 * Average the value of a sharpness curve, used to pick one cutoff frequency
 * for the whole track.
 *
 * @param {number[][]|undefined} curve
 * @returns {number}
 */
export function averageCurveValue(curve) {
  if (!Array.isArray(curve) || curve.length === 0) return 0.5;
  let sum = 0;
  for (const point of curve) sum += Number(point?.[1] ?? 0);
  return clamp01(sum / curve.length);
}

/**
 * Resample a control-point curve into a flat array of `count` values.
 *
 * Contract §7: control points are `[normalizedTime, value]` pairs and renderers
 * MUST interpolate linearly between them.
 *
 * @param {number[][]|undefined} points
 * @param {number} [count]
 * @returns {Float32Array}
 */
export function interpolateCurve(points, count = CURVE_POINTS) {
  const out = new Float32Array(count);
  if (!Array.isArray(points) || points.length === 0) return out;

  const sorted = points
    .map((p) => [Number(p?.[0] ?? 0), clamp01(Number(p?.[1] ?? 0))])
    .sort((a, b) => a[0] - b[0]);

  if (sorted.length === 1) {
    out.fill(sorted[0][1]);
    return out;
  }

  let segment = 0;
  for (let i = 0; i < count; i += 1) {
    const t = count === 1 ? 0 : i / (count - 1);
    while (segment < sorted.length - 2 && t > sorted[segment + 1][0]) segment += 1;
    const [t0, v0] = sorted[segment];
    const [t1, v1] = sorted[segment + 1];
    const k = t1 === t0 ? 0 : clamp01((t - t0) / (t1 - t0));
    out[i] = v0 + (v1 - v0) * k;
  }
  return out;
}

/**
 * @typedef {object} HapticTrack
 * @property {'continuous'|'transient'} kind
 * @property {number} startMs
 * @property {number} [durationMs]
 * @property {number} carrierHz
 * @property {number[][]|number} [intensity]
 * @property {number[][]|number} [sharpness]
 */

/**
 * @typedef {object} HapticProgram
 * @property {string} [label]
 * @property {number} durationMs
 * @property {boolean} [loop]
 * @property {HapticTrack[]} tracks
 */

/**
 * A live WebAudio voice.
 * @typedef {object} Voice
 * @property {OscillatorNode} oscillator
 * @property {GainNode} gain
 * @property {number} stopAt
 */

/**
 * Renders haptic programs from `haptics.json` as WebAudio graphs.
 */
export class HapticSynthesizer {
  /**
   * @param {object} [options]
   * @param {Record<string, HapticProgram>} [options.programs] the `programs` map of haptics.json
   * @param {AudioContext} [options.context] an existing AudioContext (tests)
   * @param {number} [options.outputGain] master gain, keeps the audio gentle
   */
  constructor({ programs = {}, context = null, outputGain = 0.22 } = {}) {
    /** @type {Record<string, HapticProgram>} */
    this.programs = programs;
    /** @type {AudioContext|null} */
    this._context = context;
    this._outputGain = outputGain;
    /** @type {GainNode|null} */
    this._master = null;
    /** @type {Map<string, {timer: any, nextAt: number, period: number, voices: Voice[]}>} */
    this._loops = new Map();
    /** @type {Map<string, Voice[]>} every voice still scheduled, per program */
    this._voices = new Map();
  }

  /** @returns {boolean} true when this environment can synthesise audio */
  get supported() {
    const g = /** @type {any} */ (globalThis);
    return Boolean(this._context || g.AudioContext || g.webkitAudioContext);
  }

  /** @returns {AudioContext|null} the lazily created AudioContext */
  get context() {
    if (this._context) return this._context;
    const g = /** @type {any} */ (globalThis);
    const Ctor = g.AudioContext || g.webkitAudioContext;
    if (!Ctor) return null;
    this._context = new Ctor();
    this._master = this._context.createGain();
    this._master.gain.value = this._outputGain;
    this._master.connect(this._context.destination);
    return this._context;
  }

  /**
   * Resume a suspended context. Browsers only allow this from a user gesture,
   * so the app calls this on the first pointer/key event.
   *
   * @returns {Promise<boolean>} true when the context is running
   */
  async unlock() {
    const ctx = this.context;
    if (!ctx) return false;
    if (ctx.state === 'suspended') {
      try {
        await ctx.resume();
      } catch {
        return false;
      }
    }
    return ctx.state === 'running';
  }

  /**
   * Play a named program.
   *
   * @param {string} programName key of `haptics.json` → `programs`
   * @param {{loop?: boolean}} [options]
   * @returns {Promise<void>} resolves once the program has been scheduled
   */
  async play(programName, { loop = false } = {}) {
    const program = this.programs[programName];
    if (!program) {
      throw new BridgeError('invalid', `Unknown haptic program "${programName}"`);
    }
    await this.unlock();
    const ctx = this.context;
    // Graceful degradation: no WebAudio (headless test, locked-down webview)
    // means no sound, but never an exception.
    if (!ctx) return;

    this.stop(programName);
    const shouldLoop = loop || program.loop === true;
    if (shouldLoop) this._startLoop(programName, program);
    else this._renderProgram(programName, program, ctx.currentTime + 0.02);
  }

  /**
   * Stop a program (loops in particular).
   *
   * @param {string} programName
   * @returns {void}
   */
  stop(programName) {
    const loop = this._loops.get(programName);
    if (loop) {
      if (loop.timer !== null && typeof clearInterval === 'function') clearInterval(loop.timer);
      this._loops.delete(programName);
    }
    const ctx = this._context;
    const voices = this._voices.get(programName) ?? [];
    this._voices.delete(programName);
    if (!ctx) return;
    const now = ctx.currentTime;
    for (const voice of voices) {
      try {
        voice.gain.gain.cancelScheduledValues(now);
        voice.gain.gain.setTargetAtTime(0.0001, now, 0.012);
        voice.oscillator.stop(now + 0.08);
      } catch {
        /* the node was already stopped — nothing to do */
      }
    }
  }

  /**
   * Stop every running program.
   * @returns {void}
   */
  stopAll() {
    for (const name of [...this._loops.keys()]) this.stop(name);
    for (const name of [...this._voices.keys()]) this.stop(name);
  }

  /**
   * Render one pass of the program at `startTime`.
   *
   * @param {string} name
   * @param {HapticProgram} program
   * @param {number} startTime context time in seconds
   * @returns {Voice[]}
   */
  _renderProgram(name, program, startTime) {
    const ctx = this.context;
    if (!ctx) return [];
    const master = this._master;
    if (!master) return [];

    const voices = [];
    for (const track of program.tracks ?? []) {
      const trackStart = startTime + (track.startMs ?? 0) / 1000;
      const oscillator = ctx.createOscillator();
      oscillator.type = 'sine';
      oscillator.frequency.value = track.carrierHz ?? 120;

      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      const sharpness =
        typeof track.sharpness === 'number' ? track.sharpness : averageCurveValue(track.sharpness);
      filter.frequency.value = sharpnessToCutoffHz(sharpness);
      filter.Q.value = 0.7;

      const gain = ctx.createGain();
      // Set the resting value *before* scheduling automation — assigning to
      // `value` while automation is scheduled is ignored by the spec.
      gain.gain.value = 0;

      oscillator.connect(filter);
      filter.connect(gain);
      gain.connect(master);

      if (track.kind === 'transient') {
        const peak = Math.max(Number(track.intensity ?? 0.5), 0.0001);
        const duration = TRANSIENT_S;
        gain.gain.setValueAtTime(peak, trackStart);
        gain.gain.exponentialRampToValueAtTime(0.0001, trackStart + duration);
        oscillator.start(trackStart);
        oscillator.stop(trackStart + duration + 0.02);
        voices.push({ oscillator, gain, stopAt: trackStart + duration });
      } else {
        const duration = Math.max((track.durationMs ?? program.durationMs ?? 200) / 1000, 0.01);
        const curve = interpolateCurve(
          Array.isArray(track.intensity) ? track.intensity : [[0, Number(track.intensity ?? 0)]],
        );
        gain.gain.setValueCurveAtTime(curve, trackStart, duration);
        oscillator.start(trackStart);
        oscillator.stop(trackStart + duration + 0.01);
        voices.push({ oscillator, gain, stopAt: trackStart + duration });
      }
    }
    const bucket = this._voices.get(name) ?? [];
    bucket.push(...voices);
    this._voices.set(name, bucket);
    return voices;
  }

  /**
   * Start a seamlessly looping program.
   *
   * Each iteration is scheduled ahead of the play head, so the loop point never
   * produces a gap or a click.
   *
   * @param {string} name
   * @param {HapticProgram} program
   * @returns {void}
   */
  _startLoop(name, program) {
    const ctx = this.context;
    if (!ctx) return;
    const period = Math.max((program.durationMs ?? 1000) / 1000, 0.05);
    const state = { timer: null, nextAt: ctx.currentTime + 0.05, period, voices: /** @type {Voice[]} */ ([]) };
    this._loops.set(name, state);

    const tick = () => {
      const current = this._loops.get(name);
      if (!current) return;
      while (current.nextAt < ctx.currentTime + LOOP_LOOKAHEAD_S) {
        const voices = this._renderProgram(name, program, current.nextAt);
        current.voices.push(...voices);
        current.nextAt += current.period;
      }
      // Drop voices that already finished so the list cannot grow forever.
      current.voices = current.voices.filter((voice) => voice.stopAt > ctx.currentTime);
    };

    state.timer = setInterval(tick, LOOP_TICK_MS);
    tick();
  }
}

/**
 * Load the haptic programs from `haptics.json`.
 *
 * The JSON is shipped as a verbatim copy in `assets/haptics.json` so the app
 * stays self-contained when a native shell bundles this folder verbatim
 * (contract §1.3 — the app is served from a custom scheme, never `file://`).
 *
 * @param {string|URL} [url]
 * @returns {Promise<Record<string, HapticProgram>>}
 */
export async function loadHapticsPrograms(url = '/assets/haptics.json') {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not load haptic programs from ${String(url)} (${response.status})`);
  }
  const data = await response.json();
  const programs = data?.programs;
  if (!programs || typeof programs !== 'object') {
    throw new Error('haptics.json does not contain a "programs" object');
  }
  return programs;
}
