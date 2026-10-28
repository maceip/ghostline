import Foundation

// =============================================================================
// MARK: - Haptic facade (contract §7)
// =============================================================================
//
// The shell renders the programs of `packages/shared/haptics.json` with the
// best engine available:
//
//   * CoreHaptics — only when the machine really has a haptic engine.
//   * The CoreAudio sine synthesiser — the fallback for every Mac, which
//     reproduces the same envelope, timing and relative amplitude.
//
// `capabilities.haptics` is `true` only for a real haptic engine, never for
// the audio fallback (contract §2).

final class HapticService {

    /// The engine that actually rendered a program.
    enum Engine: String {
        case coreHaptics = "core-haptics"
        case audio = "audio"
        case none = "none"
    }

    /// The outcome of `haptic.play`.
    struct PlayResult {
        let program: String
        let loop: Bool
        let engine: Engine
    }

    private let library: HapticLibrary?
    private let audio = AudioHapticSynth()

    #if canImport(CoreHaptics)
    private var coreHaptics: CHapticEngine?
    #endif

    init() {
        library = try? HapticLibrary.load()
        #if canImport(CoreHaptics)
        // Contract §7 — only use CoreHaptics when the hardware is really
        // there. A Mac has no Taptic Engine, so this is `false` in practice.
        if CHapticEngine.hardwareSupportsHaptics {
            coreHaptics = CHapticEngine()
        }
        #endif
    }

    /// `true` only when a real haptic engine exists (contract §2).
    static var hardwareSupportsHaptics: Bool {
        HapticHardwareSupport.supportsHaptics
    }

    /// The names of the available programs.
    var availablePrograms: [String] {
        guard let library else { return [] }
        return library.programs.keys.sorted()
    }

    /// Plays a named program. Resolves as soon as playback is scheduled.
    @discardableResult
    func play(program name: String, loop: Bool) throws -> PlayResult {
        guard let library, let program = library.programs[name] else {
            throw ZodeBridgeError.notFound("There is no haptic program named '\(name)'.")
        }

        // The mapping itself is pure — see `HapticProgram.buildPattern(from:)`.
        let plan = HapticProgram.buildPattern(from: program)
        // Contract §7.1 — the `working` program loops until it is stopped.
        let effectiveLoop = loop || program.loop

        #if canImport(CoreHaptics)
        if let coreHaptics {
            do {
                try coreHaptics.play(program: program, plan: plan, loop: effectiveLoop)
                return PlayResult(program: name, loop: effectiveLoop, engine: .coreHaptics)
            } catch {
                // The haptic engine refused to start (no hardware, engine
                // error, …) — fall through to the audio renderer, which is
                // the documented macOS behaviour.
                NSLog("[Zode] CoreHaptics unavailable, falling back to the audio renderer: \(error.localizedDescription)")
            }
        }
        #endif

        do {
            try audio.play(program: program, plan: plan, loop: effectiveLoop)
        } catch {
            throw ZodeBridgeError.internalError("The haptic program '\(name)' could not be played: \(error.localizedDescription)")
        }
        return PlayResult(program: name, loop: effectiveLoop, engine: .audio)
    }

    /// Stops a looping program.
    func stop(program name: String) {
        audio.stop(program: name)
        #if canImport(CoreHaptics)
        coreHaptics?.stop(program: name)
        #endif
    }

    /// A human readable summary of the computed pattern. Used by the
    /// "Verify Haptic Programs" developer command, which proves that the
    /// JSON is mapped onto CoreHaptics parameters correctly without needing
    /// a device.
    func describe(program name: String) -> String? {
        guard let library, let program = library.programs[name] else { return nil }
        let plan = HapticProgram.buildPattern(from: program)
        var lines: [String] = []
        lines.append("\(program.label) — \(plan.events.count) event(s), \(String(format: "%.3f", plan.duration))s, loop: \(plan.loop)")
        for event in plan.events {
            switch event.kind {
            case .continuous:
                lines.append(String(
                    format: "  continuous @%.3fs dur %.3fs carrier %.0fHz intensity %d point(s) sharpness %d point(s)",
                    event.relativeTime, event.duration, event.carrierHz,
                    event.intensityCurve.count, event.sharpnessCurve.count
                ))
            case .transient:
                lines.append(String(
                    format: "  transient  @%.3fs intensity %.2f sharpness %.2f carrier %.0fHz",
                    event.relativeTime,
                    Double(event.constantIntensity ?? 0),
                    Double(event.constantSharpness ?? 0),
                    event.carrierHz
                ))
            }
        }
        return lines.joined(separator: "\n")
    }

    /// Stops every running program.
    func stopAll() {
        audio.stopAll()
        #if canImport(CoreHaptics)
        for name in ["working"] {
            coreHaptics?.stop(program: name)
        }
        #endif
    }
}
