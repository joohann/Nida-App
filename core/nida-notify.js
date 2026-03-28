/**
 * @file        core/nida-notify.js
 * @module      NidaNotify
 * @version     3.0.0
 * @since       2026-03-28
 * @description Cross-platform notification manager for Nida v2.
 *
 * Polls engine.getNextAction() every 30 seconds and fires notifications via
 * the correct delivery mechanism for HA, Capacitor 8, Electron 40, or plain
 * browser.  Handles deduplication, permission negotiation and all four action
 * types: adhan, tadkir, tarhim, suhoor.
 *
 * Platform priority (auto-detected):
 *   HA → Capacitor 8 → Electron 40 → Browser
 *
 * Public API:
 *   notify.start(opts)           — begin scheduling
 *   notify.stop()                — clear all timers
 *   notify.setSkipSuhoor(bool)   — hot-update without restart
 *   notify.updateOpts(partial)   — merge new opts without restart
 *   notify.onFired = fn          — callback so the card can react
 *   notify.permissionStatus      — 'granted'|'denied'|'unsupported'
 *
 * Requires:
 *   @capacitor/local-notifications ^7.0.0  (dynamic import, Capacitor only)
 *
 * DEVELOPER.md conventions:
 *   - Every function carries a JSDoc header
 *   - Internal helpers are prefixed with an underscore (_)
 *
 * @author  Nida v2 Team
 * @license MIT
 */

import { engine } from './nida-engine.js';

// ── CONSTANTS ─────────────────────────────────────────────────────────────────

/** Polling interval in milliseconds. */
const POLL_INTERVAL_MS = 30_000;

/**
 * Fire threshold: an action is considered "due" when minutesUntil drops
 * below this value.  Half the poll interval ensures no event is ever missed
 * between two consecutive polls.
 *
 * @type {number}
 */
const FIRE_THRESHOLD_MIN = POLL_INTERVAL_MS / 60_000 / 2; // 0.25 min (15 s)

/** localStorage key for persisting the fired-action deduplication set. */
const DEDUP_STORAGE_KEY = 'nida_v2_fired_actions';

/** Maximum entries kept in the dedup store to avoid unbounded growth. */
const DEDUP_MAX_ENTRIES = 500;

/** Runtime platform identifiers. */
const PLATFORM = Object.freeze({
  HA:        'ha',
  CAPACITOR: 'capacitor',
  ELECTRON:  'electron',
  BROWSER:   'browser',
});

// ── NOTIFICATION LABELS (10 languages) ───────────────────────────────────────

/**
 * Localised label templates for each action type.
 * Placeholders: {prayer} prayer name, {min} minutes, {time} displayTime.
 *
 * @type {Record<string, Record<string, string>>}
 */
