//
//  IntentRouter.kt
//  ZodeMobile (Android)
//
//  Translates outside-the-app events -- `zode://` deep links, `ACTION_SEARCH`
//  queries, share-sheet attachments -- into the canonical intent names from
//  contract §4.
//
//  The names are exactly the ones the web app and the desktop shells use:
//      zode.search, zode.play, zode.pause, zode.next, zode.previous,
//      zode.agent.newTask, zode.agent.stop, zode.attach, zode.show
//

package com.zode.app.intents

import android.net.Uri
import com.zode.app.ZodeAppState
import com.zode.app.data.AppView
import com.zode.app.data.PlayableItem
import com.zode.app.data.ZodeIntents

class IntentRouter {

    /** The current view. */
    var view: AppView = AppView.NOW_PLAYING

    /** A search query pushed from outside the app. */
    var incomingSearch: String? = null

    /** A play request pushed from outside the app. */
    var incomingPlay: PlayableItem? = null

    /** Every intent name this router understands. */
    val supportedIntents: List<String> = ZodeIntents.all

    /**
     * Handles a `zode://` URL.
     *
     * Supported shapes:
     *   zode://now-playing
     *   zode://collection
     *   zode://collection/album/<album-id>
     *   zode://library/track/<track-id>
     *   zode://search?q=neon
     *   zode://play/<kind>/<id>
     *   zode://agent
     */
    fun handle(url: Uri, state: ZodeAppState): Boolean {
        if (!url.scheme.equals("zode", ignoreCase = true)) return false

        val host = url.host?.lowercase() ?: ""
        val segments = url.pathSegments.filter { it.isNotEmpty() }
        val query = url.getQueryParameter("q")

        return when (host) {
            "view" -> {
                val raw = segments.firstOrNull() ?: return false
                state.performIntent(ZodeIntents.SHOW, mapOf("view" to raw)).let { it.ok }
            }

            "search" -> {
                state.performIntent(ZodeIntents.SEARCH, mapOf("query" to (query ?: ""))).let { it.ok }
            }

            "play" -> {
                if (segments.size < 2) return false
                state.performIntent(
                    ZodeIntents.PLAY,
                    mapOf("kind" to segments[0], "id" to segments[1])
                ).let { it.ok }
            }

            "pause" -> state.performIntent(ZodeIntents.PAUSE).let { it.ok }

            "next" -> state.performIntent(ZodeIntents.NEXT).let { it.ok }

            "previous" -> state.performIntent(ZodeIntents.PREVIOUS).let { it.ok }

            "agent" -> when (segments.firstOrNull()) {
                "new" -> state.performIntent(
                    ZodeIntents.AGENT_NEW_TASK,
                    mapOf("prompt" to (url.getQueryParameter("prompt") ?: ""))
                ).let { it.ok }
                "stop" -> state.performIntent(ZodeIntents.AGENT_STOP).let { it.ok }
                else -> state.performIntent(
                    ZodeIntents.SHOW,
                    mapOf("view" to AppView.AGENT.raw)
                ).let { it.ok }
            }

            "attach" -> state.performIntent(
                ZodeIntents.ATTACH,
                mapOf(
                    "name" to (url.getQueryParameter("name") ?: "Attachment"),
                    "path" to (url.getQueryParameter("path") ?: "")
                )
            ).let { it.ok }

            "collection", "library", "now-playing" -> {
                var payload = mapOf("view" to host)
                if (host == "collection" && segments.size >= 2 && segments[0] == "album") {
                    payload = payload + ("id" to segments[1])
                }
                state.performIntent(ZodeIntents.SHOW, payload).let { it.ok }
            }

            else -> {
                val view = AppView.from(host) ?: return false
                state.performIntent(ZodeIntents.SHOW, mapOf("view" to view.raw)).let { it.ok }
            }
        }
    }
}
