//
//  RevealTransition.swift
//  ZodeMobile
//
//  Metro's characteristic motion: a fast "reveal" that scales and lifts a
//  panel into place, then settles. The curve comes from the shared tokens
//  (`--ease-reveal`), and every animation here is skipped when the user has
//  asked for reduced motion (`UIAccessibility.isReduceMotionEnabled`).
//

import SwiftUI

public extension AnyTransition {
    /// The Metro reveal: a short scale-and-lift, with a plain fade on removal.
    static var metroReveal: AnyTransition {
        .asymmetric(
            insertion: .scale(scale: 0.92, anchor: .top)
                .combined(with: .opacity)
                .combined(with: .offset(y: 18)),
            removal: .opacity
        )
    }

    /// A faster reveal for the small panels.
    static var metroRevealFast: AnyTransition {
        .asymmetric(
            insertion: .scale(scale: 0.96, anchor: .top)
                .combined(with: .opacity),
            removal: .opacity
        )
    }
}

/// Applies the reveal transition to a view, honouring Reduce Motion.
public struct MetroRevealModifier: ViewModifier {
    private let fast: Bool

    public init(fast: Bool = false) {
        self.fast = fast
    }

    public func body(content: Content) -> some View {
        content.transition(fast ? AnyTransition.metroRevealFast : AnyTransition.metroReveal)
    }
}

public extension View {
    /// Wraps the view in the Metro reveal transition.
    func metroReveal(fast: Bool = false) -> some View {
        modifier(MetroRevealModifier(fast: fast))
    }

    /// Applies the reveal animation when `active` becomes true.
    func metroRevealAnimation(active: Bool, fast: Bool = false) -> some View {
        let duration = fast ? ZodeTokens.Motion.durFast : ZodeTokens.Motion.durBase
        return animation(
            active ? MetroMotion.reveal(duration) : MetroMotion.fade(ZodeTokens.Motion.durFast),
            value: active
        )
    }
}

/// A phase clock used by the "working" indicator so it pulses in time with
/// the `working` haptic program. The phase is normalised 0...1 over one
/// period; the Agent view maps it through the program's intensity curve.
public struct MetroPhaseClock: View {
    private let period: Double
    private let isRunning: Bool
    private let onPhase: (Double) -> Void

    public init(period: Double, isRunning: Bool, onPhase: @escaping (Double) -> Void) {
        self.period = period
        self.isRunning = isRunning
        self.onPhase = onPhase
    }

    public var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30.0, paused: !isRunning)) { context in
            let elapsed = context.date.timeIntervalSinceReferenceDate
            let phase = period > 0 ? (elapsed.truncatingRemainder(dividingBy: period)) / period : 0
            let value = isRunning ? phase : 0
            Color.clear
                .onAppear { onPhase(value) }
                .onChange(of: value) { _, newValue in onPhase(newValue) }
        }
    }
}

