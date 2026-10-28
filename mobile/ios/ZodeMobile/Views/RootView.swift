//
//  RootView.swift
//  ZodeMobile
//
//  The app shell: a Metro canvas with the view switcher and the rail of big
//  square tiles along the bottom (Metro's left rail, folded for a phone).
//

import SwiftUI

struct RootView: View {
    @EnvironmentObject private var appState: AppState

    var body: some View {
        ZStack {
            MetroPalette.of(appState.theme).canvas.ignoresSafeArea()

            VStack(spacing: 0) {
                currentView
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                MetroRail()
            }
        }
        .environment(\.metroPalette, MetroPalette.of(appState.theme))
        .preferredColorScheme(appState.theme.colorScheme)
        .background(MetroPalette.of(appState.theme).canvas.ignoresSafeArea())
    }

    @ViewBuilder
    private var currentView: some View {
        switch appState.router.view {
        case .nowPlaying:
            NowPlayingView()
                .id(AppView.nowPlaying)
        case .collection:
            CollectionView()
                .id(AppView.collection)
        case .library:
            LibraryView()
                .id(AppView.library)
        case .search:
            SearchView()
                .id(AppView.search)
        case .agent:
            AgentView()
                .id(AppView.agent)
        }
    }
}

/// The Metro rail: five big flat square tiles.
struct MetroRail: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.metroPalette) private var palette

    var body: some View {
        VStack(spacing: 0) {
            Rectangle()
                .fill(palette.hairline)
                .frame(height: 1)

            HStack(spacing: ZodeTokens.Metrics.space2) {
                ForEach(AppView.railOrder) { view in
                    tile(for: view)
                }
            }
            .padding(.horizontal, ZodeTokens.Metrics.gutter)
            .padding(.vertical, ZodeTokens.Metrics.space3)
        }
        .background(palette.surface)
    }

    private func tile(for view: AppView) -> some View {
        let selected = appState.router.view == view
        return Button {
            appState.show(view)
        } label: {
            VStack(spacing: ZodeTokens.Metrics.space1) {
                Image(systemName: view.glyph)
                    .font(.system(size: 20, weight: .light))
                    .frame(height: 24)
                Text(view.label)
                    .font(MetroFont.micro())
                    .tracking(ZodeTokens.Tracking.trackingLabel)
            }
            .foregroundStyle(selected ? palette.onAccent : palette.textMuted)
            .frame(maxWidth: .infinity)
            .padding(.vertical, ZodeTokens.Metrics.space3)
            .background(selected ? palette.accent : palette.surfaceAlt)
            .clipShape(Rectangle())
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(view.label.capitalized))
        .accessibilityAddTraits(selected ? [.isSelected, .isButton] : .isButton)
    }
}
