//
//  CollectionView.swift
//  ZodeMobile
//
//  Metro's horizontal carousel: big flat square album tiles that scroll
//  sideways, with uppercase tracked section headers.
//

import SwiftUI

struct CollectionView: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.metroPalette) private var palette

    private let tileSize: CGFloat = 156

    var body: some View {
        ScrollView(showsIndicators: false) {
            VStack(alignment: .leading, spacing: ZodeTokens.Metrics.space8) {
                albums
                playlists
                artists
            }
            .padding(.top, ZodeTokens.Metrics.space6)
            .padding(.bottom, ZodeTokens.Metrics.space8)
        }
        .background(palette.canvas)
    }

    // MARK: - Albums

    private var albums: some View {
        VStack(alignment: .leading, spacing: ZodeTokens.Metrics.space4) {
            MetroSectionHeader("Albums") {
                Text("\(appState.library.albums.count)")
                    .font(MetroFont.micro())
                    .tracking(ZodeTokens.Tracking.trackingLabel)
                    .foregroundStyle(palette.textMuted)
            }
            .padding(.horizontal, ZodeTokens.Metrics.gutter)

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: ZodeTokens.Metrics.space4) {
                    ForEach(appState.library.albums) { album in
                        albumTile(album)
                    }
                }
                .padding(.horizontal, ZodeTokens.Metrics.gutter)
                .padding(.vertical, ZodeTokens.Metrics.space2)
            }
        }
    }

    private func albumTile(_ album: Album) -> some View {
        Button {
            appState.play(.album(album.id))
            appState.show(.nowPlaying)
            appState.haptics.play("select")
        } label: {
            VStack(alignment: .leading, spacing: ZodeTokens.Metrics.space2) {
                MetroArtwork(
                    accent: Color(hex: album.accentHex),
                    caption: album.title,
                    size: tileSize
                )

                Text(album.title)
                    .font(MetroFont.body())
                    .foregroundStyle(palette.text)
                    .lineLimit(1)

                Text(appState.library.artist(album.artistID)?.name ?? "")
                    .font(MetroFont.micro())
                    .tracking(ZodeTokens.Tracking.trackingLabel)
                    .foregroundStyle(palette.textMuted)
                    .lineLimit(1)
            }
            .frame(width: tileSize, alignment: .leading)
        }
        .buttonStyle(.plain)
    }

    // MARK: - Playlists

    private var playlists: some View {
        VStack(alignment: .leading, spacing: ZodeTokens.Metrics.space4) {
            MetroSectionHeader("Playlists")
                .padding(.horizontal, ZodeTokens.Metrics.gutter)

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: ZodeTokens.Metrics.space4) {
                    ForEach(appState.library.playlists) { playlist in
                        playlistTile(playlist)
                    }
                }
                .padding(.horizontal, ZodeTokens.Metrics.gutter)
            }
        }
    }

    private func playlistTile(_ playlist: Playlist) -> some View {
        Button {
            appState.play(.playlist(playlist.id))
            appState.show(.nowPlaying)
            appState.haptics.play("select")
        } label: {
            VStack(alignment: .leading, spacing: ZodeTokens.Metrics.space2) {
                ZStack(alignment: .bottomLeading) {
                    palette.accent
                    Text("\(playlist.trackIDs.count)")
                        .font(MetroFont.display(40))
                        .foregroundStyle(palette.onAccent)
                        .padding(ZodeTokens.Metrics.space3)
                }
                .frame(width: tileSize, height: tileSize)
                .clipShape(Rectangle())

                Text(playlist.title)
                    .font(MetroFont.body())
                    .foregroundStyle(palette.text)
                    .lineLimit(1)

                Text(playlist.subtitle)
                    .font(MetroFont.micro())
                    .tracking(ZodeTokens.Tracking.trackingLabel)
                    .foregroundStyle(palette.textMuted)
                    .lineLimit(1)
            }
            .frame(width: tileSize, alignment: .leading)
        }
        .buttonStyle(.plain)
    }

    // MARK: - Artists

    private var artists: some View {
        VStack(alignment: .leading, spacing: ZodeTokens.Metrics.space3) {
            MetroSectionHeader("Artists")
                .padding(.horizontal, ZodeTokens.Metrics.gutter)

            VStack(spacing: 0) {
                ForEach(appState.library.artists) { artist in
                    Button {
                        appState.play(.artist(artist.id))
                        appState.show(.nowPlaying)
                        appState.haptics.play("select")
                    } label: {
                        HStack(spacing: ZodeTokens.Metrics.space4) {
                            Text(artist.name)
                                .font(MetroFont.subtitle())
                                .foregroundStyle(palette.text)
                            Spacer()
                            Text(artist.genre.uppercased())
                                .font(MetroFont.micro())
                                .tracking(ZodeTokens.Tracking.trackingLabel)
                                .foregroundStyle(palette.textMuted)
                        }
                        .padding(.vertical, ZodeTokens.Metrics.space4)
                        .padding(.horizontal, ZodeTokens.Metrics.gutter)
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
}
