//
//  AgentEngine.kt
//  ZodeMobile (Android)
//
//  A fake agent task engine, mirroring the web app's `src/data/agent.js` and
//  the iOS app's `Data/AgentEngine.swift`:
//
//    start(prompt, attachments)  ->  task:start
//                                   task:progress (x4)
//                                   task:done | task:error
//    stop()                      ->  task:stopped
//
//  The timing is deterministic so the UI (and the haptics) behave the same on
//  every platform: the working haptic starts with the task, `done` fires on
//  success, `error` on failure. The engine itself is platform free -- the
//  haptic triggers live in `ZodeApp.kt`.
//

package com.zode.app.data

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/** Events emitted by the engine, mirroring the web app's task events. */
sealed class AgentEvent {
    data class Started(val taskID: String) : AgentEvent()
    data class Progress(val taskID: String, val fraction: Double, val message: String) : AgentEvent()
    data class Completed(val taskID: String, val summary: String) : AgentEvent()
    data class Failed(val taskID: String, val message: String) : AgentEvent()
    data class Stopped(val taskID: String) : AgentEvent()
}

class AgentEngine(private val scope: CoroutineScope) {

    /** The deterministic script of a task. */
    data class Step(val fraction: Double, val message: String, val delayMs: Long)

    companion object {
        /** The steps every task walks through. */
        val steps: List<Step> = listOf(
            Step(0.15, "Reading the library", 300),
            Step(0.40, "Building a plan", 400),
            Step(0.65, "Selecting tracks", 400),
            Step(0.85, "Shaping the playlist", 400)
        )

        /** How long a task takes to finish after the last step. */
        const val COMPLETION_DELAY_MS = 400L

        /** A task whose prompt contains this word fails. */
        const val FAILURE_KEYWORD = "fail"
    }

    private val _tasks = MutableStateFlow<List<AgentTask>>(emptyList())
    val tasks: StateFlow<List<AgentTask>> = _tasks.asStateFlow()

    private val _runningTaskID = MutableStateFlow<String?>(null)
    val runningTaskID: StateFlow<String?> = _runningTaskID.asStateFlow()

    private val listeners = mutableListOf<(AgentEvent) -> Unit>()
    private val runners = mutableMapOf<String, Job>()
    private var counter = 0

    /** Subscribes to engine events. The returned lambda unsubscribes. */
    fun onEvent(handler: (AgentEvent) -> Unit): () -> Unit {
        listeners += handler
        return { listeners -= handler }
    }

    private fun emit(event: AgentEvent) {
        listeners.toList().forEach { it(event) }
    }

    /** Starts a new task. */
    fun start(prompt: String, attachments: List<Attachment> = emptyList()): AgentTask {
        counter += 1
        val taskID = "task-%02d".format(counter)
        val now = System.currentTimeMillis()

        val messages = mutableListOf(
            AgentMessage("$taskID-m0", AgentMessage.Role.USER, prompt, now)
        )
        attachments.forEachIndexed { index, attachment ->
            messages += AgentMessage(
                "$taskID-a$index",
                AgentMessage.Role.SYSTEM,
                "Attached ${attachment.name} (${attachment.sizeLabel})",
                now
            )
        }

        val task = AgentTask(
            id = taskID,
            prompt = prompt,
            state = AgentTask.State.RUNNING,
            progress = 0.0,
            messages = messages,
            attachments = attachments,
            startedAt = now
        )

        _tasks.value = listOf(task) + _tasks.value
        _runningTaskID.value = taskID
        emit(AgentEvent.Started(taskID))

        runners[taskID] = scope.launch {
            run(taskID, prompt)
        }
        return task
    }

    /** Stops the running task, if any. */
    fun stop() {
        val taskID = _runningTaskID.value ?: return
        runners.remove(taskID)?.cancel()
        _runningTaskID.value = null
        update(taskID) { task ->
            task.copy(
                state = AgentTask.State.STOPPED,
                progress = 0.0,
                finishedAt = System.currentTimeMillis(),
                messages = task.messages + AgentMessage(
                    "$taskID-stop",
                    AgentMessage.Role.SYSTEM,
                    "Task stopped",
                    System.currentTimeMillis()
                )
            )
        }
        emit(AgentEvent.Stopped(taskID))
    }

    /** Adds an attachment to the running task (contract §8 -- drop / share). */
    fun attach(attachment: Attachment) {
        val taskID = _runningTaskID.value ?: return
        update(taskID) { task ->
            task.copy(
                attachments = task.attachments + attachment,
                messages = task.messages + AgentMessage(
                    "$taskID-att-${attachment.id}",
                    AgentMessage.Role.SYSTEM,
                    "Attached ${attachment.name}",
                    System.currentTimeMillis()
                )
            )
        }
    }

    private suspend fun run(taskID: String, prompt: String) {
        val shouldFail = prompt.lowercase().contains(FAILURE_KEYWORD)

        steps.forEachIndexed { index, step ->
            if (shouldFail && index == 1) {
                delay(step.delayMs)
                fail(taskID, "The agent could not complete that task")
                return
            }

            delay(step.delayMs)
            update(taskID) { task ->
                task.copy(
                    progress = step.fraction,
                    messages = task.messages + AgentMessage(
                        "$taskID-s$index",
                        AgentMessage.Role.AGENT,
                        step.message,
                        System.currentTimeMillis()
                    )
                )
            }
            emit(AgentEvent.Progress(taskID, step.fraction, step.message))
        }

        delay(COMPLETION_DELAY_MS)

        update(taskID) { task ->
            task.copy(
                state = AgentTask.State.DONE,
                progress = 1.0,
                finishedAt = System.currentTimeMillis(),
                messages = task.messages + AgentMessage(
                    "$taskID-done",
                    AgentMessage.Role.AGENT,
                    "Done — 12 tracks queued",
                    System.currentTimeMillis()
                )
            )
        }
        _runningTaskID.value = null
        runners.remove(taskID)
        emit(AgentEvent.Completed(taskID, "Done — 12 tracks queued"))
    }

    private fun fail(taskID: String, message: String) {
        update(taskID) { task ->
            task.copy(
                state = AgentTask.State.FAILED,
                finishedAt = System.currentTimeMillis(),
                messages = task.messages + AgentMessage(
                    "$taskID-err",
                    AgentMessage.Role.AGENT,
                    message,
                    System.currentTimeMillis()
                )
            )
        }
        _runningTaskID.value = null
        runners.remove(taskID)
        emit(AgentEvent.Failed(taskID, message))
    }

    private fun update(taskID: String, mutate: (AgentTask) -> AgentTask) {
        _tasks.value = _tasks.value.map { task ->
            if (task.id == taskID) mutate(task) else task
        }
    }
}
