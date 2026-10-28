import AVFoundation
import Foundation

// =============================================================================
// MARK: - CoreAudio fallback renderer (contract §7)
// =============================================================================
//
// A Mac has no Taptic Engine, so contract §7 requires the shell to fall
// back to a sine synthesiser that reproduces the *same* envelope:
//
//   * the carrier frequency comes from the track's `carrierHz`,
//   * the amplitude comes from the intensity curve (linearly interpolated
//     between the control points, exactly like the WebAudio renderer of the
//     web fallback shim),
//   * the sharpness curve shapes the timbre (a brighter waveform when the
//     sharpness is high).
//
// The waveform is rendered offline into an `AVAudioPCMBuffer` and played
// through an `AVAudioPlayerNode`; the looping `working` program uses the
// `.loops` buffer option so it repeats seamlessly until it is stopped.

final class AudioHapticSynth {

    private let engine = AVAudioEngine()
    private let sampleRate: Double = 44_100
    private var players: [String: AVAudioPlayerNode] = [:]
    private var engineStarted = false

    deinit {
        stopAll()
    }

    /// Renders and starts a program.
    func play(program: HapticProgram, plan: HapticPatternPlan, loop: Bool) throws {
        stop(program: program.name)

        let buffer = try render(plan: plan)
        let player = AVAudioPlayerNode()

        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: buffer.format)
        try startEngineIfNeeded()

        if loop {
            player.scheduleBuffer(buffer, at: nil, options: .loops)
        } else {
            player.scheduleBuffer(buffer, at: nil, options: [])
        }
        player.play()
        players[program.name] = player
    }

    /// Stops a (possibly looping) program.
    func stop(program: String) {
        guard let player = players.removeValue(forKey: program) else { return }
        player.stop()
        engine.detach(player)
    }

    /// Stops everything (called when the app terminates).
    func stopAll() {
        for (_, player) in players {
            player.stop()
            engine.detach(player)
        }
        players.removeAll()
        if engineStarted {
            engine.stop()
            engineStarted = false
        }
    }

    // MARK: - Rendering

    private func startEngineIfNeeded() throws {
        guard !engineStarted else { return }
        engine.prepare()
        try engine.start()
        engineStarted = true
    }

    /// Renders a plan into a mono PCM buffer.
    func render(plan: HapticPatternPlan) throws -> AVAudioPCMBuffer {
        guard let format = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 1) else {
            throw ZodeBridgeError.internalError("Could not create the audio format for the haptic synthesiser.")
        }
        let length = max(plan.duration, 0.05)
        let frameCount = AVAudioFrameCount(length * sampleRate)
        guard
            let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameCount),
            let channel = buffer.floatChannelData?[0]
        else {
            throw ZodeBridgeError.internalError("Could not allocate the haptic audio buffer.")
        }
        buffer.frameLength = frameCount
        let total = Int(frameCount)
        for index in 0..<total { channel[index] = 0 }

        for event in plan.events {
            render(event: event, into: channel, totalSamples: total)
        }
        return buffer
    }

    private func render(event: HapticPatternPlan.Event, into channel: UnsafeMutablePointer<Float>, totalSamples: Int) {
        let startSample = Int(event.relativeTime * sampleRate)

        switch event.kind {
        case .continuous:
            let eventSamples = Int(event.duration * sampleRate)
            guard eventSamples > 0 else { return }
            for index in 0..<eventSamples {
                let target = startSample + index
                guard target >= 0, target < totalSamples else { continue }
                let t = Double(index) / sampleRate
                let progress = event.duration > 0 ? Double(index) / Double(eventSamples) : 0
                let envelope = AudioHapticSynth.interpolate(event.intensityCurve, at: progress)
                let brightness = AudioHapticSynth.interpolate(event.sharpnessCurve, at: progress)
                let phase = 2.0 * Double.pi * event.carrierHz * t
                // A dull carrier at low sharpness, a bright one at high
                // sharpness: the fundamental plus a partial.
                let fundamental = sin(phase)
                let partial = sin(phase * 2.0)
                let sample = fundamental * (1.0 - 0.35 * brightness) + partial * 0.35 * brightness
                channel[target] += Float(sample * envelope)
            }

        case .transient:
            // A transient is an instantaneous hit: a short exponentially
            // decaying burst.
            let decay = 0.03
            let eventSamples = Int(max(decay * 4.0, 0.01) * sampleRate)
            let amplitude = Double(event.constantIntensity ?? 1.0)
            let brightness = Double(event.constantSharpness ?? 0.5)
            for index in 0..<eventSamples {
                let target = startSample + index
                guard target >= 0, target < totalSamples else { continue }
                let t = Double(index) / sampleRate
                let envelope = exp(-t / decay) * amplitude
                let phase = 2.0 * Double.pi * event.carrierHz * t
                let fundamental = sin(phase)
                let partial = sin(phase * 2.0)
                let sample = fundamental * (1.0 - 0.35 * brightness) + partial * 0.35 * brightness
                channel[target] += Float(sample * envelope)
            }
        }
    }

    /// Linear interpolation between the control points of a curve.
    static func interpolate(_ points: [HapticPatternPlan.ControlPoint], at progress: Double) -> Double {
        guard !points.isEmpty else { return 0 }
        if points.count == 1 { return Double(points[0].value) }
        if progress <= Double(points[0].relativeTime) { return Double(points[0].value) }
        if progress >= Double(points[points.count - 1].relativeTime) { return Double(points[points.count - 1].value) }
        for index in 0..<(points.count - 1) {
            let start = points[index]
            let end = points[index + 1]
            let startTime = Double(start.relativeTime)
            let endTime = Double(end.relativeTime)
            guard progress >= startTime, progress <= endTime else { continue }
            let span = endTime - startTime
            guard span > 0 else { return Double(end.value) }
            let ratio = (progress - startTime) / span
            return Double(start.value) + (Double(end.value) - Double(start.value)) * ratio
        }
        return Double(points[points.count - 1].value)
    }
}
