//
//  HapticEngine.swift
//  ZodeMobile
//
//  Renders the programs from `packages/shared/haptics.json` with CoreHaptics.
//
//  Contract §7: iOS has a real Taptic Engine, so `capabilities.haptics` is
//  `true`. Each JSON track becomes a `CHHapticEvent`:
//
//    * `continuous` -> `.hapticContinuous` with a `CHHapticParameterCurve` for
//      intensity and sharpness (the JSON control points are already
//      normalised 0...1, which is exactly what CoreHaptics wants).
//    * `transient`  -> `.hapticTransient` with fixed intensity/sharpness.
//
//  The `working` program loops through `CHHapticAdvancedPatternPlayer` with
//  `loopEnabled = true` and is stopped with `stop(atTime:)`.
//
//  The JSON is read from the app bundle at launch so the shared file stays the
//  single source of truth; the compiled copy in `HapticPrograms.swift` is the
//  fallback if the resource is missing.
//

import Combine
import CoreHaptics
import Foundation
import UIKit

@MainActor
public final class HapticEngine: ObservableObject {
    /// The programs, keyed by name.
    public private(set) var programs: [String: HapticProgram] = [:]

    /// True when the device can play rich haptics.
    public private(set) var supportsHaptics: Bool = false

    /// True when the app can play *some* haptic (it always can on iOS).
    public var capabilitiesHaptics: Bool { true }

    private var engine: CHHapticEngine?
    private var players: [String: CHHapticAdvancedPatternPlayer] = [:]
    private var fallbackGenerators: [String: UIImpactFeedbackGenerator] = [:]

    public init() {
        programs = Self.loadPrograms()
        prepareEngine()
    }

    // MARK: - Loading

    /// Reads `haptics.json` from the app bundle, falling back to the compiled
    /// copy generated from the same file.
    public static func loadPrograms() -> [String: HapticProgram] {
        if let url = Bundle.main.url(forResource: "haptics", withExtension: "json"),
           let data = try? Data(contentsOf: url),
           let decoded = try? HapticProgramLibrary.decode(data),
           !decoded.isEmpty {
            // Keep the file order stable.
            var ordered: [String: HapticProgram] = [:]
            for name in HapticProgramLibrary.names {
                if let program = decoded[name] { ordered[name] = program }
            }
            for (name, program) in decoded where ordered[name] == nil {
                ordered[name] = program
            }
            return ordered
        }
        return HapticProgramLibrary.compiled
    }

    // MARK: - Engine

    private func prepareEngine() {
        guard CHHapticEngine.capabilitiesForHardware().supportsHaptics else {
            supportsHaptics = false
            return
        }
        do {
            let engine = try CHHapticEngine()
            engine.isAutoShutdownEnabled = true
            engine.resetHandler = { [weak self] in
                Task { @MainActor in
                    self?.players.removeAll()
                }
            }
            engine.stoppedHandler = { _ in }
            try engine.start()
            self.engine = engine
            supportsHaptics = true
        } catch {
            supportsHaptics = false
        }
    }

    // MARK: - Playback

    /// Plays a named program. `loop` is honoured for programs that declare
    /// `loop: true` (the `working` program).
    public func play(_ name: String, loop: Bool = false) {
        guard let program = programs[name] else { return }

        if supportsHaptics, let engine {
            play(program, loop: loop, on: engine)
            return
        }

        // Fallback: the coarse system feedback generator. Still a real haptic.
        let generator = fallbackGenerators[name] ?? UIImpactFeedbackGenerator(style: .light)
        fallbackGenerators[name] = generator
        generator.prepare()
        generator.impactOccurred(intensity: CGFloat(program.tracks.first?.intensityValue ?? 0.5))
    }

