//
//  ZodeWebViewHost.kt
//  ZodeMobile (Android)
//
//  Hosts the bundled Zune Code / Zune HD mobile web application (assets/web/)
//  inside the system WebView on the virtual origin https://app.zode.local/
//  and bridges Contract v1 envelopes via window.ZodeAndroid.postMessage.
//

package com.zode.app.ui

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color as ComposeColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import com.zode.app.ZodeAppState
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.File

private const val VIRTUAL_HOST = "app.zode.local"
private const val START_URL = "https://app.zode.local/index.html"

@SuppressLint("SetJavaScriptEnabled")
@Composable
fun ZodeWebViewHost(state: ZodeAppState) {
    val context = LocalContext.current
    val mainHandler = remember { Handler(Looper.getMainLooper()) }

    val webView = remember {
        WebView(context).apply {
            setBackgroundColor(Color.BLACK)
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                databaseEnabled = true
                mediaPlaybackRequiresUserGesture = false
                allowFileAccess = false
                allowContentAccess = false
                cacheMode = WebSettings.LOAD_DEFAULT
                mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            }
            webChromeClient = WebChromeClient()
            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(
                    view: WebView?,
                    request: WebResourceRequest?
                ): WebResourceResponse? {
                    val uri = request?.url ?: return null
                    if (!uri.host.equals(VIRTUAL_HOST, ignoreCase = true)) {
                        return super.shouldInterceptRequest(view, request)
                    }
                    var relPath = uri.path ?: "/index.html"
                    if (relPath.isEmpty() || relPath == "/") {
                        relPath = "/index.html"
                    }
                    val assetPath = "web/" + relPath.trimStart('/')
                    return try {
                        val stream = context.assets.open(assetPath)
                        val mime = mimeTypeFor(assetPath)
                        val headers = mapOf(
                            "Access-Control-Allow-Origin" to "*",
                            "Cache-Control" to "no-cache"
                        )
                        WebResourceResponse(mime, "UTF-8", 200, "OK", headers, stream)
                    } catch (_: Exception) {
                        val notFound = ByteArrayInputStream("Not Found".toByteArray())
                        WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", emptyMap(), notFound)
                    }
                }
            }
            addJavascriptInterface(
                ZodeAndroidBridge(context, state, mainHandler) { script ->
                    evaluateJavascript(script, null)
                },
                "ZodeAndroid"
            )
            loadUrl(START_URL)
        }
    }

    DisposableEffect(webView) {
        state.attachWebEvaluator { script ->
            mainHandler.post {
                webView.evaluateJavascript(script, null)
            }
        }
        onDispose {
            state.attachWebEvaluator(null)
            webView.destroy()
        }
    }

    BackHandler(enabled = true) {
        webView.evaluateJavascript(
            "window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));",
            null
        )
    }

    AndroidView(
        factory = { webView },
        modifier = Modifier
            .fillMaxSize()
            .background(ComposeColor.Black)
    )
}

