//
//  Tile.swift
//  ZodeMobile
//
//  Metro's building blocks: big flat squares with zero corner radius, flat
//  fills, uppercase tracked labels and no chrome whatsoever.
//

import SwiftUI

// MARK: - Tile

/// A flat, square-cornered tile. Metro never rounds its tiles.
public struct MetroTile<Content: View>: View {
    private let fill: Color
    private let content: Content

    public init(fill: Color = Color.clear, @ViewBuilder content: () -> Content) {
        self.fill = fill
        self.content = content()
    }

    public var body: some View {
        content
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background(fill)
            .clipShape(Rectangle())
    }
}

// MARK: - Labels

/// The uppercase, letter-spaced Metro label.
public struct MetroLabel: View {
    private let text: String
    private let size: CGFloat
    private let color: Color

    public init(_ text: String, size: CGFloat = ZodeTokens.TypeScale.typeLabel, color: Color? = nil) {
        self.text = text
        self.size = size
        self.color = color ?? Color.primary
    }

    public var body: some View {
        Text(text.uppercased())
            .font(MetroFont.label(size))
            .tracking(ZodeTokens.Tracking.trackingLabel)
            .foregroundStyle(color)
    }
}

/// A section header: an uppercase tracked label with an optional trailing note.
public struct MetroSectionHeader<Accessory: View>: View {
    private let title: String
    private let accessory: Accessory

    public init(_ title: String, @ViewBuilder accessory: () -> Accessory) {
        self.title = title
        self.accessory = accessory()
    }

    public var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: ZodeTokens.Metrics.space3) {
            MetroLabel(title)
                .foregroundStyle(Color.secondary)
            Spacer(minLength: 0)
            accessory
        }
    }
}

public extension MetroSectionHeader where Accessory == EmptyView {
    init(_ title: String) {
        self.init(title) { EmptyView() }
    }
}

// MARK: - Artwork

/// Flat album art. Metro's big square tile with a hairline bracket mark.
public struct MetroArtwork: View {
    private let accent: Color
    private let caption: String
    private let size: CGFloat

    public init(accent: Color, caption: String, size: CGFloat) {
        self.accent = accent
        self.caption = caption
        self.size = size
    }

    public var body: some View {
        ZStack(alignment: .bottomLeading) {
            accent

            // The Zune "bracket" mark, drawn flat.
            HStack(spacing: size * 0.06) {
                bracket(width: size * 0.035, height: size * 0.16, flipped: false)
                Circle()
                    .fill(Color.black.opacity(0.75))
                    .frame(width: size * 0.035, height: size * 0.035)
                bracket(width: size * 0.035, height: size * 0.16, flipped: true)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)

            Text(caption.uppercased())
                .font(MetroFont.micro())
                .tracking(ZodeTokens.Tracking.trackingLabel)
                .foregroundStyle(Color.black.opacity(0.8))
                .padding(size * 0.06)
        }
        .frame(width: size, height: size)
        .clipShape(Rectangle())
    }

    private func bracket(width: CGFloat, height: CGFloat, flipped: Bool) -> some View {
        ZStack(alignment: flipped ? .trailing : .leading) {
            Rectangle()
                .fill(Color.black.opacity(0.75))
                .frame(width: width, height: height)
            Rectangle()
                .fill(Color.black.opacity(0.75))
                .frame(width: width * 2.4, height: width)
                .offset(y: flipped ? -height / 2 + width / 2 : height / 2 - width / 2)
        }
        .frame(width: width * 2.4, height: height)
    }
}

// MARK: - Buttons

/// A flat square button. No border radius, no shadow.
public struct MetroGlyphButton: View {
    private let glyph: String
    private let size: CGFloat
    private let foreground: Color
    private let background: Color
    private let action: () -> Void

    public init(
        glyph: String,
        size: CGFloat = 56,
        foreground: Color = .primary,
        background: Color = .clear,
        action: @escaping () -> Void
    ) {
        self.glyph = glyph
        self.size = size
        self.foreground = foreground
        self.background = background
        self.action = action
    }

    public var body: some View {
        Button(action: action) {
            Image(systemName: glyph)
                .font(.system(size: size * 0.42, weight: .light))
                .foregroundStyle(foreground)
                .frame(width: size, height: size)
                .background(background)
                .clipShape(Rectangle())
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Bars

/// The chunky, square-cornered progress bar used by the scrubber.
public struct MetroProgressBar: View {
    private let progress: Double
    private let track: Color
    private let fill: Color
    private let height: CGFloat

    public init(
        progress: Double,
        track: Color,
        fill: Color,
        height: CGFloat = 10
    ) {
        self.progress = min(max(progress, 0), 1)
        self.track = track
        self.fill = fill
        self.height = height
    }

    public var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                Rectangle().fill(track)
                Rectangle()
                    .fill(fill)
                    .frame(width: geometry.size.width * progress)
            }
        }
        .frame(height: height)
        .clipShape(Rectangle())
    }
}

/// The Metro "working" indicator: a stack of flat blocks that pulse.
public struct MetroWorkingIndicator: View {
    private let phase: Double
    private let color: Color
    private let inactive: Color

    public init(phase: Double, color: Color, inactive: Color) {
        self.phase = phase
        self.color = color
        self.inactive = inactive
    }

    public var body: some View {
        HStack(spacing: ZodeTokens.Metrics.space2) {
            ForEach(0..<3, id: \.self) { index in
                Rectangle()
                    .fill(index == 0 ? color : inactive)
                    .frame(width: 10, height: 22)
                    .opacity(index == 0 ? 0.35 + 0.65 * phase : 0.35)
            }
        }
    }
}
