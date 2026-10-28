//
//  Theme.kt
//  ZodeMobile (Android)
//
//  The pre-2011 Microsoft Metro look: flat fills, zero corner radius, a
//  near-black or warm-paper canvas and a single Zune-orange accent.
//
//  Every colour and metric comes from `Tokens.kt`, which is generated from
//  `packages/shared/tokens.css`.
//

package com.zode.app.design

import android.content.Context
import android.provider.Settings
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.Color

/** The two canvases the app can run on. */
enum class AppTheme {
    INK,
    PAPER;

    /** Uppercase label used by the theme toggle. */
    val label: String
        get() = if (this == INK) "INK" else "PAPER"
}

/** The resolved colours for one theme. */
data class MetroPalette(
    val theme: AppTheme,
    val canvas: Color,
    val surface: Color,
    val surfaceAlt: Color,
    val hairline: Color,
    val text: Color,
    val textMuted: Color,
    val accent: Color,
    val accentBright: Color,
    val accentGhost: Color,
    val onAccent: Color
) {
    companion object {
        /** Near-black canvas. */
        val ink = MetroPalette(
            theme = AppTheme.INK,
            canvas = ZodeTokens.Colors.zodeInk,
            surface = ZodeTokens.Colors.zodeInk2,
            surfaceAlt = ZodeTokens.Colors.zodeInk3,
            hairline = ZodeTokens.Colors.zodeInk4,
            text = ZodeTokens.Colors.zodeTextInvert,
            textMuted = ZodeTokens.Colors.zodeTextInvertMuted,
            accent = ZodeTokens.Colors.zodeOrange,
            accentBright = ZodeTokens.Colors.zodeOrangeBright,
            accentGhost = ZodeTokens.Colors.zodeOrangeGhost,
            onAccent = ZodeTokens.Colors.zodeInk
        )

        /** Warm paper canvas. */
        val paper = MetroPalette(
            theme = AppTheme.PAPER,
            canvas = ZodeTokens.Colors.zodePaper,
            surface = ZodeTokens.Colors.zodeWhite,
            surfaceAlt = ZodeTokens.Colors.zodePaper2,
            hairline = ZodeTokens.Colors.zodePaper3,
            text = ZodeTokens.Colors.zodeText,
            textMuted = ZodeTokens.Colors.zodeTextMuted,
            accent = ZodeTokens.Colors.zodeOrange,
            accentBright = ZodeTokens.Colors.zodeOrangeDeep,
            accentGhost = ZodeTokens.Colors.zodeOrangeGhost,
            onAccent = ZodeTokens.Colors.zodeWhite
        )

        fun of(theme: AppTheme): MetroPalette = if (theme == AppTheme.INK) ink else paper
    }
}

/** The active Metro palette. */
val LocalMetroPalette = androidx.compose.runtime.staticCompositionLocalOf { MetroPalette.ink }

/** Provides the palette to the whole tree. */
@Composable
fun ZodeTheme(theme: AppTheme, content: @Composable () -> Unit) {
    val palette = remember(theme) { MetroPalette.of(theme) }
    CompositionLocalProvider(LocalMetroPalette provides palette) {
        content()
    }
}

/**
 * The system animator duration scale.
 *
 * `0` means "animations off" (the developer option "Animator duration scale"),
 * so every animation in the app is skipped.
 */
@Composable
fun rememberAnimatorDurationScale(context: Context): Float {
    return remember(context) {
        try {
            Settings.Global.getFloat(
                context.contentResolver,
                Settings.Global.ANIMATOR_DURATION_SCALE,
                1f
            )
        } catch (error: Exception) {
            1f
        }
    }
}
