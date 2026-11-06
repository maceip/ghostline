//  touchid_stepup.swift
//
//  macOS Touch ID step-up helper for the Qwen RepE safety guard.
//
//  A "step-up" is a fresh, human authorization for one tool call. This helper
//  performs the biometric half of it and prints a single machine-readable line:
//
//      STEPUP_OK <unix_timestamp> <base64_nonce>     exit 0
//      STEPUP_FAIL <error_code>                      exit 1
//      STEPUP_UNAVAILABLE <reason>                   exit 3
//
//  Exit codes: 0 success, 1 the gesture failed or was cancelled, 2 usage
//  error, 3 biometrics are not usable on this machine.
//
//  REALITY CHECK — Touch ID is often NOT usable from a headless CLI:
//  `canEvaluatePolicy` returns false when no biometric is enrolled, when no
//  passcode is set, or when there is no GUI login session; `evaluatePolicy`
//  can also fail with `notInteractive` in a headless context. This helper
//  reports that honestly (STEPUP_UNAVAILABLE / STEPUP_FAIL) instead of
//  pretending a human approved anything.
//
//  FALLBACK PATH — because biometric step-up is not always available, the
//  guard also accepts a *policy-signed* step-up: a trusted automated policy
//  component mints a capability token directly with the same Ed25519 key,
//  using `subject = "policy:<name>"`. The guard then verifies that token
//  offline exactly like a biometric one, and only accepts subjects from its
//  allowlist. A policy-signed step-up is explicitly NOT a human approval and
//  must never be reported as one.
//
//      capability-tool mint --private-key <b64> --tool <name> \
//          --args-json <json> --ttl 60 --subject policy:local-runner
//
//  Usage:
//      touchid_stepup [--reason "text shown in the prompt"] [--timeout secs]

import Foundation
import LocalAuthentication
import Security

let exitOK: Int32 = 0
let exitFail: Int32 = 1
let exitUsage: Int32 = 2
let exitUnavailable: Int32 = 3

/// The LocalAuthentication error domain, spelled out so we do not depend on
/// the bridged `LAError.errorDomain` accessor being present.
let localAuthenticationDomain = "com.apple.LocalAuthentication"

/// Carries the callback result across the LocalAuthentication thread.
final class ResultBox: @unchecked Sendable {
    private let lock = NSLock()
    private var succeeded = false
    private var failure: Error?

    func record(success: Bool, error: Error?) {
        lock.lock()
        defer { lock.unlock() }
        succeeded = success
        failure = error
    }

    var outcome: (Bool, Error?) {
        lock.lock()
        defer { lock.unlock() }
        return (succeeded, failure)
    }
}

func usage(_ message: String) -> Never {
    FileHandle.standardError.write(Data("usage error: \(message)\n".utf8))
    exit(exitUsage)
}

func errorCode(_ error: Error?) -> Int {
    guard let error else { return -1 }
    return (error as NSError).code
}

func failureReason(_ error: Error?) -> String {
    guard let error else { return "authentication failed without an error" }
    let nsError = error as NSError
    if nsError.domain == localAuthenticationDomain,
       let code = LAError.Code(rawValue: nsError.code) {
        return "\(name(of: code)): \(oneLine(nsError.localizedDescription))"
    }
    return "\(nsError.domain) \(nsError.code): \(oneLine(nsError.localizedDescription))"
}

func unavailableReason(_ error: NSError?) -> String {
    guard let error else { return "unknown: canEvaluatePolicy failed without an error" }
    if error.domain == localAuthenticationDomain,
       let code = LAError.Code(rawValue: error.code) {
        return "\(name(of: code)): \(oneLine(error.localizedDescription))"
    }
    return "\(error.domain) \(error.code): \(oneLine(error.localizedDescription))"
}