const LABELS = {
  en: { adhan:'{prayer} – Adhan', tadkir:'{prayer} in {min} min', tarhim:'Tarhim – prepare for Fajr', suhoor:'Suhoor ends at {time}', fajr:'Fajr', dhuhr:'Dhuhr', asr:'Asr', maghrib:'Maghrib', isha:'Isha' },
  nl: { adhan:'{prayer} – Adhan', tadkir:'{prayer} over {min} min', tarhim:'Tarhim – bereid je voor op Fajr', suhoor:'Suhoor eindigt om {time}', fajr:'Fajr', dhuhr:'Dhuhr', asr:'Asr', maghrib:'Maghrib', isha:'Isha' },
  ar: { adhan:'{prayer} – الأذان', tadkir:'{prayer} بعد {min} دقيقة', tarhim:'ترحيم – استعد للفجر', suhoor:'ينتهي السحور الساعة {time}', fajr:'الفجر', dhuhr:'الظهر', asr:'العصر', maghrib:'المغرب', isha:'العشاء' },
  tr: { adhan:'{prayer} – Ezan', tadkir:'{prayer} – {min} dk kaldı', tarhim:'Tarhim – Sabah namazına hazırlan', suhoor:'Sahur {time}\'de bitiyor', fajr:'Sabah', dhuhr:'Öğle', asr:'İkindi', maghrib:'Akşam', isha:'Yatsı' },
  de: { adhan:'{prayer} – Adhan', tadkir:'{prayer} in {min} Minuten', tarhim:'Tarhim – Vorbereitung für Fajr', suhoor:'Suhoor endet um {time}', fajr:'Fajr', dhuhr:'Dhuhr', asr:'Asr', maghrib:'Maghrib', isha:'Isha' },
  fr: { adhan:'{prayer} – Adhan', tadkir:'{prayer} dans {min} min', tarhim:'Tarhim – préparez-vous pour Fajr', suhoor:'Suhour se termine à {time}', fajr:'Fajr', dhuhr:'Dhuhr', asr:'Asr', maghrib:'Maghrib', isha:'Isha' },
  id: { adhan:'{prayer} – Adzan', tadkir:'{prayer} {min} menit lagi', tarhim:'Tarhim – bersiaplah untuk Subuh', suhoor:'Sahur berakhir pukul {time}', fajr:'Subuh', dhuhr:'Dzuhur', asr:'Ashar', maghrib:'Maghrib', isha:'Isya' },
  ms: { adhan:'{prayer} – Azan', tadkir:'{prayer} dalam {min} min', tarhim:'Tarhim – bersedia untuk Subuh', suhoor:'Sahur tamat pada {time}', fajr:'Subuh', dhuhr:'Zohor', asr:'Asar', maghrib:'Maghrib', isha:'Isyak' },
  ur: { adhan:'{prayer} – اذان', tadkir:'{prayer} {min} منٹ میں', tarhim:'تحریم – فجر کی تیاری کریں', suhoor:'سحری {time} پر ختم', fajr:'فجر', dhuhr:'ظہر', asr:'عصر', maghrib:'مغرب', isha:'عشاء' },
  fa: { adhan:'{prayer} – اذان', tadkir:'{prayer} {min} دقیقه دیگر', tarhim:'تحریم – آماده نماز صبح شوید', suhoor:'سحر ساعت {time} تمام می‌شود', fajr:'صبح', dhuhr:'ظهر', asr:'عصر', maghrib:'مغرب', isha:'عشاء' },
};

// ── CLASS ─────────────────────────────────────────────────────────────────────

/**
 * @class NidaNotify
 * @description Singleton notification manager.  Detects the runtime platform,
 *   negotiates permissions and delivers prayer-time notifications via the
 *   correct mechanism for every supported environment.
 *
 * @example
 * import { notify } from './core/nida-notify.js';
 *
 * // In nida-card.js connectedCallback:
 * notify.onFired = (action) => this._onNotifyFired(action);
 * await notify.start({ hass: this.hass, lang: this._lang, isRamadan: false });
 */
class NidaNotify {
  constructor() {
    /**
     * Detected runtime platform (re-evaluated in start() once hass is known).
     * @type {string}
     * @private
     */
    this._platform = PLATFORM.BROWSER;

    /**
     * setInterval handle for the poll loop.
     * @type {number|null}
     * @private
     */
    this._pollTimer = null;

    /**
     * Current configuration; merged via start() and updateOpts().
     * @type {{ hass: object|null, skipSuhoor: boolean, isRamadan: boolean, lang: string }}
     * @private
     */
    this._opts = {
      hass:       null,
      skipSuhoor: false,
      isRamadan:  false,
      lang:       'en',
    };

    /**
     * In-memory deduplication set.
     * Key format: `{type}:{prayerKey}:{displayTime}:{YYYY-MM-DD}`
     * @type {Set<string>}
     * @private
     */
    this._firedKeys = new Set();

    /**
     * Lazy-loaded Capacitor LocalNotifications plugin reference.
     * @type {object|null}
     * @private
     */
    this._capPlugin = null;

    /**
     * Current notification permission status.
     * Exposed to the card for the settings-panel indicator.
     * @type {'granted'|'denied'|'unsupported'}
     */
    this.permissionStatus = 'unsupported';

    /**
     * Callback invoked immediately after every notification fires.
     * Assign from the card to react (e.g. pulse the active prayer row).
     *
     * @type {function({type: string, prayerKey: string|null, minutesUntil: number, displayTime: string})|null}
     */
    this.onFired = null;

    // Restore persisted dedup keys from a previous session.
    this._loadFiredKeys();
  }

  // ── PUBLIC API ───────────────────────────────────────────────────────────────

