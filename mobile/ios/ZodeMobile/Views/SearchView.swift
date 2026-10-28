//
//  SearchView.swift
//  ZodeMobile
//
//  Search over the library, the agent tasks and the attachments. Results are
//  grouped by the contract's `kind` values (track, album, artist, playlist,
//  task, file, action).
//

import SwiftUI

struct SearchView: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.metroPalette) private var palette

    @State private var query: String = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header

            ScrollView(showsIndicators: false) {
                LazyVStack(alignment: .leading, spacing: ZodeTokens.Metrics.space6) {
                    if appState.searchResults.isEmpty {
                        emptyState
                    } else {
                        ForEach(appState.groupedSearchResults, id: \.kind) { group in
                            section(group.kind, results: group.results)
                        }
                    }
                }
                .padding(.bottom, ZodeTokens.Metrics.space8)
            }
        }
        .background(palette.canvas)
        .onAppear {
            if let incoming = appState.router.incomingSearch {
                query = incoming
                appState.router.incomingSearch = nil
                appState.updateSearch(incoming)
            }
        }
        .onChange(of: query) { _, newValue in
            appState.updateSearch(newValue)
        }
    }

    // MARK: - Header

    private var header: some View {
        VStack(alignment: .leading, spacing: ZodeTokens.Metrics.space3) {
            MetroLabel("Search")
                .foregroundStyle(palette.textMuted)
                .padding(.horizontal, ZodeTokens.Metrics.gutter)
                .padding(.top, ZodeTokens.Metrics.space6)

            HStack(spacing: ZodeTokens.Metrics.space2) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 14, weight: .light))
                    .foregroundStyle(palette.textMuted)
                TextField("Tracks, albums, artists, tasks", text: $query)
                    .font(MetroFont.body())
                    .foregroundStyle(palette.text)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.search)
                if !query.isEmpty {
                    Button {
                        query = ""
                        appState.updateSearch("")
                    } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(palette.textMuted)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, ZodeTokens.Metrics.space3)
            .padding(.vertical, ZodeTokens.Metrics.space3)
            .background(palette.surface)
            .clipShape(Rectangle())
            .padding(.horizontal, ZodeTokens.Metrics.gutter)
        }
        .padding(.bottom, ZodeTokens.Metrics.space4)
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: ZodeTokens.Metrics.space2) {
            Text(query.isEmpty ? "TYPE TO SEARCH" : "NOTHING FOUND")
                .font(MetroFont.label())
                .tracking(ZodeTokens.Tracking.trackingLabel)
                .foregroundStyle(palette.textMuted)
            Text("Tracks, albums, artists, playlists, agent tasks and attachments.")
                .font(MetroFont.body())
                .foregroundStyle(palette.textMuted)
        }
        .padding(.horizontal, ZodeTokens.Metrics.gutter)
    }

    // MARK: - Results

    private func section(_ kind: SearchResult.Kind, results: [SearchResult]) -> some View {
        VStack(alignment: .leading, spacing: ZodeTokens.Metrics.space2) {
            MetroSectionHeader(kind.rawValue)
                .padding(.horizontal, ZodeTokens.Metrics.gutter)

            VStack(spacing: 0) {
                ForEach(results) { result in
                    Button {
                        open(result)
                    } label: {
                        HStack(spacing: ZodeTokens.Metrics.space4) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(result.title)
                                    .font(MetroFont.body())
                                    .foregroundStyle(palette.text)
                                    .lineLimit(1)
                                if let subtitle = result.subtitle {
                                    Text(subtitle)
                                        .font(MetroFont.micro())
                                        .tracking(ZodeTokens.Tracking.trackingLabel)
                                        .foregroundStyle(palette.textMuted)
                                        .lineLimit(1)
                                }
                            }
                            Spacer(minLength: ZodeTokens.Metrics.space3)
                            Image(systemName: "chevron.right")
                                .font(.system(size: 11, weight: .light))
                                .foregroundStyle(palette.textMuted)
                        }
                        .padding(.horizontal, ZodeTokens.Metrics.gutter)
                        .padding(.vertical, ZodeTokens.Metrics.space3)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)

                    Rectangle()
                        .fill(palette.hairline)
                        .frame(height: 1)
                        .padding(.horizontal, ZodeTokens.Metrics.gutter)
                }
            }
        }
    }

    private func open(_ result: SearchResult) {
        appState.haptics.play("select")
        switch result.kind {
        case .track:
            if let id = result.payload["id"] {
                appState.playTrack(id)
                appState.show(.nowPlaying)
            }
        case .album, .artist, .playlist:
            if let id = result.payload["id"], let kind = result.payload["kind"] {
                appState.performIntent(
                    ZodeIntent.play.rawValue,
                    payload: ["id": id, "kind": kind]
                )
                appState.show(.nowPlaying)
            }
        case .task:
            appState.show(.agent)
        case .file:
            appState.show(.agent)
        case .action:
            if let id = result.payload["id"], let kind = result.payload["kind"] {
                appState.performIntent(
                    ZodeIntent.play.rawValue,
                    payload: ["id": id, "kind": kind]
                )
                appState.show(.nowPlaying)
            }
        }
    }
}
