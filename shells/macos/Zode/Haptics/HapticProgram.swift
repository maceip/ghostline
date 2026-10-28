import Foundation

// =============================================================================
// MARK: - Contract §7 — the canonical haptic programs
// =============================================================================
//
// `packages/shared/haptics.json` is the single source of truth. This file
// parses it at runtime with `JSONSerialization` and maps it onto a
// **device independent** description of a CoreHaptics pattern.
//
// The mapping is a pure function: no engine, no device, no I/O. That makes
// it testable on any machine — `HapticProgram.buildPattern(from:)` is the
// function the unit tests would exercise.
//
// Two renderers consume the result:
//   * `CHapticEngine`  — CoreHaptics (only on platforms that have it).
//   * `AudioHapticSynth` — a CoreAudio sine synthesiser used on the Mac,
//     which has no Taptic Engine (contract §7).

// MARK: - JSON model

/// One control point of an intensity / sharpness curve.
struct HapticCurvePoint: Equatable {
    /// Normalised time inside the event (0…1).
    let time: Double
    /// Value (0…1).
    let value: Double
}

/// An intensity or sharpness envelope: either a constant or a curve.
enum HapticCurve: Equatable {
    case constant(Double)
    case points([HapticCurvePoint])

    /// The constant value, when the envelope is flat.
    var constantValue: Double? {
        if case .constant(let value) = self { return value }
        return nil
    }

    /// The control points, when the envelope is a curve.
    var controlPoints: [HapticCurvePoint] {
        if case .points(let points) = self { return points }
        return []
    }
}

/// One track of a haptic program.
struct HapticTrack: Equatable {
    enum Kind: String {
        case continuous
        case transient
    }

    let kind: Kind
    let startMs: Double
    let durationMs: Double
    let carrierHz: Double
    let intensity: HapticCurve
    let sharpness: HapticCurve
}

/// A named program, e.g. `done` or `working`.
struct HapticProgram: Equatable {
    let name: String
    let label: String
    let description: String
    let durationMs: Double
    let loop: Bool
    let tracks: [HapticTrack]

    /// Parses one program out of the `programs` dictionary of `haptics.json`.
    init?(name: String, json: [String: Any]) {
        guard let label = json["label"] as? String else { return nil }
        let description = json["description"] as? String ?? label
        let durationMs = (json["durationMs"] as? NSNumber)?.doubleValue ?? 0
        let loop = (json["loop"] as? Bool) ?? false
        let rawTracks = json["tracks"] as? [[String: Any]] ?? []

        var tracks: [HapticTrack] = []
        for raw in rawTracks {
            guard let kindRaw = raw["kind"] as? String, let kind = HapticTrack.Kind(rawValue: kindRaw) else {
                continue
            }
            let startMs = (raw["startMs"] as? NSNumber)?.doubleValue ?? 0
            let durationMs = (raw["durationMs"] as? NSNumber)?.doubleValue ?? 0
            let carrierHz = (raw["carrierHz"] as? NSNumber)?.doubleValue ?? 120
            let intensity = HapticCurve(json: raw["intensity"]) ?? .constant(1)
            let sharpness = HapticCurve(json: raw["sharpness"]) ?? .constant(0.5)
            tracks.append(HapticTrack(
                kind: kind,
                startMs: startMs,
                durationMs: durationMs,
                carrierHz: carrierHz,
                intensity: intensity,
                sharpness: sharpness
            ))
        }
        guard !tracks.isEmpty else { return nil }

        self.name = name
        self.label = label
        self.description = description
        self.durationMs = durationMs
        self.loop = loop
        self.tracks = tracks
    }

    /// The duration of the program in seconds.
    var duration: TimeInterval { durationMs / 1000.0 }
}

// MARK: - The device independent pattern plan

/// A CoreHaptics pattern described without CoreHaptics.
///
/// The plan is what `HapticProgram.buildPattern(from:)` produces; the
/// CoreHaptics renderer converts it into a `CHHapticPattern` and the audio
/// renderer turns it into a PCM buffer.
struct HapticPatternPlan: Equatable {

    /// The CoreHaptics dynamic parameter a curve drives.
    enum CurveParameter: String, Equatable {
        case hapticIntensityControl
        case hapticSharpnessControl
    }

    /// A single control point of a parameter curve.
    struct ControlPoint: Equatable {
        /// Time relative to the start of the event the curve belongs to.
        let relativeTime: TimeInterval
        let value: Float
    }

    /// A parameter curve attached to an event.
    struct ParameterCurve: Equatable {
        let parameter: CurveParameter
        let controlPoints: [ControlPoint]
        /// Time relative to the start of the pattern.
        let relativeTime: TimeInterval
    }

    /// One haptic event.
    struct Event: Equatable {
        enum Kind: String, Equatable {
            case continuous
            case transient
        }

        let kind: Kind
        /// Time relative to the start of the pattern.
        let relativeTime: TimeInterval
        /// Duration of the event (0 for transients).
        let duration: TimeInterval
        /// Constant intensity (transients only).
        let constantIntensity: Float?
        /// Constant sharpness (transients only).
        let constantSharpness: Float?
        /// Intensity envelope (continuous events only).
        let intensityCurve: [ControlPoint]
        /// Sharpness envelope (continuous events only).
        let sharpnessCurve: [ControlPoint]
        /// Sine carrier for audio renderers (contract §7 — CoreHaptics has no
        /// carrier, the audio renderers do).
        let carrierHz: Double
    }