private class ZodeAndroidBridge(
    private val context: Context,
    private val state: ZodeAppState,
    private val mainHandler: Handler,
    private val evaluate: (String) -> Unit
) {
    @JavascriptInterface
    fun postMessage(rawJson: String) {
        mainHandler.post {
            handleEnvelope(rawJson)
        }
    }

    private fun handleEnvelope(rawJson: String) {
        val obj = try {
            JSONObject(rawJson)
        } catch (_: Exception) {
            return
        }
        val id = obj.optString("id", "")
        val type = obj.optString("type", "")
        val payload = obj.optJSONObject("payload") ?: JSONObject()
        if (id.isEmpty() || type.isEmpty()) return

        try {
            val result = dispatch(type, payload)
            replySuccess(id, result)
        } catch (err: BridgeDispatchException) {
            replyError(id, err.code, err.message ?: "Bridge error")
        } catch (err: Exception) {
            replyError(id, "internal", err.message ?: "Internal error")
        }
    }

    private fun dispatch(type: String, payload: JSONObject): JSONObject {
        return when (type) {
            "haptic.play" -> {
                val program = payload.optString("program", "")
                if (program.isEmpty()) throw BridgeDispatchException("invalid", "program is required")
                val loop = payload.optBoolean("loop", false)
                state.haptics.play(program, loop)
                JSONObject()
            }
            "haptic.stop" -> {
                val program = payload.optString("program", "")
                if (program.isEmpty()) throw BridgeDispatchException("invalid", "program is required")
                state.haptics.stop(program)
                JSONObject()
            }
            "notify.post" -> {
                val title = payload.optString("title", "Zode")
                val body = payload.optString("body", "")
                val notifyId = payload.optString("id", "").ifEmpty { null }
                state.notifications.post(title, body, notifyId)
                JSONObject()
            }
            "intent.perform" -> {
                val intent = payload.optString("intent", "")
                val intentPayloadObj = payload.optJSONObject("payload") ?: JSONObject()
                val map = mutableMapOf<String, String>()
                val keys = intentPayloadObj.keys()
                while (keys.hasNext()) {
                    val k = keys.next()
                    map[k] = intentPayloadObj.optString(k, "")
                }
                val res = state.performIntent(intent, map)
                JSONObject().apply {
                    put("ok", res.ok)
                    if (res.value != null) put("value", res.value)
                    if (res.message != null) put("message", res.message)
                }
            }
            "search.query" -> {
                val query = payload.optString("query", "")
                val hits = state.search(query)
                val arr = JSONArray()
                for (hit in hits) {
                    arr.put(
                        JSONObject().apply {
                            put("id", hit.id)
                            put("title", hit.title)
                            put("subtitle", hit.subtitle)
                            put("kind", hit.kind.json)
                        }
                    )
                }
                JSONObject().apply {
                    put("results", arr)
                }
            }
            "journal.write" -> {
                val entry = JSONObject().apply {
                    put("title", payload.optString("title", ""))
                    put("body", payload.optString("body", ""))
                    put("date", payload.optString("date", ""))
                }
                val file = File(context.filesDir, "journal.jsonl")
                file.appendText(entry.toString() + "\n")
                JSONObject()
            }
            "app.info" -> {
                val caps = state.capabilities
                JSONObject().apply {
                    put("version", 1)
                    put("build", "android")
                    put("platform", "android")
                    put("deviceModel", Build.MODEL ?: "android")
                    put(
                        "capabilities",
                        JSONObject().apply {
                            put("haptics", caps.haptics)
                            put("attachments", caps.attachments)
                            put("notifications", caps.notifications)
                            put("intents", caps.intents)
                            put("journal", caps.journal)
                            put("search", caps.search)
                            put("windowControl", caps.windowControl)
                        }
                    )
                }
            }
            "attach.pick" -> {
                val arr = JSONArray()
                for (att in state.attachments) {
                    arr.put(
                        JSONObject().apply {
                            put("id", att.id)
                            put("name", att.name)
                            put("path", att.path)
                            put("mimeType", att.mimeType)
                            put("size", att.size)
                            put("source", att.source.json)
                        }
                    )
                }
                JSONObject().apply {
                    put("attachments", arr)
                }
            }
            "window.dragStart", "window.toggleFill", "window.setFullScreen", "window.isFullScreen" -> {
                JSONObject().apply {
                    put("filling", false)
                    put("fullScreen", false)
                }
            }
            else -> throw BridgeDispatchException("unsupported", "Unsupported request: $type")
        }
    }

    private fun replySuccess(id: String, result: JSONObject) {
        val envelope = JSONObject().apply {
            put("id", id)
            put("ok", true)
            put("result", result)
        }
        evaluate("window.__zodeNative__ && window.__zodeNative__($envelope);")
    }

    private fun replyError(id: String, code: String, message: String) {
        val envelope = JSONObject().apply {
            put("id", id)
            put("ok", false)
            put(
                "error",
                JSONObject().apply {
                    put("code", code)
                    put("message", message)
                }
            )
        }
        evaluate("window.__zodeNative__ && window.__zodeNative__($envelope);")
    }
}

private class BridgeDispatchException(val code: String, message: String) : Exception(message)

private fun mimeTypeFor(path: String): String {
    val ext = path.substringAfterLast('.', "").lowercase()
    return when (ext) {
        "html", "htm" -> "text/html"
        "js", "mjs" -> "text/javascript"
        "css" -> "text/css"
        "json" -> "application/json"
        "svg" -> "image/svg+xml"
        "png" -> "image/png"
        "ico" -> "image/x-icon"
        "woff2" -> "font/woff2"
        "woff" -> "font/woff"
        "ttf" -> "font/ttf"
        "wasm" -> "application/wasm"
        else -> "application/octet-stream"
    }
}
