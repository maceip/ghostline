//
//  MainActivity.kt
//  ZodeMobile (Android)
//
//  The single activity. It owns the app state, renders the Compose tree and
//  turns outside-the-app intents into the canonical contract intents:
//
//    * `zode://...` deep links          -> `zode.show`, `zode.search`, ...
//    * `Intent.ACTION_SEARCH`           -> `zode.search`
//    * `Intent.ACTION_SEND` / VIEW     -> `zode.attach`
//

package com.zode.app

import android.app.SearchManager
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.lifecycle.lifecycleScope
import com.zode.app.data.Attachment
import com.zode.app.data.ZodeIntents
import com.zode.app.design.ZodeTheme
import com.zode.app.intents.SearchIndexer
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {

    private lateinit var state: ZodeAppState
    private lateinit var searchIndexer: SearchIndexer

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        state = ZodeAppState(this, lifecycleScope)
        searchIndexer = SearchIndexer(this)
        state.notifications.createChannel()
        searchIndexer.publishShortcut()

        setContent {
            ZodeTheme(state.theme) {
                ZodeApp(state)
            }
        }

        handleIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    /** Routes an incoming intent into the app. */
    private fun handleIntent(intent: Intent?) {
        intent ?: return

        // A `zode://` deep link.
        val data = intent.data
        if (data != null && data.scheme.equals("zode", ignoreCase = true)) {
            state.router.handle(data, state)
            val safeUrl = data.toString().replace("\"", "\\\"")
            state.emitWebEvent("deepLink", "{\"url\":\"$safeUrl\"}")
            return
        }

        when (intent.action) {
            Intent.ACTION_SEARCH -> {
                val query = intent.getStringExtra(SearchManager.QUERY).orEmpty()
                searchIndexer.recordQuery(query)
                state.performIntent(ZodeIntents.SEARCH, mapOf("query" to query))
                val safeQuery = query.replace("\"", "\\\"")
                state.emitWebEvent("search", "{\"query\":\"$safeQuery\"}")
            }

            Intent.ACTION_SEND -> {
                val stream = intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)
                val text = intent.getStringExtra(Intent.EXTRA_TEXT)
                val name = stream?.lastPathSegment
                    ?: text?.lineSequence()?.firstOrNull()
                    ?: "Attachment"
                val attachment = state.makeAttachment(
                    name = name,
                    path = stream?.toString() ?: "",
                    mimeType = intent.type ?: "application/octet-stream",
                    size = 0L,
                    source = Attachment.Source.SHARE
                )
                state.performIntent(
                    ZodeIntents.ATTACH,
                    mapOf(
                        "name" to attachment.name,
                        "path" to attachment.path,
                        "mimeType" to attachment.mimeType
                    )
                )
            }

            Intent.ACTION_VIEW -> {
                val data = intent.data ?: return
                val attachment = state.makeAttachment(
                    name = data.lastPathSegment ?: "Attachment",
                    path = data.toString(),
                    mimeType = intent.type ?: "application/octet-stream",
                    size = 0L,
                    source = Attachment.Source.SHARE
                )
                state.performIntent(
                    ZodeIntents.ATTACH,
                    mapOf(
                        "name" to attachment.name,
                        "path" to attachment.path,
                        "mimeType" to attachment.mimeType
                    )
                )
            }
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        state.haptics.stopAll()
    }
}
