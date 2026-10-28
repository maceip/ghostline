//
//  Agent.kt
//  ZodeMobile (Android)
//
//  The agent panel: a task list, a running-task state, a composer and a live
//  status region.
//
//  The "working" indicator pulses in time with the `working` haptic program
//  from `packages/shared/haptics.json` -- the same 2400 ms cycle and the same
//  intensity curve that drive the vibrator.
//

package com.zode.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.zode.app.ZodeAppState
import com.zode.app.data.AgentMessage
import com.zode.app.data.AgentTask
import com.zode.app.design.LocalMetroPalette
import com.zode.app.design.MetroLabel
import com.zode.app.design.MetroProgressBar
import com.zode.app.design.MetroType
import com.zode.app.design.MetroWorkingIndicator
import com.zode.app.design.ZodeTokens
import kotlinx.coroutines.delay

@Composable
fun AgentScreen(state: ZodeAppState) {
    val palette = LocalMetroPalette.current
    var draft by remember { mutableStateOf("") }
    val tasks by state.agent.tasks.collectAsState()

    Column(modifier = Modifier.fillMaxSize()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(
                    horizontal = ZodeTokens.Metrics.gutter,
                    vertical = ZodeTokens.Metrics.space4
                ),
            verticalAlignment = Alignment.CenterVertically
        ) {
            MetroLabel("Agent", color = palette.textMuted)
            Box(modifier = Modifier.weight(1f))
            val runningTaskID by state.agent.runningTaskID.collectAsState()
            if (runningTaskID != null) {
                Text(
                    text = "STOP",
                    color = palette.onAccent,
                    style = MetroType.micro,
                    modifier = Modifier
                        .clip(RoundedCornerShape(0.dp))
                        .background(palette.accent)
                        .padding(
                            horizontal = ZodeTokens.Metrics.space3,
                            vertical = ZodeTokens.Metrics.space2
                        )
                        .clickable { state.stopTask() }
                )
            }
        }

        LazyColumn(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth(),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(
                horizontal = ZodeTokens.Metrics.gutter,
                vertical = ZodeTokens.Metrics.space2
            ),
            verticalArrangement = Arrangement.spacedBy(ZodeTokens.Metrics.space6)
        ) {
            if (tasks.isEmpty()) {
                item {
                    Column(verticalArrangement = Arrangement.spacedBy(ZodeTokens.Metrics.space2)) {
                        MetroLabel("No tasks yet", color = palette.textMuted)
                        Text(
                            text = "Ask the agent to build a set, find a track or organise your library.",
                            color = palette.textMuted,
                            style = MetroType.body
                        )
                    }
                }
            } else {
                items(items = tasks, key = { it.id }) { task ->
                    TaskCard(state, task)
                }
            }

            if (state.attachments.isNotEmpty()) {
                item {
                    Column(verticalArrangement = Arrangement.spacedBy(ZodeTokens.Metrics.space2)) {
                        MetroLabel("Attachments", color = palette.textMuted)
                        state.attachments.forEach { attachment ->
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Box(
                                    modifier = Modifier
                                        .width(6.dp)
                                        .height(28.dp)
                                        .background(palette.accent)
                                )
                                Column(
                                    modifier = Modifier
                                        .weight(1f)
                                        .padding(start = ZodeTokens.Metrics.space3)
                                ) {
                                    Text(
                                        text = attachment.name,
                                        color = palette.text,
                                        style = MetroType.body,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis
                                    )
                                    Text(
                                        text = "${attachment.source.json.uppercase()} — ${attachment.sizeLabel}",
                                        color = palette.textMuted,
                                        style = MetroType.micro
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }

        Composer(state, draft) { draft = it }
    }
}

@Composable
private fun TaskCard(state: ZodeAppState, task: AgentTask) {
    val palette = LocalMetroPalette.current

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(0.dp))
            .background(palette.surface)
            .padding(ZodeTokens.Metrics.space4),
        verticalArrangement = Arrangement.spacedBy(ZodeTokens.Metrics.space3)
    ) {
        Row(verticalAlignment = Alignment.Top) {
            Text(
                text = task.prompt,
                color = palette.text,
                style = MetroType.subtitle,
                modifier = Modifier.weight(1f)
            )
            Text(
                text = task.state.json.uppercase(),
                color = statusColor(palette, task.state),
                style = MetroType.micro,
                modifier = Modifier.padding(start = ZodeTokens.Metrics.space3)
            )
        }

        if (task.isRunning) {
            MetroProgressBar(
                progress = task.progress.toFloat(),
                track = palette.surfaceAlt,
                fill = palette.accent,
                height = 6.dp
            )
            WorkingIndicator(state, task)
        }

        Column(verticalArrangement = Arrangement.spacedBy(ZodeTokens.Metrics.space2)) {
            task.messages.forEach { message ->
                MessageRow(message)
            }
        }
    }
}

@Composable
private fun MessageRow(message: AgentMessage) {
    val palette = LocalMetroPalette.current
    Row(verticalAlignment = Alignment.Top) {
        Box(
            modifier = Modifier
                .width(3.dp)
                .height(24.dp)
                .background(
                    when (message.role) {
                        AgentMessage.Role.USER -> palette.accent
                        AgentMessage.Role.AGENT -> palette.textMuted
                        AgentMessage.Role.SYSTEM -> palette.hairline
                    }
                )
        )
        Text(
            text = message.text,
            color = if (message.role == AgentMessage.Role.USER) palette.text else palette.textMuted,
            style = MetroType.body,
            modifier = Modifier
                .weight(1f)
                .padding(start = ZodeTokens.Metrics.space3)
        )
    }
}

/**
 * The pulse, driven by the shared `working` program: the same 2400 ms cycle
 * and the same intensity curve that drive the vibrator.
 */
@Composable
private fun WorkingIndicator(state: ZodeAppState, task: AgentTask) {
    val palette = LocalMetroPalette.current
    var phase by remember(task.id) { mutableStateOf(0.0) }

    LaunchedEffect(task.id) {
        val program = state.haptics.programs["working"]
        val period = (program?.durationMs ?: 2400.0).coerceAtLeast(1.0)
        while (true) {
            val elapsed = System.currentTimeMillis() - task.startedAt
            val time = ((elapsed % period.toLong()) / period).coerceIn(0.0, 1.0)
            phase = program?.tracks?.firstOrNull()?.intensityAt(time) ?: 0.2
            delay(33)
        }
    }

    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(ZodeTokens.Metrics.space3)
    ) {
        MetroWorkingIndicator(
            phase = phase,
            color = palette.accent,
            inactive = palette.surfaceAlt
        )
        Text(
            text = "WORKING",
            color = palette.textMuted,
            style = MetroType.micro
        )
    }
}

@Composable
private fun Composer(state: ZodeAppState, draft: String, onDraft: (String) -> Unit) {
    val palette = LocalMetroPalette.current

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(palette.surface)
            .padding(horizontal = ZodeTokens.Metrics.space3, vertical = ZodeTokens.Metrics.space3),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Box(modifier = Modifier.weight(1f)) {
            if (draft.isEmpty()) {
                Text(
                    text = "Ask the agent",
                    color = palette.textMuted,
                    style = MetroType.body
                )
            }
            BasicTextField(
                value = draft,
                onValueChange = onDraft,
                textStyle = MetroType.body.copy(color = palette.text),
                cursorBrush = SolidColor(palette.accent),
                modifier = Modifier.fillMaxWidth()
            )
        }
        Box(
            modifier = Modifier
                .padding(start = ZodeTokens.Metrics.space2)
                .width(44.dp)
                .height(44.dp)
                .clip(RoundedCornerShape(0.dp))
                .background(if (draft.isBlank()) palette.surfaceAlt else palette.accent)
                .clickable {
                    if (draft.isNotBlank()) {
                        state.startTask(draft.trim())
                        onDraft("")
                    }
                },
            contentAlignment = Alignment.Center
        ) {
            Text(
                text = "↑",
                color = if (draft.isBlank()) palette.textMuted else palette.onAccent,
                style = MetroType.subtitle
            )
        }
    }
}

private fun statusColor(palette: com.zode.app.design.MetroPalette, state: AgentTask.State): Color =
    when (state) {
        AgentTask.State.RUNNING -> palette.accent
        AgentTask.State.DONE -> com.zode.app.design.ZodeTokens.Colors.zodeAccentGreen
        AgentTask.State.FAILED -> com.zode.app.design.ZodeTokens.Colors.zodeAccentOrange
        AgentTask.State.STOPPED, AgentTask.State.PENDING -> palette.textMuted
    }
