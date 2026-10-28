//
//  MetroTheme.swift
//  ZodeMobile
//
//  The pre-2011 Microsoft Metro look: flat fills, zero corner radius, a
//  near-black or warm-paper canvas and a single Zune-orange accent.
//
//  Every colour and metric comes from `Design/Tokens.swift`, which is
//  generated from `packages/shared/tokens.css`.
//

import SwiftUI
import UIKit

// MARK: - Theme

/// The two canvases the app can run on.
public enum AppTheme: String, CaseIterable, Identifiable, Sendable {
    case ink
    case paper

    public var id: String { rawValue }

    /// Uppercase label used by the theme toggle.
    public var label: String {
        switch self {
        case .ink: return "INK"
        case .paper: return "PAPER"
        }
    }

    public var colorScheme: ColorScheme {
        switch self {
        case .ink: return .dark
        case .paper: return .light
        }
    }
}

/// The resolved colours for one theme.
public struct MetroPalette: Sendable {
    public let theme: AppTheme
    /// The canvas behind everything.
    public let canvas: Color
    /// A raised card.
    public let surface: Color
    /// A card on a card, or a divider block.
    public let surfaceAlt: Color
    /// Hairlines and outlines.
    public let hairline: Color
    /// Primary text.
    public let text: Color
    /// Secondary text.
    public let textMuted: Color
    /// The Zune orange accent.
    public let accent: Color
    /// The brighter variant used for pressed states.
    public let accentBright: Color
    /// A translucent accent wash.
    public let accentGhost: Color
    /// Text drawn on top of the accent.
    public let onAccent: Color

    public init(
        theme: AppTheme,
        canvas: Color,
        surface: Color,
        surfaceAlt: Color,
        hairline: Color,
        text: Color,
        textMuted: Color,
        accent: Color,
        accentBright: Color,
        accentGhost: Color,
        onAccent: Color
    ) {
        self.theme = theme
        self.canvas = canvas
        self.surface = surface
        self.surfaceAlt = surfaceAlt
        self.hairline = hairline
        self.text = text
        self.textMuted = textMuted
        self.accent = accent
        self.accentBright = accentBright
        self.accentGhost = accentGhost
        self.onAccent = onAccent
    }
}

public extension MetroPalette {
    /// Near-black canvas.
    static let ink = MetroPalette(
        theme: .ink,
        canvas: ZodeTokens.Colors.zodeInk,
        surface: ZodeTokens.Colors.zodeInk2,
        surfaceAlt: ZodeTokens.Colors.zodeInk3,
        hairline: ZodeTokens.Colors.zodeInk4,
        text: ZodeTokens.Colors.zodeTextInvert,
        textMuted: ZodeTokens.Colors.zodeTextInvertMuted,
        accent: ZodeTokens.Colors.zodeOrange,
        accentBright: ZodeTokens.Colors.zodeOrangeBright,
        accentGhost: ZodeTokens.Colors.zodeOrangeGhost,
        onAccent: ZodeTokens.Colors.zodeInk
    )

    /// Warm paper canvas.
    static let paper = MetroPalette(
        theme: .paper,
        canvas: ZodeTokens.Colors.zodePaper,
        surface: ZodeTokens.Colors.zodeWhite,
        surfaceAlt: ZodeTokens.Colors.zodePaper2,
        hairline: ZodeTokens.Colors.zodePaper3,
        text: ZodeTokens.Colors.zodeText,
        textMuted: ZodeTokens.Colors.zodeTextMuted,
        accent: ZodeTokens.Colors.zodeOrange,
        accentBright: ZodeTokens.Colors.zodeOrangeDeep,
        accentGhost: ZodeTokens.Colors.zodeOrangeGhost,
        onAccent: ZodeTokens.Colors.zodeWhite
    )

    static func of(_ theme: AppTheme) -> MetroPalette {
        switch theme {
        case .ink: return .ink
        case .paper: return .paper
        }
    }
}

// MARK: - Environment

private struct MetroPaletteKey: EnvironmentKey {
    static let defaultValue: MetroPalette = .ink
}

public extension EnvironmentValues {
    /// The active Metro palette.
    var metroPalette: MetroPalette {
        get { self[MetroPaletteKey.self] }
        set { self[MetroPaletteKey.self] = newValue }
    }
}

// MARK: - Type

/// Segoe-style type. iOS does not ship "Segoe UI", so the stack falls back to
/// the system face; the *weight* and *tracking* carry the Metro character.
public enum MetroFont {
    private static func uiFont(size: CGFloat, weight: UIFont.Weight) -> Font {
        let candidates: [String]
        switch weight {
        case .light: candidates = ["Segoe UI Light", "Segoe UI Semilight"]
        case .semibold: candidates = ["Segoe UI Semibold"]
        case .bold: candidates = ["Segoe UI Bold"]
        default: candidates = ["Segoe UI"]
        }
        for name in candidates {
            if let font = UIFont(name: name, size: size) {
                return Font(font)
            }
        }
        return .system(size: size, weight: swiftUIWeight(weight))
    }

    private static func swiftUIWeight(_ weight: UIFont.Weight) -> Font.Weight {
        switch weight {
        case .light: return .light
        case .semibold: return .semibold
        case .bold: return .bold
        case .black: return .black
        case .heavy: return .heavy
        default: return .regular
        }
    }

    /// The big, light display face.
    public static func display(_ size: CGFloat = ZodeTokens.TypeScale.typeDisplay) -> Font {
        uiFont(size: size, weight: .light)
    }

    /// Section titles.
    public static func title(_ size: CGFloat = ZodeTokens.TypeScale.typeTitle) -> Font {
        uiFont(size: size, weight: .light)
    }

    /// Sub-headings.
    public static func subtitle(_ size: CGFloat = ZodeTokens.TypeScale.typeSubtitle) -> Font {
        uiFont(size: size, weight: .regular)
    }

    /// Body copy.
    public static func body(_ size: CGFloat = ZodeTokens.TypeScale.typeBody) -> Font {
        uiFont(size: size, weight: .regular)
    }

    /// The uppercase tracked label.
    public static func label(_ size: CGFloat = ZodeTokens.TypeScale.typeLabel) -> Font {
        uiFont(size: size, weight: .semibold)
    }

    /// The tiny label.
    public static func micro(_ size: CGFloat = ZodeTokens.TypeScale.typeMicro) -> Font {
        uiFont(size: size, weight: .semibold)
    }
}

// MARK: - Motion

/// Motion helpers that honour the Reduce Motion accessibility setting.
public enum MetroMotion {
    /// True when the user asked for less motion.
    public static var reduceMotionEnabled: Bool {
        UIAccessibility.isReduceMotionEnabled
    }

    /// The Metro "reveal" curve: fast out, gentle settle.
    public static func reveal(_ milliseconds: Double = ZodeTokens.Motion.durBase) -> Animation? {
        guard !reduceMotionEnabled else { return nil }
        let curve = ZodeTokens.Motion.easeReveal
        guard curve.count == 4 else {
            return .easeOut(duration: milliseconds / 1000)
        }
        return .timingCurve(
            curve[0],
            curve[1],
            curve[2],
            curve[3],
            duration: milliseconds / 1000
        )
    }

    /// A plain fade, used when motion is reduced.
    public static func fade(_ milliseconds: Double = ZodeTokens.Motion.durFast) -> Animation? {
        guard !reduceMotionEnabled else { return nil }
        return .easeOut(duration: milliseconds / 1000)
    }
}
