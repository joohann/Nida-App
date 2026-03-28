package com.nida.prayertimes

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.media.AudioAttributes
import android.net.Uri
import android.os.Build

/**
 * @file    NotificationChannelHelper.kt
 * @version 1.0.0
 * @since   2026-03-28
 *
 * Creates the three Nida v2 notification channels.
 * Channel IDs must stay in sync with NidaNotify._capChannel() in nida-notify.js:
 *   nida_adhan   → adhan + tarhim  (IMPORTANCE_HIGH,    adhan.wav)
 *   nida_silent  → tadkir          (IMPORTANCE_LOW,     no sound)
 *   nida_gentle  → suhoor          (IMPORTANCE_DEFAULT, gentle.wav)
 *
 * Safe to call on every app launch — Android deduplicates channels automatically.
 */
object NotificationChannelHelper {

    private const val CHANNEL_ADHAN  = "nida_adhan"
    private const val CHANNEL_SILENT = "nida_silent"
    private const val CHANNEL_GENTLE = "nida_gentle"

    fun createChannels(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return

        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE)
                as NotificationManager

        val audioAttrs = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build()

        // Channel 1: nida_adhan — high importance + adhan.wav
        val adhanUri = Uri.parse("android.resource://${context.packageName}/raw/adhan")
        val adhanChannel = NotificationChannel(
            CHANNEL_ADHAN, "Adhan & Tarhim", NotificationManager.IMPORTANCE_HIGH
        ).apply {
            description          = "Plays adhan at prayer time and tarhim during Ramadan"
            setSound(adhanUri, audioAttrs)
            enableVibration(true)
            vibrationPattern     = longArrayOf(0, 300, 200, 300)
            lockscreenVisibility = android.app.Notification.VISIBILITY_PUBLIC
        }

        // Channel 2: nida_silent — low importance, no sound (tadkir)
        val silentChannel = NotificationChannel(
            CHANNEL_SILENT, "Pre-adhan reminder", NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "Silent reminder a few minutes before each adhan"
            setSound(null, null)
            enableVibration(false)
        }

        // Channel 3: nida_gentle — default importance + gentle.wav (suhoor)
        val gentleUri = Uri.parse("android.resource://${context.packageName}/raw/gentle")
        val gentleChannel = NotificationChannel(
            CHANNEL_GENTLE, "Suhoor reminder", NotificationManager.IMPORTANCE_DEFAULT
        ).apply {
            description = "Gentle reminder for suhoor during Ramadan"
            setSound(gentleUri, audioAttrs)
            enableVibration(false)
        }

        manager.createNotificationChannels(listOf(adhanChannel, silentChannel, gentleChannel))
    }
}