  /**
   * Start the notification scheduler.
   * Requests platform-appropriate permission, then begins the 30-second poll loop.
   *
   * @param {object}  [opts]             - Configuration options.
   * @param {object}  [opts.hass]        - HA hass object (required for HA platform).
   * @param {boolean} [opts.skipSuhoor]  - When true, suhoor notifications are suppressed.
   * @param {boolean} [opts.isRamadan]   - When true, tarhim notifications are enabled.
   * @param {string}  [opts.lang='en']   - UI language code for notification strings.
   * @returns {Promise<void>}
   */
  async start(opts = {}) {
    // Prevent double-starts: stop any existing poll first.
    this.stop();

    this._opts    = { ...this._opts, ...opts };
    this._platform = this._detectPlatform();

    await this._requestPermission();

    if (this.permissionStatus === 'denied') {
      console.warn('[NidaNotify] Permission denied – notifications will not fire.');
    }

    // Pre-load the Capacitor plugin so the first poll is not delayed.
    if (this._platform === PLATFORM.CAPACITOR) {
      await this._loadCapacitorPlugin();
    }

    // Immediate first poll, then repeat on the interval.
    await this._poll();
    this._pollTimer = setInterval(() => this._poll(), POLL_INTERVAL_MS);

    console.info(`[NidaNotify] Started — platform: "${this._platform}", permission: ${this.permissionStatus}`);
  }

