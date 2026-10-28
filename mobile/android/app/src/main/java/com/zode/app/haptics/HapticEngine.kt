//
//  HapticEngine.kt
//  ZodeMobile (Android)
//
//  Renders the programs from `packages/shared/haptics.json` with the
//  platform vibrator.
//
//  Contract §7: Android maps the waveform onto
//  `VibrationEffect.createWaveform(timings, amplitudes, repeat)`:
//
//    * every 25 ms the intensity curve is sampled and turned into an
//      (timing, amplitude) pair -- `intensity x 255`;
//    * a `transient` track becomes a short high amplitude pulse;
//    * a `continuous` track becomes a run of stepped segments;
//    * `working` loops forever (`repeat = 0`), every other program is a
//      one-shot (`repeat = -1`).
//
//  Every track of a program is merged onto ONE timeline and emitted as a
//  single waveform. Android cannot do better: `VibrationEffect.Composition`
//  only composes the built-in primitives (CLICK, TICK, ...) and `Vibrator` has
//  no `compose` at all, so two arbitrary waveforms cannot be layered.
//  Overlapping tracks therefore sum (clamped) instead of replacing.
//
//  For the same reason a one-shot that arrives while the `working` loop is
//  running replaces the loop and the loop is resumed once the one-shot ends.
//
//  `capabilities.haptics` is reported honestly: it is only true when the
//  device actually has a vibrator.
//

package com.zode.app.haptics

import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import com.zode.app.R

class HapticEngine(context: Context) {

    /** The programs, keyed by name. */
    val programs: Map<String, HapticProgram> by lazy { loadPrograms(context) }

    private val vibrator: Vibrator? = resolveVibrator(context)
    private val handler = Handler(Looper.getMainLooper())

    /** True when the device has a vibrator. */
    val supportsHaptics: Boolean
        get() = vibrator?.hasVibrator() == true

    /** The program that is currently looping, if any. */
    private var loopingName: String? = null
    private var loopingEffect: VibrationEffect? = null

