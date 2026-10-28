//
//  Model.kt
//  ZodeMobile (Android)
//
//  The data model shared by the Android app, the iOS app and the web app.
//  Shapes mirror contract §2.1 (`Attachment`, `IntentResult`, `SearchResult`)
//  and the library entities seeded by `Library.kt`.
//

package com.zode.app.data

/** A performing artist. */
data class Artist(
    val id: String,
    val name: String,
    val genre: String,
    val albumIDs: List<String>
)

/** An album. [accent] drives the flat Metro tile colour. */
data class Album(
    val id: String,
    val title: String,
    val artistID: String,
    val year: Int,
    val genre: String,
    val trackIDs: List<String>,
    val accent: Long
)

/** A single track. */
data class Track(
    val id: String,
    val title: String,
    val artistID: String,
    val albumID: String,
    val durationSeconds: Int,
    val trackNumber: Int,
    val year: Int,
    val genre: String
) {
    /** `m:ss` -- the format used by the Library and Now Playing views. */
    val durationLabel: String
        get() = "%d:%02d".format(durationSeconds / 60, durationSeconds % 60)
}

/** A user-curated playlist. */
data class Playlist(
    val id: String,
    val title: String,
    val subtitle: String,
    val trackIDs: List<String>
)

/**
 * A file handed to the app. Matches the contract's `Attachment` shape.
 */
data class Attachment(
    val id: String,
    val name: String,
    val path: String,
    val mimeType: String,
    val size: Long,
    val source: Source
) {
    enum class Source(val json: String) {
        DOCK("dock"),
        DROP("drop"),
        PICKER("picker"),
        SHARE("share"),
        INTENT("intent");

        companion object {
            fun from(value: String): Source =
                entries.firstOrNull { it.json == value } ?: INTENT
        }
    }

    /** Best-effort size label, e.g. `1.2 MB`. */
    val sizeLabel: String
        get() = when {
            size < 1024 -> "$size B"
            size < 1024 * 1024 -> "%.0f KB".format(size / 1024.0)
            else -> "%.1f MB".format(size / (1024.0 * 1024.0))
        }
}

/** One message inside an agent task's transcript. */
data class AgentMessage(
    val id: String,
    val role: Role,
    val text: String,
    val at: Long
) {
    enum class Role(val json: String) {
        USER("user"),
        AGENT("agent"),
        SYSTEM("system");

        companion object {
            fun from(value: String): Role =
                entries.firstOrNull { it.json == value } ?: AGENT
        }
    }
}

/** An agent task, mirroring the web app's task lifecycle. */
data class AgentTask(
    val id: String,
    val prompt: String,
    val state: State = State.PENDING,
    val progress: Double = 0.0,
    val messages: List<AgentMessage> = emptyList(),
    val attachments: List<Attachment> = emptyList(),
    val startedAt: Long = System.currentTimeMillis(),
    val finishedAt: Long? = null
) {
    enum class State(val json: String) {
        PENDING("pending"),
        RUNNING("running"),
        DONE("done"),
        FAILED("failed"),
        STOPPED("stopped");

        companion object {
            fun from(value: String): State =
                entries.firstOrNull { it.json == value } ?: PENDING
        }
    }

    val isRunning: Boolean get() = state == State.RUNNING
}

/**
 * One search hit. The [kind] values match contract §2.1 exactly.
 */
data class SearchResult(
    val id: String,
    val title: String,
    val subtitle: String? = null,
    val kind: Kind,
    val payload: Map<String, String> = emptyMap()
) {
    enum class Kind(val json: String) {
        TRACK("track"),
        ALBUM("album"),
        ARTIST("artist"),
        PLAYLIST("playlist"),
        TASK("task"),
        FILE("file"),
        ACTION("action");

        companion object {
            fun from(value: String): Kind =
                entries.firstOrNull { it.json == value } ?: TRACK

            /** The order results are grouped in. */
            val ordered: List<Kind> = entries.toList()
        }
    }
}

/** The result of running an intent. Matches the contract's `IntentResult`. */
data class IntentResult(
    val ok: Boolean,
    val value: String? = null,
    val message: String? = null
) {
    companion object {
        fun success(value: String? = null) = IntentResult(true, value, null)
        fun failure(message: String) = IntentResult(false, null, message)
    }
}

/**
 * The canonical intent names from contract §4. Every platform uses these
 * exact strings.
 */
object ZodeIntents {
    const val SEARCH = "zode.search"
    const val PLAY = "zode.play"
    const val PAUSE = "zode.pause"
    const val NEXT = "zode.next"
    const val PREVIOUS = "zode.previous"
    const val AGENT_NEW_TASK = "zode.agent.newTask"
    const val AGENT_STOP = "zode.agent.stop"
    const val ATTACH = "zode.attach"
    const val SHOW = "zode.show"

    /** Every intent name, in contract order. */
    val all: List<String> = listOf(
        SEARCH, PLAY, PAUSE, NEXT, PREVIOUS, AGENT_NEW_TASK, AGENT_STOP, ATTACH, SHOW
    )

    /** The `view` values accepted by `zode.show`. */
    val views: List<String> = listOf("now-playing", "collection", "library", "search", "agent")
}

/** The payload of an intent invocation. */
data class IntentPayload(
    val intent: String,
    val values: Map<String, String> = emptyMap()
) {
    fun string(key: String): String? = values[key]
}

/** The five views. The values match the `zode.show` payload in contract §4. */
enum class AppView(val raw: String) {
    NOW_PLAYING("now-playing"),
    COLLECTION("collection"),
    LIBRARY("library"),
    SEARCH("search"),
    AGENT("agent");

    /** The uppercase tracked label used in the Metro rail. */
    val label: String
        get() = when (this) {
            NOW_PLAYING -> "NOW"
            COLLECTION -> "COLLECTION"
            LIBRARY -> "LIBRARY"
            SEARCH -> "SEARCH"
            AGENT -> "AGENT"
        }

    companion object {
        fun from(raw: String?): AppView? = entries.firstOrNull { it.raw == raw }
    }
}

/** A thing that can be played. */
sealed class PlayableItem {
    abstract val kind: String
    abstract val id: String

    data class TrackItem(override val id: String) : PlayableItem() {
        override val kind: String get() = "track"
    }

    data class AlbumItem(override val id: String) : PlayableItem() {
        override val kind: String get() = "album"
    }

    data class ArtistItem(override val id: String) : PlayableItem() {
        override val kind: String get() = "artist"
    }

    data class PlaylistItem(override val id: String) : PlayableItem() {
        override val kind: String get() = "playlist"
    }

    companion object {
        /** Parses the `kind`/`id` pair carried by `zode.play`. */
        fun parse(kind: String, id: String): PlayableItem? = when (kind) {
            "track" -> TrackItem(id)
            "album" -> AlbumItem(id)
            "artist" -> ArtistItem(id)
            "playlist" -> PlaylistItem(id)
            else -> null
        }
    }
}

/** The transport state shared by the Now Playing view and the intents. */
data class PlaybackState(
    val currentTrackID: String? = null,
    val isPlaying: Boolean = false,
    val elapsed: Double = 0.0
)