    let events: [Event]
    /// Total length of the pattern in seconds.
    let duration: TimeInterval
    /// Whether the pattern repeats until it is stopped.
    let loop: Bool
}

// MARK: - The pure mapping

extension HapticProgram {

    /// Maps a program onto a CoreHaptics parameter plan.
    ///
    /// **Pure**: no engine, no device, no I/O — the result only depends on
    /// the program, so it can be unit tested on any machine.
    ///
    /// Times are normalised the way CoreHaptics expects them:
    ///   * an event's `relativeTime` is relative to the start of the pattern,
    ///   * the control points of a parameter curve are relative to the start
    ///     of the event the curve belongs to.
    func buildPattern(from program: HapticProgram) -> HapticPatternPlan {
        HapticProgram.buildPattern(from: program)
    }

    /// Maps a program onto a CoreHaptics parameter plan.
    static func buildPattern(from program: HapticProgram) -> HapticPatternPlan {
        var events: [HapticPatternPlan.Event] = []
        events.reserveCapacity(program.tracks.count)

        for track in program.tracks {
            let start = track.startMs / 1000.0
            let duration = track.durationMs / 1000.0
            switch track.kind {
            case .continuous:
                events.append(HapticPatternPlan.Event(
                    kind: .continuous,
                    relativeTime: start,
                    duration: duration,
                    constantIntensity: nil,
                    constantSharpness: nil,
                    intensityCurve: controlPoints(from: track.intensity),
                    sharpnessCurve: controlPoints(from: track.sharpness),
                    carrierHz: track.carrierHz
                ))
            case .transient:
                events.append(HapticPatternPlan.Event(
                    kind: .transient,
                    relativeTime: start,
                    duration: duration,
                    constantIntensity: track.intensity.constantValue.map { Float($0) } ?? 1.0,
                    constantSharpness: track.sharpness.constantValue.map { Float($0) } ?? 0.5,
                    intensityCurve: [],
                    sharpnessCurve: [],
                    carrierHz: track.carrierHz
                ))
            }
        }

        return HapticPatternPlan(
            events: events,
            duration: program.duration,
            loop: program.loop
        )
    }

    /// Converts a curve into control points.
    ///
    /// A flat envelope becomes a two point curve (0 → value → value) so that
    /// CoreHaptics gets the same shape as the audio renderer.
    private static func controlPoints(from curve: HapticCurve) -> [HapticPatternPlan.ControlPoint] {
        switch curve {
        case .constant(let value):
            return [
                HapticPatternPlan.ControlPoint(relativeTime: 0, value: Float(value)),
                HapticPatternPlan.ControlPoint(relativeTime: 1, value: Float(value))
            ]
        case .points(let points):
            return points.map {
                HapticPatternPlan.ControlPoint(relativeTime: $0.time, value: Float($0.value))
            }
        }
    }
}

// MARK: - The library

/// All programs of `haptics.json`.
struct HapticLibrary {
    let version: Int
    let programs: [String: HapticProgram]

    /// Loads the bundled `haptics.json`.
    static func load(bundle: Bundle = .main) throws -> HapticLibrary {
        guard let url = bundle.url(forResource: "haptics", withExtension: "json") else {
            throw ZodeBridgeError.notFound("haptics.json is missing from the app bundle.")
        }
        return try load(url: url)
    }

    /// Loads `haptics.json` from disk.
    static func load(url: URL) throws -> HapticLibrary {
        let data = try Data(contentsOf: url)
        guard
            let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
            let version = root["version"] as? Int,
            let rawPrograms = root["programs"] as? [String: Any]
        else {
            throw ZodeBridgeError.invalid("haptics.json has an unexpected shape.")
        }
        var programs: [String: HapticProgram] = [:]
        for (name, raw) in rawPrograms {
            guard let dictionary = raw as? [String: Any] else { continue }
            if let program = HapticProgram(name: name, json: dictionary) {
                programs[name] = program
            }
        }
        guard !programs.isEmpty else {
            throw ZodeBridgeError.invalid("haptics.json does not contain any usable program.")
        }
        return HapticLibrary(version: version, programs: programs)
    }
}

// MARK: - JSON helpers

extension HapticCurve {
    /// Reads a curve out of the raw JSON: a number or a `[[time, value]]` array.
    init?(json: Any?) {
        guard let json else { return nil }
        if let number = json as? NSNumber {
            self = .constant(number.doubleValue)
            return
        }
        if let number = json as? Double {
            self = .constant(number)
            return
        }
        if let pairs = json as? [[Double]] {
            let points = pairs.compactMap { pair -> HapticCurvePoint? in
                guard pair.count >= 2 else { return nil }
                return HapticCurvePoint(time: pair[0], value: pair[1])
            }
            guard !points.isEmpty else { return nil }
            self = .points(points)
            return
        }
        return nil
    }
}