    private fun resolveVibrator(context: Context): Vibrator? = try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val manager = context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager
            manager?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        }
    } catch (error: Exception) {
        null
    }

    /**
     * Reads `haptics.json` from `res/raw`, falling back to the compiled copy
     * generated from the same file.
     */
    fun loadPrograms(context: Context): Map<String, HapticProgram> {
        val decoded = try {
            context.resources.openRawResource(R.raw.haptics).bufferedReader().use {
                HapticProgramLibrary.decode(it.readText())
            }
        } catch (error: Exception) {
            emptyMap()
        }
        if (decoded.isEmpty()) return HapticProgramLibrary.compiled

        // Keep the file order stable.
        val ordered = LinkedHashMap<String, HapticProgram>()
        HapticProgramLibrary.names.forEach { name ->
            decoded[name]?.let { ordered[name] = it }
        }
        decoded.forEach { (name, program) ->
            if (!ordered.containsKey(name)) ordered[name] = program
        }
        return ordered
    }

    /** Plays a named program. */
    fun play(name: String, loop: Boolean = false) {
        val program = programs[name] ?: return
        val vibrator = vibrator ?: return
        if (!vibrator.hasVibrator()) return

        val isLoop = loop && program.loops
        val effect = buildEffect(program, isLoop) ?: return

        if (isLoop) {
            loopingName = name
            loopingEffect = effect
            vibrate(vibrator, effect)
            return
        }

        val loop = loopingEffect
        val loopName = loopingName

        // Android has a single vibration channel, and `VibrationEffect.Composition`
        // can only layer the built-in *primitives* -- there is no way to play two
        // arbitrary waveforms at once. So a one-shot that arrives while the
        // "working" loop is running replaces the loop, and the loop is resumed
        // once the one-shot has finished.
        if (loop != null && loopName != name) {
            vibrate(vibrator, effect)
            handler.postDelayed({
                val restore = loopingEffect
                if (restore != null && loopingName == loopName) {
                    vibrate(vibrator, restore)
                }
            }, oneShotDuration(program))
            return
        }

        vibrate(vibrator, effect)
    }

    /** Stops a looping program (contract §2 -- `hapticStop`). */
    fun stop(name: String) {
        if (loopingName == name) {
            loopingName = null
            loopingEffect = null
        }
        try {
            vibrator?.cancel()
        } catch (error: Exception) {
            // ignore
        }
    }

    /** Stops everything that is currently playing. */
    fun stopAll() {
        loopingName = null
        loopingEffect = null
        try {
            vibrator?.cancel()
        } catch (error: Exception) {
            // ignore
        }
    }

    private fun vibrate(vibrator: Vibrator, effect: VibrationEffect) {
        try {
            vibrator.vibrate(effect)
        } catch (error: Exception) {
            // A device that refuses the effect must never crash the app.
        }
    }

    /** How long a one-shot program lasts, in milliseconds. */
    private fun oneShotDuration(program: HapticProgram): Long {
        var end = 0L
        for (track in program.tracks) {
            end = maxOf(end, (track.startMs + track.durationMs).toLong())
        }
        return end.coerceAtLeast(1L)
    }

    // ------------------------------------------------------------------
    // Waveform construction

    /**
     * Builds the `VibrationEffect` for a program.
     *
     * @param program the shared program
     * @param loop true for programs that declare `loop: true`
     */
    fun buildEffect(program: HapticProgram, loop: Boolean): VibrationEffect? {
        if (program.tracks.isEmpty()) return null
        val repeat = if (loop && program.loops) 0 else -1

        // Every track of a program is merged onto ONE timeline and emitted as a
        // single waveform. That is the only way to play an arbitrary envelope
        // on Android: `VibrationEffect.Composition` can only combine the
        // built-in primitives (CLICK, TICK, ...), and `Vibrator` has no
        // `compose` at all, so there is no way to layer two full waveforms.
        //
        // Merging also preserves the contract's semantics: a program is one
        // gesture, and overlapping tracks sum (clamped) rather than replace.
        val segments = program.tracks.map { track ->
            val duration = if (track.kind == HapticTrackKind.TRANSIENT) {
                maxOf(TRANSIENT_DURATION_MS, track.durationMs.toLong())
            } else {
                track.durationMs.toLong().coerceAtLeast(1L)
            }
            track to duration
        }

        val totalMs = segments.maxOf { (track, duration) ->
            track.startMs.toLong() + duration
        }.coerceAtLeast(1L)

        val stepCount = ((totalMs + STEP_MS - 1) / STEP_MS).toInt().coerceAtLeast(1)
        val amplitudes = IntArray(stepCount)

        for ((track, duration) in segments) {
            val start = track.startMs.toLong()
            for (index in 0 until stepCount) {
                val elapsed = index.toLong() * STEP_MS
                if (elapsed < start) continue
                if (elapsed >= duration) continue
                val normalised = elapsed.toDouble() / duration.toDouble()
                val value = track.intensityAt(normalised.coerceIn(0.0, 1.0))
                amplitudes[index] = minOf(255, amplitudes[index] + amplitude(value))
            }
        }

        if (amplitudes.all { it == 0 }) return null

        // `timings` must be the same length as `amplitudes`; every step is
        // STEP_MS except the last, which absorbs the remainder.
        val timings = LongArray(stepCount)
        var elapsed = 0L
        for (index in 0 until stepCount) {
            val remaining = totalMs - elapsed
            val slice = if (index == stepCount - 1) remaining.coerceAtLeast(1L)
            else minOf(STEP_MS, remaining)
            timings[index] = slice
            elapsed += slice
        }

        return VibrationEffect.createWaveform(timings, amplitudes, repeat)
    }


    /** `intensity x 255`, clamped to the 0..255 range. */
    private fun amplitude(value: Double): Int =
        (value * 255.0).toInt().coerceIn(0, 255)

    companion object {
        /** The curve is sampled every 25 ms. */
        const val STEP_MS = 25L

        /** A transient track is a 30 ms pulse. */
        const val TRANSIENT_DURATION_MS = 30L
    }
}