  /**
   * Stop the notification scheduler and clear all timers.
   * Safe to call even if start() was never invoked.
   *
   * @returns {void}
   */
  stop() {
    if (this._pollTimer !== null) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  /**
   * Hot-update the suhoor-skip flag without restarting the scheduler.
   *
   * @param {boolean} value - When true, suhoor notifications are suppressed.
   * @returns {void}
   */
  setSkipSuhoor(value) {
    this._opts.skipSuhoor = Boolean(value);
  }

  /**
   * Merge new options into the running configuration.
   * Call this from the card whenever lang, isRamadan, hass, or skipSuhoor changes.
   *
   * @param {Partial<{hass: object, skipSuhoor: boolean, isRamadan: boolean, lang: string}>} partial
   * @returns {void}
   */
  updateOpts(partial) {
    this._opts = { ...this._opts, ...partial };
  }

  // ── PRIVATE: platform detection ───────────────────────────────────────────

  /**
   * Identify the runtime environment.
   *
   * Priority: HA (hass in opts or window marker) → Capacitor native bridge →
   * Electron preload → plain browser.
   *
   * @returns {string} One of the PLATFORM constants.
   * @private
   */
  _detectPlatform() {
    if (this._opts.hass || (typeof window !== 'undefined' && window.__hass_panel_custom)) {
      return PLATFORM.HA;
    }
    if (typeof window !== 'undefined' && window.Capacitor?.isNativePlatform?.()) {
      return PLATFORM.CAPACITOR;
    }
    if (typeof window !== 'undefined' && window.electronAPI) {
      return PLATFORM.ELECTRON;
    }
    return PLATFORM.BROWSER;
  }

  // ── PRIVATE: permissions ──────────────────────────────────────────────────

  /**
   * Request notification permission from the appropriate platform API.
   * Sets `this.permissionStatus` on completion.
   *
   * @returns {Promise<void>}
   * @private
   */
  async _requestPermission() {
    try {
      switch (this._platform) {
        case PLATFORM.HA:
          // HA manages all delivery — no browser permission prompt needed.
          this.permissionStatus = 'granted';
          break;
        case PLATFORM.CAPACITOR:
          await this._requestCapacitorPermission();
          break;
        case PLATFORM.ELECTRON:
        case PLATFORM.BROWSER:
          await this._requestWebPermission();
          break;
        default:
          this.permissionStatus = 'unsupported';
      }
    } catch (err) {
      console.error('[NidaNotify] Permission request failed:', err);
      this.permissionStatus = 'denied';
    }
  }

  /**
   * Negotiate permission with the Capacitor LocalNotifications plugin (v7).
   * Also advises about exact-alarm settings on Android 12+.
   *
   * @returns {Promise<void>}
   * @private
   */
  async _requestCapacitorPermission() {
    const plugin = await this._loadCapacitorPlugin();
    if (!plugin) { this.permissionStatus = 'unsupported'; return; }

    let status = await plugin.checkPermissions();

    if (status.display === 'prompt' || status.display === 'prompt-with-rationale') {
      status = await plugin.requestPermissions();
    }
    this.permissionStatus = status.display === 'granted' ? 'granted' : 'denied';

    // Android 12+: check exact-alarm setting (advisory).
    try {
      const exact = await plugin.checkExactNotificationSetting();
      if (exact.exact_alarm === 'denied') {
        console.warn('[NidaNotify] Exact alarms denied — adhan may arrive late on Android 12+.');
      }
    } catch (_) { /* iOS: method unavailable */ }
  }

  /**
   * Negotiate permission via the Web Notifications API (Browser / Electron).
   *
   * @returns {Promise<void>}
   * @private
   */
  async _requestWebPermission() {
    if (!('Notification' in window)) { this.permissionStatus = 'unsupported'; return; }
    if (Notification.permission === 'granted') { this.permissionStatus = 'granted'; return; }
    if (Notification.permission === 'denied')  { this.permissionStatus = 'denied';  return; }

    const result = await Notification.requestPermission();
    this.permissionStatus = result === 'granted' ? 'granted' : 'denied';
  }

  // ── PRIVATE: Capacitor plugin loader ──────────────────────────────────────

  /**
   * Dynamically import the Capacitor LocalNotifications plugin.
   * Result is cached; subsequent calls return the cached reference.
   *
   * @returns {Promise<object|null>} Plugin object, or null when unavailable.
   * @private
   */
  async _loadCapacitorPlugin() {
    if (this._capPlugin) return this._capPlugin;
    try {
      const mod = await import('@capacitor/local-notifications');
      this._capPlugin = mod.LocalNotifications;
      return this._capPlugin;
    } catch (err) {
      console.warn('[NidaNotify] @capacitor/local-notifications unavailable:', err.message);
      return null;
    }
  }

  // ── PRIVATE: poll loop ────────────────────────────────────────────────────

  /**
   * Main poll handler — executed every POLL_INTERVAL_MS milliseconds.
   *
   * Strategy:
   *   1. Ask the engine for the single most-imminent action, passing live opts
   *      so isRamadan / skipSuhoor filtering is always up to date.
   *   2. If action.minutesUntil ≤ FIRE_THRESHOLD_MIN the event is due → fire.
   *   3. Deduplication via `_firedKeys` guarantees each event fires exactly once.
   *
   * The engine's getNextAction() already encodes tadkir as a separate action
   * type with its own minutesUntil, so no additional setTimeout scheduling is
   * required here.
   *
   * @returns {Promise<void>}
   * @private
   */
  async _poll() {
    let action;
    try {
      action = engine.getNextAction({
        isRamadan:  this._opts.isRamadan,
        skipSuhoor: this._opts.skipSuhoor,
      });
    } catch (err) {
      console.error('[NidaNotify] engine.getNextAction() threw:', err);
      return;
    }

    if (!action) return;

    // Double-check guard conditions (opts may change between polls).
    if (action.type === 'suhoor' && this._opts.skipSuhoor)  return;
    if (action.type === 'tarhim' && !this._opts.isRamadan)  return;

    // Only fire when the action is within the threshold window.
    if (action.minutesUntil > FIRE_THRESHOLD_MIN) return;

    await this._tryFire(action);
  }

  // ── PRIVATE: fire dispatcher ──────────────────────────────────────────────

  /**
   * Deduplication guard, then route to the platform-specific delivery method.
   *
   * @param {{ type: string, prayerKey: string|null, minutesUntil: number, displayTime: string }} action
   * @returns {Promise<void>}
   * @private
   */
  async _tryFire(action) {
    const dedupKey = this._buildDedupKey(action);
    if (this._firedKeys.has(dedupKey)) return;

    // Mark as fired BEFORE delivery to prevent races during async delivery.
    this._markFired(dedupKey);
    console.info(`[NidaNotify] Firing: ${dedupKey}`);

    try {
      switch (this._platform) {
        case PLATFORM.HA:        await this._deliverHA(action);        break;
        case PLATFORM.CAPACITOR: await this._deliverCapacitor(action); break;
        case PLATFORM.ELECTRON:  this._deliverElectron(action);        break;
        case PLATFORM.BROWSER:
        default:                 this._deliverBrowser(action);         break;
      }
    } catch (err) {
      console.error('[NidaNotify] Delivery error:', err);
    }

    if (typeof this.onFired === 'function') {
      try { this.onFired(action); } catch (_) {}
    }
  }

  // ── PRIVATE: HA delivery ──────────────────────────────────────────────────

  /**
   * Deliver via Home Assistant services.
   *
   * adhan  → script.nida_adhan  + notify.notify
   * tadkir → notify.notify only (no audio)
   * tarhim → script.nida_tarhim + notify.notify
   * suhoor → notify.notify
   *
   * @param {object} action
   * @returns {Promise<void>}
   * @private
   */
  async _deliverHA(action) {
    const { hass } = this._opts;
    if (!hass?.callService) {
      console.warn('[NidaNotify] HA delivery skipped: hass not available.');
      return;
    }

    const { type, prayerKey } = action;
    const label = this._buildLabel(action);

    switch (type) {
      case 'adhan':
        // Fire audio script non-blocking; do not await to avoid blocking notify.
        hass.callService('script', 'turn_on', {
          entity_id: 'script.nida_adhan',
          variables:  { prayer: prayerKey ?? '' },
        }).catch((e) => console.warn('[NidaNotify] HA adhan script error:', e));

        await hass.callService('notify', 'notify', { title: label.title, message: label.body });
        break;

      case 'tadkir':
        await hass.callService('notify', 'notify', {
          title:   label.title,
          message: label.body,
          data:    { push: { sound: 'none' } },
        });
        break;

      case 'tarhim':
        hass.callService('script', 'turn_on', { entity_id: 'script.nida_tarhim' })
          .catch((e) => console.warn('[NidaNotify] HA tarhim script error:', e));
        await hass.callService('notify', 'notify', { title: label.title, message: label.body });
        break;

      case 'suhoor':
        await hass.callService('notify', 'notify', { title: label.title, message: label.body });
        break;
    }
  }

  // ── PRIVATE: Capacitor delivery ───────────────────────────────────────────

  /**
   * Deliver via @capacitor/local-notifications v7.
   *
   * Schedules an "immediate" notification (at = now + 1 s) so the OS treats
   * it as a native alert.  allowWhileIdle ensures delivery in Android Doze.
   *
   * Required native notification channels (create these in the Android project):
   *   nida_adhan  — IMPORTANCE_HIGH + adhan sound
   *   nida_silent — IMPORTANCE_LOW  + no sound
   *   nida_gentle — IMPORTANCE_DEFAULT + gentle tone
   *
   * @param {object} action
   * @returns {Promise<void>}
   * @private
   */
  async _deliverCapacitor(action) {
    const plugin = await this._loadCapacitorPlugin();
    if (!plugin) return;

    const { type, prayerKey } = action;
    const label   = this._buildLabel(action);
    const notifId = this._hashToInt32(this._buildDedupKey(action));

    /** @type {import('@capacitor/local-notifications').LocalNotificationSchema} */
    const notification = {
      id:             notifId,
      title:          label.title,
      body:           label.body,
      schedule:       { at: new Date(Date.now() + 1_000) },
      allowWhileIdle: true,
      smallIcon:      'ic_nida_notify',
      iconColor:      '#1B6B3A',
      channelId:      this._capChannel(type),
      extra:          { type, prayerKey },
    };

    // adhan / tarhim: channel carries the adhan .wav (configured in capacitor.config).
    // tadkir: nida_silent channel → no sound.
    if (type === 'adhan' || type === 'tarhim') {
      notification.sound = 'adhan.wav';
    }

    await plugin.schedule({ notifications: [notification] });
  }

  /**
   * Map an action type to its Capacitor channel ID.
   *
   * @param {string} type
   * @returns {string}
   * @private
   */
  _capChannel(type) {
    const map = { adhan:'nida_adhan', tadkir:'nida_silent', tarhim:'nida_adhan', suhoor:'nida_gentle' };
    return map[type] ?? 'nida_default';
  }

  // ── PRIVATE: Electron delivery ────────────────────────────────────────────

  /**
   * Deliver via the Web Notifications API inside Electron 40.
   * Optionally forwards to the main process via window.electronAPI for
   * system-tray integration and audio playback.
   *
   * @param {object} action
   * @returns {void}
   * @private
   */
  _deliverElectron(action) {
    const { type, prayerKey, displayTime } = action;
    const label = this._buildLabel(action);

    const notif = new Notification(label.title, {
      body:   label.body,
      icon:   'assets/icons/nida-icon-512.png',
      silent: type === 'tadkir',
      tag:    this._buildDedupKey(action),
    });

    notif.onclick = () => window.electronAPI?.focusWindow?.();

    // IPC bridge → tray badge / audio in the Electron main process.
    window.electronAPI?.sendNotification?.({ type, prayerKey, displayTime, label });
  }

  // ── PRIVATE: Browser delivery ─────────────────────────────────────────────

  /**
   * Deliver via the Web Notifications API in a plain browser context.
   *
   * @param {object} action
   * @returns {void}
   * @private
   */
  _deliverBrowser(action) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;

    const { type } = action;
    const label    = this._buildLabel(action);

    new Notification(label.title, {
      body:   label.body,
      icon:   'assets/icons/nida-icon-192.png',
      silent: type === 'tadkir',
      tag:    this._buildDedupKey(action),
    });
  }

