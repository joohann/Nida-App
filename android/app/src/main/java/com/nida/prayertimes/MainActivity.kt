package com.nida.prayertimes

import android.os.Bundle
import com.getcapacitor.BridgeActivity

/**
 * @file    MainActivity.kt
 * @version 1.0.0
 * @since   2026-03-28
 *
 * Single Activity for the Nida v2 app.
 * Extends BridgeActivity (Capacitor) which manages the WebView
 * and registers all Capacitor plugins automatically.
 */
class MainActivity : BridgeActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Register notification channels before the WebView loads.
        // Must exist before the first notification is scheduled.
        NotificationChannelHelper.createChannels(this)
    }
}
