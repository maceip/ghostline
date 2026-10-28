//
//  NowPlayingView.swift
//  ZodeMobile
//
//  Metro's Now Playing: an oversized square tile, a light-weight display
//  title, a chunky square-cornered scrubber and big transport glyphs.
//

import SwiftUI

struct NowPlayingView: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.metroPalette) private var palette

    private var track: Track? { appState.currentTrack }
    private var album: Album? { appState.currentAlbum }
    private var artist: Artist? { appState.currentArtist }

    var body: some View {
        ScrollView(showsIndicators: false) {
            VStack(alignment: .leading, spacing: ZodeTokens.Metrics.space6) {
                header

                artwork

                titles

                scrubber

                transport
            }
            .padding(.horizontal, ZodeTokens.Metrics.gutter)
            .padding(.top, ZodeTokens.Metrics.space6)
            .padding(.bottom, ZodeTokens.Metrics.space8)
        }
        .background(palette.canvas)
    }

    // MARK: - Pieces

    private var header: some View {
        HStack {
            MetroLabel("Now Playing")
                .foregroundStyle(palette.textMuted)
            Spacer()
            Button {
                appState.toggleTheme()
            } label: {
                Text(appState.theme.label)
                    .font(MetroFont.micro())
                    .tracking(ZodeTokens.Tracking.trackingLabel)
                    .foregroundStyle(palette.accent)
                    .padding(.horizontal, ZodeTokens.Metrics.space3)
                    .padding(.vertical, ZodeTokens.Metrics.space2)
                    .background(palette.accentGhost)
                    .clipShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
    }

    private var artwork: some View {
        let accent = album.map { Color(hex: $0.accentHex) } ?? palette.accent
        let caption = album?.title ?? "Zode"
        return MetroArtwork(accent: accent, caption: caption, size: artworkSize)
            .frame(maxWidth: .infinity)
            .aspectRatio(1, contentMode: .fit)
            .shadow(
                color: Color.black.opacity(0.35),
                radius: ZodeTokens.Elevation.shadowTile.first?.radius ?? 14,
                y: ZodeTokens.Elevation.shadowTile.first?.offsetY ?? 2
            )
    }

    private var artworkSize: CGFloat {
        UIScreen.main.bounds.width - ZodeTokens.Metrics.gutter * 2
    }

    private var titles: some View {
        VStack(alignment: .leading, spacing: ZodeTokens.Metrics.space1) {
            Text(track?.title ?? "Nothing playing")
                .font(MetroFont.display(min(ZodeTokens.TypeScale.typeDisplay, 38)))
                .foregroundStyle(palette.text)
                .lineLimit(2)
                .minimumScaleFactor(0.6)

            Text(artist?.name ?? "Pick something in the Library")
                .font(MetroFont.subtitle())
                .foregroundStyle(palette.textMuted)
                .lineLimit(1)
        }
    }

    private var scrubber: some View {
        VStack(spacing: ZodeTokens.Metrics.space2) {
            GeometryReader { geometry in
                let fraction = fraction
                ZStack(alignment: .leading) {
                    Rectangle()
                        .fill(palette.surfaceAlt)
                    Rectangle()
                        .fill(palette.accent)
                        .frame(width: geometry.size.width * fraction)
                    Rectangle()
                        .fill(palette.accentBright)
                        .frame(width: 14, height: 14)
                        .offset(x: geometry.size.width * fraction - 7)
                }
                .frame(height: 14)
                .contentShape(Rectangle())
                .gesture(
                    DragGesture(minimumDistance: 0)
                        .onChanged { value in
                            let ratio = value.location.x / max(geometry.size.width, 1)
                            appState.scrub(to: ratio)
                        }
                )
            }
            .frame(height: 14)

            HStack {
                Text(elapsedLabel)
                Spacer()
                Text(remainingLabel)
            }
            .font(MetroFont.micro())
            .tracking(ZodeTokens.Tracking.trackingLabel)
            .foregroundStyle(palette.textMuted)
        }
    }

    private var transport: some View {
        HStack(spacing: ZodeTokens.Metrics.space4) {
            MetroGlyphButton(glyph: "backward.fill", size: 60, foreground: palette.text) {
                appState.previous()
            }
            MetroGlyphButton(
                glyph: appState.playback.isPlaying ? "pause.fill" : "play.fill",
                size: 76,
                foreground: palette.onAccent,
                background: palette.accent
            ) {
                appState.togglePlayback()
            }
            MetroGlyphButton(glyph: "forward.fill", size: 60, foreground: palette.text) {
                appState.next()
            }
        }
        .frame(maxWidth: .infinity)
    }

    // MARK: - Values

    private var fraction: Double {
        guard let track else { return 0 }
        guard track.durationSeconds > 0 else { return 0 }
        return min(max(appState.playback.elapsed / Double(track.durationSeconds), 0), 1)
    }

    private var elapsedLabel: String {
        format(appState.playback.elapsed)
    }

    private var remainingLabel: String {
        let duration = Double(track?.durationSeconds ?? 0)
        return "-" + format(max(duration - appState.playback.elapsed, 0))
    }

    private func format(_ seconds: TimeInterval) -> String {
        let total = Int(seconds.rounded())
        return String(format: "%d:%02d", total / 60, total % 60)
    }
}
