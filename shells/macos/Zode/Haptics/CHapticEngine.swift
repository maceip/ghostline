import Foundation

#if canImport(CoreHaptics)
import CoreHaptics
#endif

// =============================================================================
// MARK: - CoreHaptics renderer (contract §7)
// =============================================================================
//
// Contract §7 asks the macOS shell to render the canonical programs with
// CoreHaptics (`CHHapticPattern` + `CHHapticAdvancedPatternPlayer`) and to
// check `CHHapticEngine.capabilitiesForHardware().supportsHaptics` first —
// because a Mac generally has **no** Taptic Engine, in which case the shell
// falls back to the audio synthesiser and reports `capabilities.haptics =
// false`.
//
// `CoreHaptics` is not part of every macOS SDK (it is an iOS / Mac Catalyst
// framework), so the whole renderer is behind `canImport`. When the
// framework is missing the shell still builds the identical parameter plan
// and renders it with `AudioHapticSynth` — the envelope, the timing and the
// relative amplitude are preserved, which is exactly what contract §7
// demands.

/// The hardware capability check, available with or without the framework.
enum HapticHardwareSupport {

    /// `true` only when a real haptic engine exists.
    ///
    /// On the Mac this is practically always `false`: `supportsHaptics` is
    /// `false` for every Mac that has no Taptic Engine, and the framework
    /// itself is absent from the macOS SDK.
    static var supportsHaptics: Bool {
        #if canImport(CoreHaptics)
        return CHHapticEngine.capabilitiesForHardware().supportsHaptics
        #else
        return false
        #endif
    }
}

#if canImport(CoreHaptics)

/// Renders a haptic program with CoreHaptics.
final class CHapticEngine {

    private var engine: CHHapticEngine?
    private var players: [String: CHHapticAdvancedPatternPlayer] = [:]

    /// `true` when the machine actually has a haptic engine.
    static var hardwareSupportsHaptics: Bool {
        CHHapticEngine.capabilitiesForHardware().supportsHaptics
    }

    // MARK: - Pattern construction

    /// Turns the device independent plan into a CoreHaptics pattern.
    ///
    /// Building a pattern does not need a device — only *playing* it does —
    /// so this is still a pure function of the plan.
    static func makePattern(from plan: HapticPatternPlan) throws -> CHHapticPattern {
        var events: [CHHapticEvent] = []
        var curves: [CHHapticParameterCurve] = []

        for event in plan.events {
            var parameters: [CHHapticEventParameter] = []

            if event.kind == .continuous {
                // A continuous event starts at the first control point and is
                // then shaped by its parameter curve.
                let startIntensity = event.intensityCurve.first?.value ?? 0
                let startSharpness = event.sharpnessCurve.first?.value ?? 0
                parameters.append(CHHapticEventParameter(parameterID: .hapticIntensity, value: startIntensity))
                parameters.append(CHHapticEventParameter(parameterID: .hapticSharpness, value: startSharpness))
            } else {
                parameters.append(CHHapticEventParameter(parameterID: .hapticIntensity, value: event.constantIntensity ?? 1.0))
                parameters.append(CHHapticEventParameter(parameterID: .hapticSharpness, value: event.constantSharpness ?? 0.5))
            }

            let type: CHHapticEvent.EventType = event.kind == .continuous ? .hapticContinuous : .hapticTransient
            events.append(CHHapticEvent(
                eventType: type,
                parameters: parameters,
                relativeTime: event.relativeTime,
                duration: event.duration
            ))

            if event.kind == .continuous {
                curves.append(CHHapticParameterCurve(
                    parameterID: .hapticIntensityControl,
                    controlPoints: event.intensityCurve.map {
                        CHHapticParameterCurve.ControlPoint(relativeTime: $0.relativeTime, value: $0.value)
                    },
                    relativeTime: event.relativeTime
                ))
                curves.append(CHHapticParameterCurve(
                    parameterID: .hapticSharpnessControl,
                    controlPoints: event.sharpnessCurve.map {
                        CHHapticParameterCurve.ControlPoint(relativeTime: $0.relativeTime, value: $0.value)
                    },
                    relativeTime: event.relativeTime
                ))
            }
        }

        return try CHHapticPattern(events: events, parameterCurves: curves)
    }

    // MARK: - Playback

    /// Starts (or restarts) a program.
    func play(program: HapticProgram, plan: HapticPatternPlan, loop: Bool) throws {
        let engine = try startEngine()
        let pattern = try CHapticEngine.makePattern(from: plan)

        stop(program: program.name)

        let player = try engine.makeAdvancedPlayer(with: pattern)
        // Contract §7.1 — the `working` program repeats until it is stopped.
        player.loopEnabled = loop
        try player.start(atTime: CHHapticTimeImmediate)
        players[program.name] = player
    }

    /// Stops a looping program.
    func stop(program: String) {
        guard let player = players.removeValue(forKey: program) else { return }
        try? player.stop(atTime: CHHapticTimeImmediate)
    }

    private func startEngine() throws -> CHHapticEngine {
        if let engine { return engine }
        let created = try CHHapticEngine()
        try created.start()
        engine = created
        return created
    }
}

#endif
