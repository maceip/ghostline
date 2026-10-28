//
//  ZodeApp.kt
//  ZodeMobile (Android)
//
//  The single store the whole app reads from: library, agent, haptics,
//  playback, attachments, theme and the capability report from contract §2.
//
//  It also implements the intent surface from contract §4 -- the *same*
//  intent names the web app and the desktop shells use.
//

package com.zode.app

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.zode.app.data.AgentEngine
import com.zode.app.data.AgentEvent
import com.zode.app.data.Attachment
import com.zode.app.data.Library
import com.zode.app.data.PlayableItem
import com.zode.app.data.PlaybackState
import com.zode.app.data.SearchResult
import com.zode.app.data.ZodeIntents
import com.zode.app.design.AppTheme
import com.zode.app.haptics.HapticEngine
import com.zode.app.intents.IntentRouter
import com.zode.app.intents.NotificationSupport
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/** The capability report from contract §2. */
data class Capabilities(
    val haptics: Boolean,
    val attachments: Boolean,
    val notifications: Boolean,
    val intents: Boolean,
    val journal: Boolean,
    val search: Boolean,
    val windowControl: Boolean
) {
    companion object {
        /** Phones: no window chrome, and no system journal API. */
        fun android(haptics: Boolean, notifications: Boolean) = Capabilities(
            haptics = haptics,
            attachments = true,
            notifications = notifications,
            intents = true,
            // Android has no system "journal" API; the app keeps a local log.
            journal = false,
            search = true,
            windowControl = false
        )
    }
}