    private func play(_ program: HapticProgram, loop: Bool, on engine: CHHapticEngine) {
        do {
            let pattern = try makePattern(program)
            // The engine is started first, and then the player — there is no
            // overload of `start` that takes the player.
            try engine.start()
            let player = try engine.makeAdvancedPlayer(with: pattern)
            player.loopEnabled = loop && program.loops
            try player.start(atTime: CHHapticTimeImmediate)
            players[program.name] = player
        } catch {
            // A failed pattern must never crash the app; fall back to the
            // coarse generator so the interaction still feels alive.
            let generator = UIImpactFeedbackGenerator(style: .light)
            generator.prepare()
            generator.impactOccurred()
        }
    }

    /// Stops a looping program (contract §2 — `hapticStop`).
    public func stop(_ name: String) {
        if let player = players.removeValue(forKey: name) {
            try? player.stop(atTime: CHHapticTimeImmediate)
        }
        fallbackGenerators.removeValue(forKey: name)
    }

    /// Stops everything that is currently playing.
    public func stopAll() {
        for player in players.values {
            try? player.stop(atTime: CHHapticTimeImmediate)
        }
        players.removeAll()
        fallbackGenerators.removeAll()
    }

    // MARK: - Pattern building

    /// Converts a JSON program into a `CHHapticPattern`.
    public func makePattern(_ program: HapticProgram) throws -> CHHapticPattern {
        var events: [CHHapticEvent] = []
        var curves: [CHHapticParameterCurve] = []

        for track in program.tracks {
            let relativeTime = TimeInterval(track.startMs / 1000)

            switch track.kind {
            case .continuous:
                var parameters: [CHHapticEventParameter] = [
                    CHHapticEventParameter(parameterID: .hapticIntensity, value: 0),
                    CHHapticEventParameter(parameterID: .hapticSharpness, value: 0),
                ]
                if let first = track.intensity.first {
                    parameters[0] = CHHapticEventParameter(
                        parameterID: .hapticIntensity,
                        value: Float(first.value)
                    )
                }
                if let first = track.sharpness.first {
                    parameters[1] = CHHapticEventParameter(
                        parameterID: .hapticSharpness,
                        value: Float(first.value)
                    )
                }

                let event = CHHapticEvent(
                    eventType: .hapticContinuous,
                    parameters: parameters,
                    relativeTime: relativeTime,
                    duration: TimeInterval(track.durationMs / 1000)
                )
                events.append(event)

                if !track.intensity.isEmpty {
                    curves.append(
                        CHHapticParameterCurve(
                            parameterID: .hapticIntensityControl,
                            controlPoints: track.intensity.map {
                                CHHapticParameterCurve.ControlPoint(
                                    relativeTime: TimeInterval($0.time),
                                    value: Float($0.value)
                                )
                            },
                            relativeTime: relativeTime
                        )
                    )
                }
                if !track.sharpness.isEmpty {
                    curves.append(
                        CHHapticParameterCurve(
                            parameterID: .hapticSharpnessControl,
                            controlPoints: track.sharpness.map {
                                CHHapticParameterCurve.ControlPoint(
                                    relativeTime: TimeInterval($0.time),
                                    value: Float($0.value)
                                )
                            },
                            relativeTime: relativeTime
                        )
                    )
                }

            case .transient:
                let event = CHHapticEvent(
                    eventType: .hapticTransient,
                    parameters: [
                        CHHapticEventParameter(
                            parameterID: .hapticIntensity,
                            value: Float(track.intensityValue)
                        ),
                        CHHapticEventParameter(
                            parameterID: .hapticSharpness,
                            value: Float(track.sharpnessValue)
                        ),
                    ],
                    relativeTime: relativeTime
                )
                events.append(event)
            }
        }

        return try CHHapticPattern(events: events, parameterCurves: curves)
    }

    // MARK: - Intents (contract §2 — `haptic` / `hapticStop`)

    /// `zode.haptic(program, { loop })`
    public func performHaptic(program: String, loop: Bool = false) {
        play(program, loop: loop)
    }

    /// `zode.hapticStop(program)`
    public func performHapticStop(program: String) {
        stop(program)
    }
}
