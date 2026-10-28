//
//  Nav.kt
//  ZodeMobile (Android)
//
//  The app shell: a Metro canvas with the view switcher and the rail of big
//  square tiles along the bottom (Metro's left rail, folded for a phone).
//
//  The view change uses Metro's "reveal" motion -- fast out, gentle settle --
//  and is skipped entirely when the system animator duration scale is 0.
//

package com.zode.app.ui

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedContentTransitionScope
import androidx.compose.animation.ContentTransform
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.togetherWith
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
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.zode.app.ZodeAppState
import com.zode.app.data.AppView
import com.zode.app.design.LocalMetroPalette
import com.zode.app.design.MetroLabel
import com.zode.app.design.ZodeTokens

/** The glyph used by each rail tile. */
private fun glyphFor(view: AppView): String = when (view) {
    AppView.NOW_PLAYING -> "▶"
    AppView.COLLECTION -> "▦"
    AppView.LIBRARY -> "≡"
    AppView.SEARCH -> "⌕"
    AppView.AGENT -> "✳"
}

/** The root scaffold. */
@Composable
fun ZodeScaffold(state: ZodeAppState) {
    val palette = LocalMetroPalette.current
    val context = androidx.compose.ui.platform.LocalContext.current
    val motionScale = com.zode.app.design.rememberAnimatorDurationScale(context)

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(palette.canvas)
            .statusBarsPadding()
    ) {
        Box(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth()
        ) {
            AnimatedContent(
                targetState = state.router.view,
                transitionSpec = { metroReveal(motionScale) },
                label = "zode-view"
            ) { view ->
                when (view) {
                    AppView.NOW_PLAYING -> NowPlayingScreen(state)
                    AppView.COLLECTION -> CollectionScreen(state)
                    AppView.LIBRARY -> LibraryScreen(state)
                    AppView.SEARCH -> SearchScreen(state)
                    AppView.AGENT -> AgentScreen(state)
                }
            }
        }
        MetroRail(state)
    }
}

/** Metro's reveal: a short scale-and-lift with a plain fade on removal. */
private fun AnimatedContentTransitionScope<AppView>.metroReveal(scale: Float): ContentTransform {
    if (scale <= 0f) {
        // The system animator duration scale is zero: no motion at all.
        return fadeIn(tween(0)) togetherWith fadeOut(tween(0))
    }
    val curve = CubicBezierEasing(0.1f, 0.9f, 0.2f, 1f)
    val duration = ZodeTokens.Motion.durBase.toInt()
    return (
        scaleIn(
            initialScale = 0.92f,
            animationSpec = tween(duration, easing = curve)
        ) + fadeIn(tween(duration)) + slideInVertically(
            initialOffsetY = { it / 6 },
            animationSpec = tween(duration, easing = curve)
        )
        ).togetherWith(fadeOut(tween(ZodeTokens.Motion.durFast.toInt())))
}

/** The Metro rail: five big flat square tiles. */
@Composable
fun MetroRail(state: ZodeAppState) {
    val palette = LocalMetroPalette.current

    Column(modifier = Modifier.fillMaxWidth()) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(1.dp)
                .background(palette.hairline)
        )
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(palette.surface)
                .padding(horizontal = ZodeTokens.Metrics.gutter, vertical = ZodeTokens.Metrics.space3),
            horizontalArrangement = Arrangement.spacedBy(ZodeTokens.Metrics.space2)
        ) {
            AppView.entries.forEach { view ->
                val selected = state.router.view == view
                Column(
                    modifier = Modifier
                        .weight(1f)
                        .clip(RoundedCornerShape(0.dp))
                        .background(if (selected) palette.accent else palette.surfaceAlt)
                        .clickable { state.show(view) }
                        .padding(vertical = ZodeTokens.Metrics.space3),
                    horizontalAlignment = Alignment.CenterHorizontally
                ) {
                    Text(
                        text = glyphFor(view),
                        color = if (selected) palette.onAccent else palette.textMuted,
                        style = com.zode.app.design.MetroType.subtitle
                    )
                    MetroLabel(
                        text = view.label,
                        color = if (selected) palette.onAccent else palette.textMuted,
                        style = com.zode.app.design.MetroType.micro
                    )
                }
            }
        }
    }
}

/** A flat, square-cornered container used by the screens. */
@Composable
fun MetroSurface(
    fill: Color,
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit
) {
    Box(
        modifier = modifier
            .clip(RoundedCornerShape(0.dp))
            .background(fill)
    ) {
        content()
    }
}