class ZodeAppState(
    context: Context,
    val scope: CoroutineScope,
    val library: Library = Library.seeded(context),
    val haptics: HapticEngine = HapticEngine(context.applicationContext),
    val notifications: NotificationSupport = NotificationSupport(context.applicationContext)
) {
    val agent = AgentEngine(scope)
    val router = IntentRouter()

    var theme by mutableStateOf(AppTheme.INK)
        private set
    var playback by mutableStateOf(PlaybackState())
        private set
    var attachments by mutableStateOf<List<Attachment>>(emptyList())
        private set
    var searchQuery by mutableStateOf("")
        private set
    var searchResults by mutableStateOf<List<SearchResult>>(emptyList())
        private set
    var queue by mutableStateOf<List<String>>(emptyList())
        private set
    var banner by mutableStateOf<String?>(null)
        private set

    private var attachmentCounter = 0
    private var webEvaluator: ((String) -> Unit)? = null

    fun attachWebEvaluator(evaluator: ((String) -> Unit)?) {
        webEvaluator = evaluator
    }

    fun emitWebEvent(event: String, payloadJson: String) {
        val script = "window.__zodeNative__ && window.__zodeNative__({\"type\":\"event\",\"event\":\"$event\",\"payload\":$payloadJson});"
        webEvaluator?.invoke(script)
    }

    val capabilities: Capabilities
        get() = Capabilities.android(
            haptics = haptics.supportsHaptics,
            notifications = notifications.isAuthorized
        )

    init {
        // The agent drives the haptics: `working` on start, `done` on success,
        // `error` on failure. These are the same triggers the web app uses.
        agent.onEvent { event -> handleAgentEvent(event) }

        startTicker()

        // A first task so the Agent view is never empty on launch.
        agent.start("Build a late-night set from the library")
    }

    // ------------------------------------------------------------------
    // Theme

    fun toggleTheme() {
        theme = if (theme == AppTheme.INK) AppTheme.PAPER else AppTheme.INK
        haptics.play("select")
    }

    // ------------------------------------------------------------------
    // Playback

    fun play(item: PlayableItem) {
        val tracks = library.tracksOf(item)
        if (tracks.isEmpty()) return
        queue = tracks.map { it.id }
        playback = PlaybackState(currentTrackID = tracks.first().id, isPlaying = true, elapsed = 0.0)
        haptics.play("select")
    }

    fun playTrack(trackID: String) {
        val track = library.track(trackID) ?: return
        val index = queue.indexOf(trackID)
        queue = if (index > 0) queue.subList(index, queue.size) else library.tracksInAlbum(track.albumID).map { it.id }
        playback = PlaybackState(currentTrackID = trackID, isPlaying = true, elapsed = 0.0)
        haptics.play("select")
    }

    fun togglePlayback() {
        playback = playback.copy(isPlaying = !playback.isPlaying)
        haptics.play("select")
    }

    fun next() {
        if (queue.isEmpty()) return
        val index = queue.indexOf(playback.currentTrackID)
        if (index < 0) return
        val nextIndex = (index + 1) % queue.size
        playback = playback.copy(
            currentTrackID = queue[nextIndex],
            elapsed = 0.0,
            isPlaying = true
        )
        haptics.play("tick")
    }

    fun previous() {
        if (queue.isEmpty()) return
        val index = queue.indexOf(playback.currentTrackID)
        if (index < 0) return
        val previousIndex = (index - 1 + queue.size) % queue.size
        playback = playback.copy(
            currentTrackID = queue[previousIndex],
            elapsed = 0.0,
            isPlaying = true
        )
        haptics.play("tick")
    }

    /** Called by the scrubber. `tick` fires on every change, as in the web app. */
    fun scrub(fraction: Float) {
        val track = currentTrack ?: return
        val clamped = fraction.coerceIn(0f, 1f).toDouble()
        playback = playback.copy(elapsed = clamped * track.durationSeconds)
        haptics.play("tick")
    }

    val currentTrack get() = playback.currentTrackID?.let { library.track(it) }
    val currentAlbum get() = currentTrack?.let { library.album(it.albumID) }
    val currentArtist get() = currentTrack?.let { library.artist(it.artistID) }

    private fun startTicker() {
        scope.launch {
            while (isActive) {
                delay(1000)
                val track = currentTrack ?: continue
                if (!playback.isPlaying) continue
                val next = playback.elapsed + 1
                if (next >= track.durationSeconds) {
                    next()
                } else {
                    playback = playback.copy(elapsed = next)
                }
            }
        }
    }

    // ------------------------------------------------------------------
    // Navigation

    fun show(view: com.zode.app.data.AppView) {
        if (router.view == view) return
        router.view = view
        haptics.play("open")
    }

    // ------------------------------------------------------------------
    // Search

    fun updateSearch(query: String) {
        searchQuery = query
        searchResults = search(query)
    }

    /** Contract §2 -- `search(query)`. */
    fun search(query: String): List<SearchResult> {
        val needle = query.trim().lowercase()
        if (needle.isEmpty()) return emptyList()

        val results = library.search(query).toMutableList()

        agent.tasks.value.forEach { task ->
            if (task.prompt.lowercase().contains(needle)) {
                results += SearchResult(
                    id = task.id,
                    title = task.prompt,
                    subtitle = task.state.json.replaceFirstChar { it.uppercase() },
                    kind = SearchResult.Kind.TASK,
                    payload = mapOf("id" to task.id, "kind" to "task")
                )
            }
        }

        attachments.forEach { attachment ->
            if (attachment.name.lowercase().contains(needle)) {
                results += SearchResult(
                    id = attachment.id,
                    title = attachment.name,
                    subtitle = attachment.sizeLabel,
                    kind = SearchResult.Kind.FILE,
                    payload = mapOf("id" to attachment.id, "kind" to "file")
                )
            }
        }

        if (needle.contains("play")) {
            library.albums.take(3).forEach { album ->
                results += SearchResult(
                    id = "action-play-${album.id}",
                    title = "Play ${album.title}",
                    subtitle = "Action",
                    kind = SearchResult.Kind.ACTION,
                    payload = mapOf("id" to album.id, "kind" to "album", "action" to "play")
                )
            }
        }

        return results
    }

    /** The results grouped by kind, in the contract's order. */
    val groupedSearchResults: List<Pair<SearchResult.Kind, List<SearchResult>>>
        get() = SearchResult.Kind.ordered.mapNotNull { kind ->
            val matches = searchResults.filter { it.kind == kind }
            if (matches.isEmpty()) null else kind to matches
        }

    // ------------------------------------------------------------------
    // Attachments

    /** Contract §8 -- an attachment arrived. */
    fun receive(attachment: Attachment) {
        attachments = listOf(attachment) + attachments
        agent.attach(attachment)
        haptics.play("attach")
        banner = "Received ${attachment.name}"
        val safeName = attachment.name.replace("\"", "\\\"")
        emitWebEvent("attachment", "{\"id\":\"${attachment.id}\",\"name\":\"$safeName\",\"source\":\"${attachment.source.json}\"}")
    }

    /** Contract §8 -- a file was dropped onto the app. */
    fun receiveDrop(attachment: Attachment) {
        attachments = listOf(attachment) + attachments
        agent.attach(attachment)
        haptics.play("drop")
        banner = "Dropped ${attachment.name}"
    }

    fun makeAttachment(
        name: String,
        path: String,
        mimeType: String,
        size: Long,
        source: Attachment.Source
    ): Attachment {
        attachmentCounter += 1
        return Attachment(
            id = "att-%02d".format(attachmentCounter),
            name = name,
            path = path,
            mimeType = mimeType,
            size = size,
            source = source
        )
    }

    // ------------------------------------------------------------------
    // Agent

    fun startTask(prompt: String, attachments: List<Attachment> = emptyList()) {
        agent.start(prompt, attachments)
    }

    fun stopTask() {
        agent.stop()
    }

    private fun handleAgentEvent(event: AgentEvent) {
        when (event) {
            is AgentEvent.Started -> haptics.play("working", loop = true)
            is AgentEvent.Progress -> Unit
            is AgentEvent.Completed -> {
                haptics.stop("working")
                haptics.play("done")
                notifications.post("Zode", "The agent finished your task.")
            }
            is AgentEvent.Failed -> {
                haptics.stop("working")
                haptics.play("error")
                notifications.post("Zode", "The agent could not finish that task.")
            }
            is AgentEvent.Stopped -> {
                haptics.stop("working")
                haptics.play("close")
            }
        }
    }

    // ------------------------------------------------------------------
    // Intents (contract §4)

    /**
     * Runs a named intent. This is the same surface the deep link router, the
     * search intents and the share sheet call.
     */
    fun performIntent(intent: String, payload: Map<String, String> = emptyMap()):
        com.zode.app.data.IntentResult = when (intent) {
        ZodeIntents.SEARCH -> {
            val query = payload["query"] ?: ""
            show(com.zode.app.data.AppView.SEARCH)
            updateSearch(query)
            com.zode.app.data.IntentResult.success(query)
        }

        ZodeIntents.PLAY -> {
            val id = payload["id"] ?: ""
            val kind = payload["kind"] ?: "track"
            val item = PlayableItem.parse(kind, id)
            if (item == null) {
                com.zode.app.data.IntentResult.failure("Unknown item kind '$kind'")
            } else {
                play(item)
                show(com.zode.app.data.AppView.NOW_PLAYING)
                com.zode.app.data.IntentResult.success(id)
            }
        }

        ZodeIntents.PAUSE -> {
            playback = playback.copy(isPlaying = false)
            haptics.play("select")
            com.zode.app.data.IntentResult.success(null)
        }

        ZodeIntents.NEXT -> {
            next()
            com.zode.app.data.IntentResult.success(playback.currentTrackID)
        }

        ZodeIntents.PREVIOUS -> {
            previous()
            com.zode.app.data.IntentResult.success(playback.currentTrackID)
        }

        ZodeIntents.AGENT_NEW_TASK -> {
            val prompt = payload["prompt"] ?: ""
            show(com.zode.app.data.AppView.AGENT)
            startTask(prompt)
            com.zode.app.data.IntentResult.success(prompt)
        }

        ZodeIntents.AGENT_STOP -> {
            stopTask()
            com.zode.app.data.IntentResult.success(null)
        }

        ZodeIntents.ATTACH -> {
            val attachment = makeAttachment(
                name = payload["name"] ?: "Attachment",
                path = payload["path"] ?: "",
                mimeType = payload["mimeType"] ?: "application/octet-stream",
                size = payload["size"]?.toLongOrNull() ?: 0L,
                source = Attachment.Source.INTENT
            )
            receive(attachment)
            com.zode.app.data.IntentResult.success(attachment.id)
        }

        ZodeIntents.SHOW -> {
            val raw = payload["view"] ?: com.zode.app.data.AppView.NOW_PLAYING.raw
            val view = com.zode.app.data.AppView.from(raw)
            if (view == null) {
                com.zode.app.data.IntentResult.failure("Unknown view '$raw'")
            } else {
                show(view)
                com.zode.app.data.IntentResult.success(raw)
            }
        }

        else -> com.zode.app.data.IntentResult.failure("Unsupported intent '$intent'")
    }
}

/** The root composable. */
@Composable
fun ZodeApp(state: ZodeAppState) {
    com.zode.app.ui.ZodeWebViewHost(state)
}