func name(of code: LAError.Code) -> String {
    switch code {
    case .authenticationFailed: return "authenticationFailed"
    case .userCancel: return "userCancel"
    case .userFallback: return "userFallback"
    case .systemCancel: return "systemCancel"
    case .passcodeNotSet: return "passcodeNotSet"
    case .biometryNotAvailable: return "biometryNotAvailable"
    case .biometryNotEnrolled: return "biometryNotEnrolled"
    case .biometryLockout: return "biometryLockout"
    case .appCancel: return "appCancel"
    case .invalidContext: return "invalidContext"
    case .notInteractive: return "notInteractive"
    case .touchIDNotAvailable: return "touchIDNotAvailable"
    case .touchIDNotEnrolled: return "touchIDNotEnrolled"
    case .touchIDLockout: return "touchIDLockout"
    case .watchNotAvailable: return "watchNotAvailable"
    case .biometryNotPaired: return "biometryNotPaired"
    case .biometryDisconnected: return "biometryDisconnected"
    case .invalidDimensions: return "invalidDimensions"
    @unknown default: return "unknown(\(code.rawValue))"
    }
}

/// Collapses a message to a single line so the status line stays parseable.
func oneLine(_ text: String) -> String {
    text.replacingOccurrences(of: "\n", with: " ")
        .replacingOccurrences(of: "\r", with: " ")
        .trimmingCharacters(in: .whitespaces)
}

func evaluate(reason: String, timeout: Double) -> Never {
    let context = LAContext()
    // Biometrics only: an empty fallback title removes the "Enter Password"
    // button, so a passcode can never be mistaken for a biometric gesture.
    context.localizedFallbackTitle = ""
    context.localizedCancelTitle = "Cancel"

    let policy = LAPolicy.deviceOwnerAuthenticationWithBiometrics
    var evaluationError: NSError?
    guard context.canEvaluatePolicy(policy, error: &evaluationError) else {
        print("STEPUP_UNAVAILABLE \(unavailableReason(evaluationError))")
        exit(exitUnavailable)
    }

    let box = ResultBox()
    let semaphore = DispatchSemaphore(value: 0)
    context.evaluatePolicy(policy, localizedReason: reason) { success, error in
        box.record(success: success, error: error)
        semaphore.signal()
    }

    if timeout > 0 {
        if semaphore.wait(timeout: .now() + timeout) == .timedOut {
            context.invalidate()
            print("STEPUP_FAIL timeout")
            FileHandle.standardError.write(
                Data("detail: no biometric response within \(Int(timeout))s\n".utf8))
            exit(exitFail)
        }
    } else {
        semaphore.wait()
    }

    let (succeeded, error) = box.outcome
    guard succeeded else {
        let code = errorCode(error)
        print("STEPUP_FAIL \(code)")
        FileHandle.standardError.write(Data("detail: \(failureReason(error))\n".utf8))
        exit(exitFail)
    }

    var nonce = [UInt8](repeating: 0, count: 16)
    let status = nonce.withUnsafeMutableBytes { buffer -> Int32 in
        guard let base = buffer.baseAddress else { return errSecParam }
        return SecRandomCopyBytes(kSecRandomDefault, buffer.count, base)
    }
    guard status == errSecSuccess else {
        print("STEPUP_FAIL random")
        FileHandle.standardError.write(
            Data("detail: SecRandomCopyBytes failed with status \(status)\n".utf8))
        exit(exitFail)
    }

    let timestamp = Int(Date().timeIntervalSince1970)
    print("STEPUP_OK \(timestamp) \(Data(nonce).base64EncodedString())")
    exit(exitOK)
}

// --- entry point -------------------------------------------------------------

var reason = "Approve the requested tool call"
var timeoutSeconds: Double = 60
var arguments = Array(CommandLine.arguments.dropFirst())

while !arguments.isEmpty {
    let argument = arguments.removeFirst()
    switch argument {
    case "--reason":
        guard !arguments.isEmpty else { usage("--reason needs a value") }
        reason = arguments.removeFirst()
    case "--timeout":
        guard !arguments.isEmpty, let value = Double(arguments.removeFirst()) else {
            usage("--timeout needs a number of seconds")
        }
        timeoutSeconds = value
    case "--help", "-h":
        print("usage: touchid_stepup [--reason <text>] [--timeout <seconds>]")
        exit(exitOK)
    default:
        usage("unknown argument \(argument)")
    }
}

evaluate(reason: reason, timeout: timeoutSeconds)
