//
//  LibraryView.swift
//  ZodeMobile
//
//  A dense, Metro-style list: index number on the left, title and artist in
//  the middle, duration on the right. No rows are rounded and there is no
//  chrome beyond a hairline.
//

import SwiftUI

struct LibraryView: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.metroPalette) private var palette

    @State private var filter: String = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header

            ScrollView(showsIndicators: false) {
                LazyVStack(spacing: 0) {
                    ForEach(filteredTracks) { track in
                        row(track)
                        Rectangle()
                            .fill(palette.hairline)
                            .frame(height: 1)
                    }
                }
                .padding(.bottom, ZodeTokens.Metrics.space8)
            }
        }
        .background(palette.canvas)
    }

    // MARK: - Header

    private var header: some View {
        VStack(alignment: .leading, spacing: ZodeTokens.Metrics.space3) {
            HStack {
                MetroLabel("Library")
                    .foregroundStyle(palette.textMuted)
                Spacer()
                Text("\(filteredTracks.count) TRACKS")
                    .font(MetroFont.micro())
                    .tracking(ZodeTokens.Tracking.trackingLabel)
                    .foregroundStyle(palette.textMuted)
            }
            .padding(.horizontal, ZodeTokens.Metrics.gutter)
            .padding(.top, ZodeTokens.Metrics.space6)

            HStack(spacing: ZodeTokens.Metrics.space2) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 13, weight: .light))
                    .foregroundStyle(palette.textMuted)
                TextField("Filter", text: $filter)
                    .font(MetroFont.body())
                    .foregroundStyle(palette.text)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            }
            .padding(.horizontal, ZodeTokens.Metrics.space3)
            .padding(.vertical, ZodeTokens.Metrics.space3)
            .background(palette.surface)
            .clipShape(Rectangle())
            .padding(.horizontal, ZodeTokens.Metrics.gutter)
        }
        .padding(.bottom, ZodeTokens.Metrics.space4)
    }

    // MARK: - Rows

    private func row(_ track: Track) -> some View {
        Button {
            appState.playTrack(track.id)
            appState.show(.nowPlaying)
        } label: {
            HStack(spacing: ZodeTokens.Metrics.space4) {
                Text(String(format: "%02d", track.trackNumber))
                    .font(MetroFont.micro())
                    .tracking(ZodeTokens.Tracking.trackingLabel)
                    .foregroundStyle(palette.textMuted)
                    .frame(width: 28, alignment: .leading)

                VStack(alignment: .leading, spacing: 2) {
                    Text(track.title)
                        .font(MetroFont.body())
                        .foregroundStyle(palette.text)
                        .lineLimit(1)
                    Text(appState.library.artist(track.artistID)?.name ?? "")
                        .font(MetroFont.micro())
                        .tracking(ZodeTokens.Tracking.trackingLabel)
                        .foregroundStyle(palette.textMuted)
                        .lineLimit(1)
                }

                Spacer(minLength: ZodeTokens.Metrics.space3)

                Text(track.durationLabel)
                    .font(MetroFont.micro())
                    .tracking(ZodeTokens.Tracking.trackingLabel)
                    .foregroundStyle(palette.textMuted)
            }
            .padding(.horizontal, ZodeTokens.Metrics.gutter)
            .padding(.vertical, ZodeTokens.Metrics.space3)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var filteredTracks: [Track] {
        let needle = filter.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !needle.isEmpty else { return appState.library.tracks }
        return appState.library.tracks.filter { track in
            let artist = appState.library.artist(track.artistID)?.name.lowercased() ?? ""
            return track.title.lowercased().contains(needle) || artist.contains(needle)
        }
    }
}
