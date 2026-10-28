//
//  AgentView.swift
//  ZodeMobile
//
//  The agent panel: a task list, a running-task state, a composer and a live
//  status region.
//
//  The "working" indicator pulses in time with the `working` haptic program
//  from `packages/shared/haptics.json` -- the same 2400 ms cycle and the same
//  intensity curve that drive the Taptic Engine.
//

import SwiftUI

struct AgentView: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.metroPalette) private var palette

    @State private var draft: String = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header

            ScrollView(showsIndicators: false) {
                LazyVStack(alignment: .leading, spacing: ZodeTokens.Metrics.space6) {
                    if appState.agent.tasks.isEmpty {
                        emptyState
                    } else {
                        ForEach(appState.agent.tasks) { task in
                            taskCard(task)
                        }
                    }

                    if !appState.attachments.isEmpty {
                        attachments
                    }
                }
                .padding(.horizontal, ZodeTokens.Metrics.gutter)
                .padding(.bottom, ZodeTokens.Metrics.space6)
            }

            composer
        }
        .background(palette.canvas)
    }

    // MARK: - Header

    private var header: some View {
        HStack {
            MetroLabel("Agent")
                .foregroundStyle(palette.textMuted)
            Spacer()
            if appState.agent.runningTaskID != nil {
                Button {
                    appState.stopTask()
                } label: {
                    Text("STOP")
                        .font(MetroFont.micro())
                        .tracking(ZodeTokens.Tracking.trackingLabel)
                        .foregroundStyle(palette.onAccent)
                        .padding(.horizontal, ZodeTokens.Metrics.space3)
                        .padding(.vertical, ZodeTokens.Metrics.space2)
                        .background(palette.accent)
                        .clipShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, ZodeTokens.Metrics.gutter)
        .padding(.top, ZodeTokens.Metrics.space6)
        .padding(.bottom, ZodeTokens.Metrics.space4)
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: ZodeTokens.Metrics.space2) {
            Text("NO TASKS YET")
                .font(MetroFont.label())
                .tracking(ZodeTokens.Tracking.trackingLabel)
                .foregroundStyle(palette.textMuted)
            Text("Ask the agent to build a set, find a track or organise your library.")
                .font(MetroFont.body())
                .foregroundStyle(palette.textMuted)
        }
    }

    // MARK: - Task card

    private func taskCard(_ task: AgentTask) -> some View {
        VStack(alignment: .leading, spacing: ZodeTokens.Metrics.space3) {
            HStack(alignment: .top) {
                Text(task.prompt)
                    .font(MetroFont.subtitle())
                    .foregroundStyle(palette.text)
                Spacer(minLength: ZodeTokens.Metrics.space3)
                Text(task.state.rawValue.uppercased())
                    .font(MetroFont.micro())
                    .tracking(ZodeTokens.Tracking.trackingLabel)
                    .foregroundStyle(statusColor(task.state))
            }

            if task.isRunning {
                MetroProgressBar(
                    progress: task.progress,
                    track: palette.surfaceAlt,
                    fill: palette.accent,
                    height: 6
                )
                workingIndicator(since: task.startedAt)
            }

            VStack(alignment: .leading, spacing: ZodeTokens.Metrics.space2) {
                ForEach(task.messages) { message in
                    messageRow(message)
                }
            }
        }
        .padding(ZodeTokens.Metrics.space4)
        .background(palette.surface)
        .clipShape(Rectangle())
    }

    private func messageRow(_ message: AgentMessage) -> some View {
        HStack(alignment: .top, spacing: ZodeTokens.Metrics.space3) {
            Rectangle()
                .fill(color(for: message.role))
                .frame(width: 3)
            Text(message.text)
                .font(MetroFont.body())
                .foregroundStyle(message.role == .user ? palette.text : palette.textMuted)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
    }

    private func color(for role: AgentMessage.Role) -> Color {
        switch role {
        case .user: return palette.accent
        case .agent: return palette.textMuted
        case .system: return palette.hairline
        }
    }

    private func statusColor(_ state: AgentTask.State) -> Color {
        switch state {
        case .running: return palette.accent
        case .done: return ZodeTokens.Colors.zodeAccentGreen
        case .failed: return ZodeTokens.Colors.zodeAccentOrange
        case .stopped, .pending: return palette.textMuted
        }
    }

    /// The pulse, driven by the shared `working` program.
    private func workingIndicator(since start: Date) -> some View {
        TimelineView(.periodic(from: .now, by: 1.0 / 30.0)) { context in
            let program = appState.haptics.programs["working"]
            let period = program?.durationMs ?? 2400
            let elapsed = context.date.timeIntervalSince(start) * 1000
            let phase = period > 0 ? (elapsed.truncatingRemainder(dividingBy: period)) / period : 0
            let intensity = program?.tracks.first?.intensity(at: phase) ?? 0.2

            HStack(spacing: ZodeTokens.Metrics.space3) {
                MetroWorkingIndicator(
                    phase: intensity,
                    color: palette.accent,
                    inactive: palette.surfaceAlt
                )
                Text("WORKING")
                    .font(MetroFont.micro())
                    .tracking(ZodeTokens.Tracking.trackingLabel)
                    .foregroundStyle(palette.textMuted)
            }
        }
    }

    // MARK: - Attachments

    private var attachments: some View {
        VStack(alignment: .leading, spacing: ZodeTokens.Metrics.space2) {
            MetroSectionHeader("Attachments")
            ForEach(appState.attachments) { attachment in
                HStack(spacing: ZodeTokens.Metrics.space3) {
                    Rectangle()
                        .fill(palette.accent)
                        .frame(width: 6, height: 28)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(attachment.name)
                            .font(MetroFont.body())
                            .foregroundStyle(palette.text)
                            .lineLimit(1)
                        Text("\(attachment.source.rawValue.uppercased()) — \(attachment.sizeLabel)")
                            .font(MetroFont.micro())
                            .tracking(ZodeTokens.Tracking.trackingLabel)
                            .foregroundStyle(palette.textMuted)
                    }
                    Spacer(minLength: 0)
                }
                .padding(.vertical, ZodeTokens.Metrics.space2)
            }
        }
    }

    // MARK: - Composer

    private var composer: some View {
        HStack(spacing: ZodeTokens.Metrics.space2) {
            TextField("Ask the agent", text: $draft)
                .font(MetroFont.body())
                .foregroundStyle(palette.text)
                .textInputAutocapitalization(.sentences)
                .submitLabel(.send)
                .onSubmit { send() }

            Button {
                send()
            } label: {
                Image(systemName: "arrow.up")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(palette.onAccent)
                    .frame(width: 44, height: 44)
                    .background(draft.isEmpty ? palette.surfaceAlt : palette.accent)
                    .clipShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .padding(.horizontal, ZodeTokens.Metrics.space3)
        .padding(.vertical, ZodeTokens.Metrics.space3)
        .background(palette.surface)
    }

    private func send() {
        let prompt = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty else { return }
        draft = ""
        appState.startTask(prompt: prompt)
    }
}
