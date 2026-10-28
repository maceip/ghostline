//
//  AgentEngine.swift
//  ZodeMobile
//
//  A fake agent task engine, mirroring the web app's `src/data/agent.js`:
//
//    start(prompt, attachments)  ->  task:start
//                                   task:progress (x4)
//                                   task:done | task:error
//    stop()                      ->  task:stopped
//
//  The timing is deterministic so the UI (and the haptics) behave the same on
//  every platform: the working haptic starts with the task, `done` fires on
//  success, `error` on failure. The engine itself is platform free -- the
//  haptic triggers live in `App/AppState.swift`.
//

import Combine
import Foundation

@MainActor
public final class AgentEngine: ObservableObject {
    /// The deterministic script of a task.
    public struct Step: Sendable {
        public let fraction: Double
        public let message: String
        public let delayMs: Int
    }

    public enum Event: Sendable {
        case started(taskID: String)
        case progress(taskID: String, fraction: Double, message: String)
        case completed(taskID: String, summary: String)
        case failed(taskID: String, message: String)
        case stopped(taskID: String)
    }

    /// The steps every task walks through.
    public static let steps: [Step] = [
        Step(fraction: 0.15, message: "Reading the library", delayMs: 300),
        Step(fraction: 0.40, message: "Building a plan", delayMs: 400),
        Step(fraction: 0.65, message: "Selecting tracks", delayMs: 400),
        Step(fraction: 0.85, message: "Shaping the playlist", delayMs: 400),
    ]

    /// How long a task takes to finish after the last step.
    public static let completionDelayMs = 400

    /// A task whose prompt contains this word fails, so the error path can be
    /// exercised deterministically.
    public static let failureKeyword = "fail"

    @Published public private(set) var tasks: [AgentTask] = []
    @Published public private(set) var runningTaskID: String?

    private var handlers: [UUID: (Event) -> Void] = [:]
    private var runners: [String: Task<Void, Never>] = [:]
    private var counter = 0

    public init() {}

    // MARK: - Events

    /// Subscribes to engine events. The returned closure unsubscribes.
    @discardableResult
    public func onEvent(_ handler: @escaping (Event) -> Void) -> () -> Void {
        let token = UUID()
        handlers[token] = handler
        return { [weak self] in
            self?.handlers.removeValue(forKey: token)
        }
    }

    private func emit(_ event: Event) {
        for handler in handlers.values {
            handler(event)
        }
    }

    // MARK: - Lifecycle

    /// Starts a new task. Returns the created task.
    @discardableResult
    public func start(prompt: String, attachments: [Attachment] = []) -> AgentTask {
        counter += 1
        let taskID = String(format: "task-%02d", counter)
        let now = Date()

        var messages: [AgentMessage] = [
            AgentMessage(
                id: "\(taskID)-m0",
                role: .user,
                text: prompt,
                at: now
            )
        ]
        for (index, attachment) in attachments.enumerated() {
            messages.append(
                AgentMessage(
                    id: "\(taskID)-a\(index)",
                    role: .system,
                    text: "Attached \(attachment.name) (\(attachment.sizeLabel))",
                    at: now
                )
            )
        }

        let task = AgentTask(
            id: taskID,
            prompt: prompt,
            state: .running,
            progress: 0,
            messages: messages,
            attachments: attachments,
            startedAt: now
        )

        tasks.insert(task, at: 0)
        runningTaskID = taskID
        emit(.started(taskID: taskID))

        runners[taskID] = Task { @MainActor [weak self] in
            await self?.run(taskID: taskID, prompt: prompt)
        }

        return task
    }

    /// Stops the running task, if any.
    public func stop() {
        guard let taskID = runningTaskID else { return }
        runners[taskID]?.cancel()
        runners[taskID] = nil
        runningTaskID = nil
        update(taskID) { task in
            task.state = .stopped
            task.progress = 0
            task.finishedAt = Date()
            task.messages.append(
                AgentMessage(
                    id: "\(taskID)-stop",
                    role: .system,
                    text: "Task stopped",
                    at: Date()
                )
            )
        }
        emit(.stopped(taskID: taskID))
    }

    /// Adds an attachment to the running task (contract §8 — drop / share).
    public func attach(_ attachment: Attachment) {
        guard let taskID = runningTaskID else { return }
        update(taskID) { task in
            task.attachments.append(attachment)
            task.messages.append(
                AgentMessage(
                    id: "\(taskID)-att-\(attachment.id)",
                    role: .system,
                    text: "Attached \(attachment.name)",
                    at: Date()
                )
            )
        }
    }

    // MARK: - Internals

    private func run(taskID: String, prompt: String) async {
        let shouldFail = prompt.lowercased().contains(Self.failureKeyword)

        for (index, step) in Self.steps.enumerated() {
            if shouldFail && index == 1 {
                try? await Task.sleep(nanoseconds: UInt64(step.delayMs) * 1_000_000)
                guard !Task.isCancelled else { return }
                fail(taskID: taskID, message: "The agent could not complete that task")
                return
            }

            try? await Task.sleep(nanoseconds: UInt64(step.delayMs) * 1_000_000)
            guard !Task.isCancelled else { return }

            update(taskID) { task in
                task.progress = step.fraction
                task.messages.append(
                    AgentMessage(
                        id: "\(taskID)-s\(index)",
                        role: .agent,
                        text: step.message,
                        at: Date()
                    )
                )
            }
            emit(.progress(taskID: taskID, fraction: step.fraction, message: step.message))
        }

        try? await Task.sleep(nanoseconds: UInt64(Self.completionDelayMs) * 1_000_000)
        guard !Task.isCancelled else { return }

        update(taskID) { task in
            task.state = .done
            task.progress = 1
            task.finishedAt = Date()
            task.messages.append(
                AgentMessage(
                    id: "\(taskID)-done",
                    role: .agent,
                    text: "Done — 12 tracks queued",
                    at: Date()
                )
            )
        }
        runningTaskID = nil
        runners[taskID] = nil
        emit(.completed(taskID: taskID, summary: "Done — 12 tracks queued"))
    }

    private func fail(taskID: String, message: String) {
        update(taskID) { task in
            task.state = .failed
            task.finishedAt = Date()
            task.messages.append(
                AgentMessage(
                    id: "\(taskID)-err",
                    role: .agent,
                    text: message,
                    at: Date()
                )
            )
        }
        runningTaskID = nil
        runners[taskID] = nil
        emit(.failed(taskID: taskID, message: message))
    }

    private func update(_ taskID: String, _ mutate: (inout AgentTask) -> Void) {
        guard let index = tasks.firstIndex(where: { $0.id == taskID }) else { return }
        mutate(&tasks[index])
    }
}
