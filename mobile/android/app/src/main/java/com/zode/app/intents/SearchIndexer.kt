//
//  SearchIndexer.kt
//  ZodeMobile (Android)
//
//  System search integration (contract §10).
//
//  * `res/xml/searchable.xml` describes the searchable activity, so the
//    system search box can offer Zode.
//  * `ZodeSearchProvider` answers the suggestion queries with the library.
//  * A static shortcut ("Search Zode") fires an `ACTION_SEARCH` intent.
//
//  The query that arrives through `ACTION_SEARCH` is turned into the
//  canonical `zode.search` intent.
//

package com.zode.app.intents

import android.app.SearchManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.ShortcutInfo
import android.content.pm.ShortcutManager
import android.graphics.drawable.Icon
import android.net.Uri
import android.os.Build
import android.provider.BaseColumns
import android.provider.SearchRecentSuggestions
import com.zode.app.R
import com.zode.app.data.Library
import com.zode.app.data.SearchResult

class SearchIndexer(private val context: Context) {

    companion object {
        /** The `SearchManager` authority of the suggestion provider. */
        const val AUTHORITY = "com.zode.app.search"

        /** The suggestion query path. */
        const val SUGGEST_PATH = "search_suggest_query"

        /**
         * The URI parameter the system passes the search text in.
         *
         * (`SearchManager.SUGGEST_QUERY_PARAMETER` was removed from the SDK.)
         */
        const val SUGGEST_QUERY_PARAMETER = "query"

        /** The shortcut id used for the static "Search Zode" shortcut. */
        const val SHORTCUT_ID = "zode-search"
    }

    /**
     * The searchable description of the app.
     *
     * `SearchableInfo` has no public constructor any more -- the only way to
     * get one is `SearchManager.getSearchableInfo(ComponentName)`, which
     * resolves the `res/xml/searchable.xml` of the given activity.
     */
    val searchableInfo: android.app.SearchableInfo? by lazy {
        try {
            val manager = context.getSystemService(Context.SEARCH_SERVICE) as? SearchManager
            manager?.getSearchableInfo(
                ComponentName(context, com.zode.app.MainActivity::class.java)
            )
        } catch (error: Exception) {
            null
        }
    }

    /**
     * Queries the app's own search index (contract §2 -- `search(query)`).
     */
    fun search(query: String): List<SearchResult> = Library.seeded(context).search(query)

    /** Records a query in the system's recent suggestions. */
    fun recordQuery(query: String) {
        try {
            SearchRecentSuggestions(
                context,
                SearchManager.APP_DATA,
                1
            ).saveRecentQuery(query, null)
        } catch (error: Exception) {
            // The suggestions provider is optional.
        }
    }

    /** Publishes the static "Search Zode" shortcut (Android 7.1+). */
    fun publishShortcut() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N_MR1) return
        try {
            // `SearchManager.ACTION_SEARCH` was removed from the SDK; the
            // search intent action lives on `Intent`.
            val intent = Intent(Intent.ACTION_SEARCH).apply {
                putExtra(SearchManager.QUERY, "")
                component = ComponentName(context, com.zode.app.MainActivity::class.java)
            }
            val shortcut = ShortcutInfo.Builder(context, SHORTCUT_ID)
                .setShortLabel("Search Zode")
                .setLongLabel("Search the Zode library")
                .setIcon(Icon.createWithResource(context, R.mipmap.ic_launcher))
                .setIntent(intent)
                .build()
            val manager = context.getSystemService(Context.SHORTCUT_SERVICE) as? ShortcutManager
            manager?.dynamicShortcuts = listOf(shortcut)
        } catch (error: Exception) {
            // Shortcuts are a nice-to-have.
        }
    }
}

/**
 * The suggestion provider. It answers the system's search suggestions with
 * the library's tracks, albums, artists and playlists.
 */
class ZodeSearchProvider : android.content.ContentProvider() {

    private val library: Library by lazy {
        // `ContentProvider.getContext()` is nullable in principle.
        context?.let { Library.seeded(it) }
            ?: Library(emptyList(), emptyList(), emptyList(), emptyList())
    }

    override fun onCreate(): Boolean = true

    override fun query(
        uri: Uri,
        projection: Array<out String>?,
        selection: String?,
        selectionArgs: Array<out String>?,
        sortOrder: String?
    ): android.database.Cursor? {
        val query = selectionArgs?.firstOrNull()
            // `SearchManager.SUGGEST_QUERY_PARAMETER` was removed from the SDK.
            // The suggestion provider receives the text as the first selection
            // argument, and as the "query" URI parameter when it is not.
            ?: uri.getQueryParameter(SearchIndexer.SUGGEST_QUERY_PARAMETER)
            ?: return null

        val cursor = android.database.MatrixCursor(COLUMNS)
        library.search(query).take(20).forEach { result ->
            cursor.addRow(
                arrayOf(
                    result.id.hashCode(),
                    result.title,
                    result.subtitle ?: "",
                    result.id,
                    result.kind.json,
                    Intent.ACTION_SEARCH
                )
            )
        }
        return cursor
    }

    override fun getType(uri: Uri): String? = android.content.ContentResolver.CURSOR_DIR_BASE_TYPE

    override fun insert(uri: Uri, values: android.content.ContentValues?): Uri? = null

    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0

    override fun update(
        uri: Uri,
        values: android.content.ContentValues?,
        selection: String?,
        selectionArgs: Array<out String>?
    ): Int = 0

    companion object {
        val COLUMNS = arrayOf(
            BaseColumns._ID,
            SearchManager.SUGGEST_COLUMN_TEXT_1,
            SearchManager.SUGGEST_COLUMN_TEXT_2,
            SearchManager.SUGGEST_COLUMN_INTENT_DATA,
            SearchManager.SUGGEST_COLUMN_INTENT_EXTRA_DATA,
            SearchManager.SUGGEST_COLUMN_INTENT_ACTION
        )
    }
}
