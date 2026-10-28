import Foundation

// =============================================================================
// MARK: - Contract §1.2 — the message envelope
// =============================================================================
//
// The bridge speaks plain JSON objects in both directions, so the envelope is
// modelled as `[String: Any]` + `JSONSerialization` rather than `Codable`
// (which cannot express "an object with arbitrary contents" without a bespoke
// `AnyCodable` type that would have to be re-implemented on the JS side).
//
//   request  (JS -> native) : { "id": "<uuid>", "type": "<request type>", "payload": { … } }
//   response (native -> JS) : { "id": "<uuid>", "ok": true,  "result": { … } }
//                             { "id": "<uuid>", "ok": false, "error": { "code": …, "message": … } }
//   event    (native -> JS) : { "type": "event", "event": "<name>", "payload": { … } }

/// Contract §1.2 — the closed set of error codes a native response may carry.
enum ZodeErrorCode: String {
    case unsupported
    case invalid
    case denied
    case cancelled
    case notFound
    case internalError = "internal"
}

/// Errors raised inside the shell. Each case maps onto a contract error code.
enum ZodeBridgeError: Error {
    case unsupported(String)
    case invalid(String)
    case denied(String)
    case cancelled(String)
    case notFound(String)
    case internalError(String)

    var code: ZodeErrorCode {
        switch self {
        case .unsupported: return .unsupported
        case .invalid: return .invalid
        case .denied: return .denied
        case .cancelled: return .cancelled
        case .notFound: return .notFound
        case .internalError: return .internalError
        }
    }

    var message: String {
        switch self {
        case .unsupported(let m), .invalid(let m), .denied(let m),
             .cancelled(let m), .notFound(let m), .internalError(let m):
            return m
        }
    }
}

/// Contract §1.2 — the request envelope, parsed out of the message body.
struct ZodeRequest {
    let id: String
    let type: String
    let payload: [String: Any]

    init?(message: Any) {
        guard let dictionary = message as? [String: Any] else { return nil }
        guard let id = dictionary["id"] as? String, !id.isEmpty else { return nil }
        guard let type = dictionary["type"] as? String, !type.isEmpty else { return nil }
        self.id = id
        self.type = type
        self.payload = dictionary["payload"] as? [String: Any] ?? [:]
    }

    // MARK: Typed payload accessors

    func string(_ key: String) -> String? { payload[key] as? String }
    func double(_ key: String) -> Double? {
        if let value = payload[key] as? Double { return value }
        if let value = payload[key] as? NSNumber { return value.doubleValue }
        return nil
    }
    func bool(_ key: String) -> Bool? {
        if let value = payload[key] as? Bool { return value }
        if let value = payload[key] as? NSNumber { return value.boolValue }
        return nil
    }
    func dictionary(_ key: String) -> [String: Any]? { payload[key] as? [String: Any] }
}

/// Contract §1.2 — envelope construction and serialisation.
enum ZodeEnvelope {

    /// `{ "id": …, "ok": true, "result": { … } }`
    static func success(id: String, result: [String: Any] = [:]) -> [String: Any] {
        ["id": id, "ok": true, "result": result]
    }

    /// `{ "id": …, "ok": false, "error": { "code": …, "message": … } }`
    static func failure(id: String, code: ZodeErrorCode, message: String) -> [String: Any] {
        ["id": id, "ok": false, "error": ["code": code.rawValue, "message": message]]
    }

    /// `{ "type": "event", "event": "…", "payload": { … } }`
    static func event(name: String, payload: [String: Any]) -> [String: Any] {
        ["type": "event", "event": name, "payload": payload]
    }

    /// Serialises an envelope to the JSON text that is handed to the page.
    ///
    /// Returns `nil` when the envelope is not representable in JSON — the
    /// caller then simply drops the message (contract §2.2: "a native event
    /// with no listener is dropped (never buffered)").
    static func json(_ envelope: [String: Any]) -> String? {
        guard JSONSerialization.isValidJSONObject(envelope) else { return nil }
        guard let data = try? JSONSerialization.data(withJSONObject: envelope, options: []) else { return nil }
        return String(data: data, encoding: .utf8)
    }
}