  // ── PRIVATE: label builder ────────────────────────────────────────────────

  /**
   * Build localised notification title and body strings.
   *
   * @param {{ type: string, prayerKey: string|null, minutesUntil: number, displayTime: string }} action
   * @returns {{ title: string, body: string }}
   * @private
   */
  _buildLabel(action) {
    const { type, prayerKey, minutesUntil, displayTime } = action;
    const lang   = this._opts.lang ?? 'en';
    const dict   = LABELS[lang] ?? LABELS.en;
    const prayer = prayerKey ? (dict[prayerKey] ?? prayerKey) : '';
    const min    = String(Math.max(1, Math.round(minutesUntil)));

    const interp = (tmpl) => tmpl
      .replace('{prayer}', prayer)
      .replace('{min}',    min)
      .replace('{time}',   displayTime ?? '');

    switch (type) {
      case 'adhan':  return { title: interp(dict.adhan),  body: displayTime ?? '' };
      case 'tadkir': return { title: '🕌 Nida',           body: interp(dict.tadkir) };
      case 'tarhim': return { title: '🌙 Nida',           body: interp(dict.tarhim) };
      case 'suhoor': return { title: '🌙 Nida',           body: interp(dict.suhoor) };
      default:       return { title: 'Nida',              body: '' };
    }
  }

