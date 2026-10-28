//
//  Type.kt
//  ZodeMobile (Android)
//
//  Segoe-style type. Android does not ship "Segoe UI", so the system sans
//  face is used; the *weight* and *tracking* carry the Metro character.
//
//  The sizes come from `Tokens.kt`, which is generated from
//  `packages/shared/tokens.css`.
//

package com.zode.app.design

import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp

/** The type scale. */
object MetroType {

    /** The closest Android equivalent of the Segoe UI stack. */
    val family = FontFamily.SansSerif

    /** The closest Android equivalent of the Cascadia Mono stack. */
    val monoFamily = FontFamily.Monospace

    /** The big, light display face. */
    val display = TextStyle(
        fontFamily = family,
        fontWeight = FontWeight.Light,
        fontSize = ZodeTokens.TypeScale.typeDisplay,
        letterSpacing = ZodeTokens.Tracking.trackingTight.em,
        lineHeight = (ZodeTokens.TypeScale.typeDisplay.value * 1.05f).sp
    )

    /** Section titles. */
    val title = TextStyle(
        fontFamily = family,
        fontWeight = FontWeight.Light,
        fontSize = ZodeTokens.TypeScale.typeTitle,
        letterSpacing = ZodeTokens.Tracking.trackingTight.em,
        lineHeight = (ZodeTokens.TypeScale.typeTitle.value * 1.15f).sp
    )

    /** Sub-headings. */
    val subtitle = TextStyle(
        fontFamily = family,
        fontWeight = FontWeight.Normal,
        fontSize = ZodeTokens.TypeScale.typeSubtitle,
        lineHeight = (ZodeTokens.TypeScale.typeSubtitle.value * 1.3f).sp
    )

    /** Body copy. */
    val body = TextStyle(
        fontFamily = family,
        fontWeight = FontWeight.Normal,
        fontSize = ZodeTokens.TypeScale.typeBody,
        lineHeight = (ZodeTokens.TypeScale.typeBody.value * 1.5f).sp
    )

    /** The uppercase tracked label. */
    val label = TextStyle(
        fontFamily = family,
        fontWeight = FontWeight.SemiBold,
        fontSize = ZodeTokens.TypeScale.typeLabel,
        letterSpacing = ZodeTokens.Tracking.trackingLabel.em
    )

    /** The tiny label. */
    val micro = TextStyle(
        fontFamily = family,
        fontWeight = FontWeight.SemiBold,
        fontSize = ZodeTokens.TypeScale.typeMicro,
        letterSpacing = ZodeTokens.Tracking.trackingLabel.em
    )

    /** Monospaced numerals, used for durations. */
    val mono = TextStyle(
        fontFamily = monoFamily,
        fontWeight = FontWeight.Normal,
        fontSize = ZodeTokens.TypeScale.typeBody
    )
}
