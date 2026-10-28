//
//  NotificationSupport.kt
//  ZodeMobile (Android)
//
//  Local notifications (contract §9). The app posts a notification when an
//  agent task finishes.
//
//  Only platform APIs are used -- no AndroidX support library -- so the app
//  keeps its "Compose only" dependency list.
//

package com.zode.app.intents

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import com.zode.app.MainActivity
import com.zode.app.R

class NotificationSupport(private val context: Context) {

    companion object {
        /** The notification channel. */
        const val CHANNEL_ID = "zode.agent"

        /** The action identifier used by the notification. */
        const val ACTION_AGENT = "zode.agent"
    }

    private val manager: NotificationManager? =
        context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager

    /** True when the user allowed notifications. */
    val isAuthorized: Boolean
        get() = manager?.areNotificationsEnabled() == true

    /** Creates the notification channel (Android 8+). */
    fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Agent",
            NotificationManager.IMPORTANCE_DEFAULT
        ).apply {
            description = "Zode agent task updates"
        }
        manager?.createNotificationChannel(channel)
    }

    /** Posts a local notification. */
    fun post(title: String, body: String, id: String? = null) {
        val manager = manager ?: return
        if (!manager.areNotificationsEnabled()) return

        val intent = Intent(context, MainActivity::class.java).apply {
            action = ACTION_AGENT
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pending = PendingIntent.getActivity(
            context,
            0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notification = Notification.Builder(context, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(body)
            .setSmallIcon(R.drawable.ic_zode_notification)
            .setContentIntent(pending)
            .setAutoCancel(true)
            .build()

        try {
            // `NotificationManager.notify(String, Notification)` was removed
            // in API 33 -- only the int-id overload survives.
            val notificationId = id?.hashCode() ?: "zode-${System.currentTimeMillis()}".hashCode()
            manager.notify(notificationId, notification)
        } catch (error: SecurityException) {
            // POST_NOTIFICATIONS was not granted; nothing to do.
        }
    }
}