  // ── PRIVATE: deduplication ────────────────────────────────────────────────

  /**
   * Build a unique deduplication key for an action on the current day.
   *
   * Using `displayTime` in the key distinguishes the 10-min tadkir from the
   * 5-min tadkir even though both share the same `type` and `prayerKey`.
   *
   * Format: `{type}:{prayerKey|none}:{displayTime}:{YYYY-MM-DD}`
   *
   * @param {{ type: string, prayerKey: string|null, displayTime: string }} action
   * @returns {string}
   * @private
   */
  _buildDedupKey(action) {
    return `${action.type}:${action.prayerKey ?? 'none'}:${action.displayTime}:${this._todayKey()}`;
  }

  /**
   * Record a dedup key as fired in memory and localStorage.
   *
   * @param {string} key
   * @returns {void}
   * @private
   */
  _markFired(key) {
    this._firedKeys.add(key);
    this._persistFiredKeys();
  }

  /**
   * Load persisted dedup keys from localStorage into the in-memory Set.
   * Silently ignores storage errors (e.g. private browsing mode).
   *
   * @returns {void}
   * @private
   */
  _loadFiredKeys() {
    try {
      const raw = localStorage.getItem(DEDUP_STORAGE_KEY);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) arr.forEach((k) => this._firedKeys.add(k));
      }
    } catch (_) {}
  }

  /**
   * Write the fired-keys Set to localStorage.
   * Prunes the oldest entries when the set exceeds DEDUP_MAX_ENTRIES.
   *
   * @returns {void}
   * @private
   */
  _persistFiredKeys() {
    try {
      let arr = [...this._firedKeys];
      if (arr.length > DEDUP_MAX_ENTRIES) {
        arr = arr.slice(arr.length - DEDUP_MAX_ENTRIES);
        this._firedKeys = new Set(arr);
      }
      localStorage.setItem(DEDUP_STORAGE_KEY, JSON.stringify(arr));
    } catch (_) {}
  }

  // ── PRIVATE: utilities ────────────────────────────────────────────────────

  /**
   * Return today's date as `YYYY-MM-DD` in local time.
   *
   * @returns {string}
   * @private
   */
  _todayKey() {
    const d   = new Date();
    const y   = d.getFullYear();
    const m   = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  /**
   * djb2-style hash that maps a string to a 32-bit signed integer.
   * Used to generate stable Capacitor notification IDs within the valid
   * Android range of [-2³¹, 2³¹-1].
   *
   * @param {string} str
   * @returns {number}
   * @private
   */
  _hashToInt32(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) {
      h = (((h << 5) + h) + str.charCodeAt(i)) | 0;
    }
    return h;
  }
}

// ── SINGLETON EXPORT ──────────────────────────────────────────────────────────

/**
 * App-wide singleton instance of NidaNotify.
 * Import this in nida-card.js and any other consumer.
 *
 * @type {NidaNotify}
 */
export const notify = new NidaNotify();
