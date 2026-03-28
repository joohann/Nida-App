/**
 * @file        nida-engine.js
 * @module      NidaEngine
 * @version     2.0.0
 * @since       2026-03-28
 * @description Core prayer-time calculation engine for Nida v2.
 *
 * Responsibilities:
 *   - Normalise raw API time strings into internal minute-based structures
 *   - Determine the current and next prayer
 *   - Countdown calculation with day-transition bug fix
 *   - Progress-bar percentage between prayers
 *   - Isha → Fajr (next day) transition — never rolls back to the same day
 *
 * DEVELOPER.md conventions (summary):
 *   - Every function carries a JSDoc header
 *   - Internal helpers are prefixed with an underscore (_)
 *   - No side-effects outside public methods
 *   - All times are stored internally as minutes-after-midnight (0–1439)
 *   - "Next-day offset" = 1440 minutes is added when a prayer lies in the
 *     future but is registered before midnight on the current calendar day
 *
 * @author  Nida v2 Team
 * @license MIT
 */

// ---------------------------------------------------------------------------
// CONSTANTS
// ---------------------------------------------------------------------------

/**
 * Canonical order of the five daily prayers.
 * Used for iteration and array indexing throughout the codebase.
 *
 * @constant {string[]}
 */
export const PRAYER_KEYS = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'];

/**
 * Emoji icon per prayer for UI display.
 *
 * @constant {Record<string, string>}
 */
export const PRAYER_ICONS = {
  fajr:    '🌙',
  dhuhr:   '☀️',
  asr:     '🌤️',
  maghrib: '🌇',
  isha:    '🌑',
};

/**
 * Imsak offset in minutes before Fajr when the API does not supply an Imsak time.
 * 10 minutes is the most widely used convention.
 *
 * @constant {number}
 */
const IMSAK_FALLBACK_OFFSET_MIN = 10;

/**
 * Minimum cache lifetime for daily times in milliseconds.
 * After this period times are re-fetched even when the date appears unchanged.
 * Guards against DST roll-overs and timezone-jump edge cases.
 *
 * @constant {number}
 */
const DAILY_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

// ---------------------------------------------------------------------------
// INTERNAL HELPERS
// ---------------------------------------------------------------------------

/**
 * Converts a time string in "HH:MM" or "HH:MM:SS" format to the number of
 * minutes after midnight.
 *
 * @param  {string} timeStr - e.g. "05:23" or "05:23:00"
 * @returns {number|null}   Minutes after midnight, or null for invalid input
 *
 * @example
 * _timeToMinutes("05:23")   // → 323
 * _timeToMinutes("invalid") // → null
 */
function _timeToMinutes(timeStr) {
  if (!timeStr || typeof timeStr !== 'string') return null;

  // Strip optional seconds component (HH:MM:SS → HH:MM)
  const [hhStr, mmStr] = timeStr.trim().split(':');
  const hh = parseInt(hhStr, 10);
  const mm = parseInt(mmStr, 10);

  if (isNaN(hh) || isNaN(mm)) return null;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;

  return hh * 60 + mm;
}

/**
 * Converts minutes-after-midnight back to a "HH:MM" string.
 * Automatically wraps values >= 1440 (next day).
 *
 * @param  {number} totalMinutes - Minutes after midnight (may be >= 1440)
 * @returns {string}             Time string "HH:MM"
 *
 * @example
 * _minutesToTime(323)  // → "05:23"
 * _minutesToTime(1500) // → "01:00"  (next day, 1500-1440=60)
 */
function _minutesToTime(totalMinutes) {
  // Wrap into the [0, 1439] range
  const wrapped = ((totalMinutes % 1440) + 1440) % 1440;
  const hh = Math.floor(wrapped / 60);
  const mm = wrapped % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/**
 * Returns the current number of seconds after midnight.
 *
 * @returns {number} Seconds in range [0, 86399]
 */
function _nowSeconds() {
  const d = new Date();
  return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
}

/**
 * Returns the current number of minutes after midnight.
 *
 * @returns {number} Minutes in range [0, 1439]
 */
function _nowMinutes() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

// ---------------------------------------------------------------------------
// MAIN CLASS
// ---------------------------------------------------------------------------

/**
 * @class NidaEngine
 *
 * Central calculation engine for Nida v2.
 *
 * Usage:
 * ```js
 * const engine = new NidaEngine();
 * engine.loadTimes({ fajr: "05:23", dhuhr: "12:15", ... });
 * const next     = engine.getNextPrayer();
 * const countdown = engine.getCountdown();
 * ```
 *
 * A singleton instance is recommended — one per app session.
 */
export class NidaEngine {
  constructor() {
    /**
     * Internal storage of prayer times as minutes-after-midnight.
     * Key = prayer key (e.g. 'fajr'), value = integer minutes.
     *
     * @type {Record<string, number>}
     * @private
     */
    this._times = {};

    /**
     * Imsak time in minutes after midnight (null when unavailable).
     *
     * @type {number|null}
     * @private
     */
    this._imsak = null;

    /**
     * Timestamp of the last loadTimes() call.
     * Used for cache invalidation.
     *
     * @type {number}
     * @private
     */
    this._loadedAt = 0;

    /**
     * Date string (YYYY-MM-DD) for which the current times are valid.
     *
     * @type {string|null}
     * @private
     */
    this._dateKey = null;
  }

  // -------------------------------------------------------------------------
  // PUBLIC METHODS — LOADING DATA
  // -------------------------------------------------------------------------

  /**
   * Loads prayer times from a raw time map.
   *
   * The `timesMap` can originate from:
   *   - An AlaDhan API response (see nida-api.js)
   *   - Home Assistant sensor states
   *   - Manual configuration
   *
   * @param {object} timesMap            - Map of time strings per prayer
   * @param {string} timesMap.fajr       - Fajr time "HH:MM"
   * @param {string} timesMap.dhuhr      - Dhuhr time "HH:MM"
   * @param {string} timesMap.asr        - Asr time "HH:MM"
   * @param {string} timesMap.maghrib    - Maghrib time "HH:MM"
   * @param {string} timesMap.isha       - Isha time "HH:MM"
   * @param {string} [timesMap.imsak]    - Imsak time "HH:MM" (optional)
   * @param {string} [timesMap.sunrise]  - Sunrise "HH:MM" (optional, display only)
   * @param {string} [timesMap.sunset]   - Sunset "HH:MM" (optional)
   * @param {string} [dateKey]           - Date "YYYY-MM-DD" the times are valid for
   * @returns {boolean}                  True when all 5 prayer times loaded successfully
   */
  loadTimes(timesMap, dateKey = null) {
    if (!timesMap || typeof timesMap !== 'object') {
      console.warn('[NidaEngine] loadTimes: invalid timesMap argument');
      return false;
    }

    // Reset internal state before loading
    this._times = {};
    this._imsak = null;

    let allLoaded = true;

    // Process the five required prayers
    for (const key of PRAYER_KEYS) {
      const raw = timesMap[key] || timesMap[key.toLowerCase()];
      const minutes = _timeToMinutes(raw);

      if (minutes === null) {
        console.warn(`[NidaEngine] loadTimes: invalid or missing time for '${key}':`, raw);
        allLoaded = false;
      } else {
        this._times[key] = minutes;
      }
    }

    // Imsak: use API value or fall back to Fajr minus the offset constant
    if (timesMap.imsak) {
      this._imsak = _timeToMinutes(timesMap.imsak);
    }
    if (this._imsak === null && this._times.fajr !== undefined) {
      // Fallback: 10 minutes before Fajr
      this._imsak = this._times.fajr - IMSAK_FALLBACK_OFFSET_MIN;
    }

    // Optional extra times — stored but not required
    for (const extra of ['sunrise', 'sunset', 'midnight']) {
      if (timesMap[extra]) {
        const m = _timeToMinutes(timesMap[extra]);
        if (m !== null) this._times[extra] = m;
      }
    }

    this._loadedAt = Date.now();
    this._dateKey  = dateKey || _todayKey();

    return allLoaded;
  }

  /**
   * Checks whether the currently loaded times are still valid.
   * Becomes invalid when:
   *   - The cache TTL has expired
   *   - The calendar date has changed (after midnight)
   *
   * @returns {boolean} True when valid and not expired
   */
  isCacheValid() {
    if (!this._loadedAt || !this._dateKey) return false;

    const ageMs = Date.now() - this._loadedAt;
    if (ageMs > DAILY_CACHE_TTL_MS) return false;

    // Still on the same calendar day?
    if (this._dateKey !== _todayKey()) return false;

    return true;
  }

  // -------------------------------------------------------------------------
  // PUBLIC METHODS — PRAYER LOGIC
  // -------------------------------------------------------------------------

  /**
   * Determines the next prayer based on the current time.
   *
   * DAY-TRANSITION BUG FIX:
   *   After Isha there are no more prayers left for today.
   *   In that case we always count forward to Fajr of the *next* day.
   *   The returned `minutesUntil` may therefore exceed the minutes
   *   remaining until midnight — this is correct behaviour.
   *
   *   Bug (v1): After Isha, Fajr of the *same* day was returned as next,
   *             causing a negative countdown.
   *   Fix (v2): We add 1440 minutes (= 1 day) to Fajr whenever
   *             `nowMinutes > ishaMinutes`.
   *
   * @returns {{
   *   key:          string,   // Prayer key, e.g. 'fajr'
   *   displayTime:  string,   // "HH:MM" of the next prayer
   *   minutesUntil: number,   // Minutes until the prayer (always >= 0)
   *   isNextDay:    boolean,  // True when this is Fajr of the following day
   * }|null} Null when no times have been loaded
   */
  getNextPrayer() {
    if (!this._hasAllTimes()) return null;

    const now = _nowMinutes();

    // Walk through all prayers in chronological order.
    // Return the first one that has not yet passed.
    for (const key of PRAYER_KEYS) {
      const prayerMin = this._times[key];
      if (prayerMin > now) {
        return {
          key,
          displayTime:  _minutesToTime(prayerMin),
          minutesUntil: prayerMin - now,
          isNextDay:    false,
        };
      }
    }

    // -----------------------------------------------------------------------
    // DAY TRANSITION: we are past Isha — next prayer is Fajr tomorrow.
    //
    // This is the core of the bug fix. We NEVER roll back to Fajr of the
    // same day. Fajr tomorrow = fajr_minutes + 1440.
    // -----------------------------------------------------------------------
    const fajrMin = this._times.fajr;
    const minutesUntilFajrTomorrow = (fajrMin + 1440) - now;

    return {
      key:          'fajr',
      displayTime:  _minutesToTime(fajrMin),   // Display the Fajr time (same visual)
      minutesUntil: minutesUntilFajrTomorrow,
      isNextDay:    true,                       // Explicitly marked as "next day"
    };
  }

  /**
   * Returns the currently active prayer.
   *
   * A prayer is "active" from when it starts until the next prayer begins.
   * Isha remains active until Fajr the following day (via day-transition logic).
   *
   * @returns {{
   *   key:            string,  // Prayer key
   *   displayTime:    string,  // "HH:MM"
   *   isPastMidnight: boolean  // True when we are in the post-midnight Isha session
   * }|null} Null when no times have been loaded
   */
  getCurrentPrayer() {
    if (!this._hasAllTimes()) return null;

    const now = _nowMinutes();

    // Walk forward: the last prayer that has already started is the active one
    let current = null;
    for (const key of PRAYER_KEYS) {
      if (this._times[key] <= now) {
        current = key;
      }
    }

    if (current) {
      return {
        key:            current,
        displayTime:    _minutesToTime(this._times[current]),
        isPastMidnight: false,
      };
    }

    // Before Fajr: the "active" prayer is Isha from the previous night
    // (we are in the Isha session that runs past midnight)
    return {
      key:            'isha',
      displayTime:    _minutesToTime(this._times.isha),
      isPastMidnight: true, // Midnight has passed; last night's Isha is still active
    };
  }

  /**
   * Calculates the countdown in seconds to the next prayer.
   *
   * Uses second-level precision for the live countdown display.
   * Day-transition is handled correctly via getNextPrayer().
   *
   * @returns {{
   *   totalSeconds: number,  // Total seconds until the next prayer
   *   hours:        number,  // Hours component
   *   minutes:      number,  // Minutes component
   *   seconds:      number,  // Seconds component
   *   formatted:    string,  // "H:MM:SS" or "MM:SS" when < 1 hour
   * }|null} Null when no times are loaded or calculation fails
   */
  getCountdown() {
    const next = this.getNextPrayer();
    if (!next) return null;

    const nowSec = _nowSeconds();

    // Seconds until the next prayer, including day-transition correction
    let targetSec;
    if (next.isNextDay) {
      // Fajr tomorrow: (fajr_minutes_today + 1440) * 60 - now_seconds
      const fajrSec = this._times.fajr * 60;
      targetSec = fajrSec + 86400 - nowSec; // 86400 = 24 * 3600
    } else {
      const prayerSec = this._times[next.key] * 60;
      targetSec = prayerSec - nowSec;
    }

    // Safety floor: never negative (can be <0 in rare race conditions)
    const d = Math.max(0, Math.floor(targetSec));

    const hours   = Math.floor(d / 3600);
    const minutes = Math.floor((d % 3600) / 60);
    const seconds = d % 60;

    // Show hours only when relevant
    const formatted = hours > 0
      ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
      : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;

    return { totalSeconds: d, hours, minutes, seconds, formatted };
  }

  /**
   * Calculates the progress percentage between the previous and next prayer.
   *
   * Used for the progress bar in the UI.
   * - 0% = immediately after the previous prayer
   * - 100% = just before the next prayer
   *
   * @returns {number} Integer percentage [0, 100]
   */
  getProgress() {
    if (!this._hasAllTimes()) return 0;

    const now   = _nowMinutes();
    const times = PRAYER_KEYS.map(k => this._times[k]);

    let prev = null;
    let next = null;

    for (let i = 0; i < times.length; i++) {
      if (times[i] <= now) {
        prev = times[i];
      } else if (next === null) {
        next = times[i];
        break;
      }
    }

    // Day transition: after Isha, prev = Isha, next = Fajr tomorrow
    if (next === null) {
      prev = this._times.isha;
      next = this._times.fajr + 1440;
    }
    // Before Fajr: prev = Isha yesterday (negative offset), next = Fajr today
    if (prev === null) {
      prev = this._times.isha - 1440;
    }

    const span = next - prev;
    if (span <= 0) return 0;

    const elapsed = now - prev;
    return Math.min(100, Math.max(0, Math.round((elapsed / span) * 100)));
  }

  /**
   * Returns all loaded prayer times as a sorted array of objects.
   *
   * Each entry contains:
   *  - key:         prayer key
   *  - minutes:     internal minute value
   *  - displayTime: "HH:MM" string
   *  - isPast:      true when the prayer has already passed
   *  - isActive:    true when this is the current prayer
   *  - isNext:      true when this is the upcoming prayer
   *  - icon:        emoji icon
   *
   * @returns {Array<object>} Chronologically sorted array of prayer objects
   */
  getPrayerList() {
    if (!this._hasAllTimes()) return [];

    const now        = _nowMinutes();
    const current    = this.getCurrentPrayer();
    const nextPrayer = this.getNextPrayer();

    return PRAYER_KEYS.map(key => {
      const minutes = this._times[key];
      return {
        key,
        minutes,
        displayTime: _minutesToTime(minutes),
        isPast:      minutes < now && current?.key !== key,
        isActive:    current?.key === key,
        isNext:      nextPrayer?.key === key && !nextPrayer.isNextDay,
        icon:        PRAYER_ICONS[key] || '🕌',
      };
    });
  }

  /**
   * Returns the Imsak time.
   *
   * Imsak marks the start of the fasting period (beginning of a Ramadan day).
   * Either sourced from the API or calculated as Fajr minus 10 minutes.
   *
   * @returns {{ minutes: number, displayTime: string }|null}
   */
  getImsak() {
    if (this._imsak === null) return null;
    return {
      minutes:     this._imsak,
      displayTime: _minutesToTime(this._imsak),
    };
  }

  /**
   * Calculates the next relevant action for the UI notification row.
   *
   * Action types (priority order when times are equal):
   *   1. suhoor  — wake time for suhoor (provided or = imsak)
   *   2. tarhim  — tarhim time (Ramadan-specific, before Fajr)
   *   3. adhan   — the prayer itself
   *   4. tadkir  — reminder 5 or 10 minutes before adhan
   *
   * @param {object}   [opts={}]               - Options
   * @param {boolean}  [opts.isRamadan=false]  - True during Ramadan
   * @param {boolean}  [opts.skipSuhoor=false] - True when the user skips suhoor
   * @param {number}   [opts.suhoorMinutes]    - Exact suhoor wake time (optional)
   * @param {number}   [opts.tarhimMinutes]    - Exact tarhim time (optional)
   * @param {number[]} [opts.tadkirOffsets]    - Minutes before adhan for tadkir [10, 5]
   *
   * @returns {{
   *   type:         'suhoor'|'tarhim'|'adhan'|'tadkir',
   *   prayerKey:    string|null,
   *   minutes:      number,
   *   displayTime:  string,
   *   minutesUntil: number,
   * }|null}
   */
  getNextAction(opts = {}) {
    const {
      isRamadan     = false,
      skipSuhoor    = false,
      suhoorMinutes = null,
      tarhimMinutes = null,
      tadkirOffsets = [10, 5],
    } = opts;

    if (!this._hasAllTimes()) return null;

    const now = _nowMinutes();

    /**
     * Helper: shifts an absolute minute value into the future by adding 1440
     * when the time has already passed today.
     */
    const toFuture = (m) => m > now ? m : m + 1440;

    const candidates = [];

    // ---- 1. Tadkir (reminder before adhan) ----------------------------------
    for (const key of PRAYER_KEYS) {
      const prayerMin = this._times[key];
      const futureMin = toFuture(prayerMin);

      for (const offset of tadkirOffsets) {
        const tadkirMin = futureMin - offset;
        if (tadkirMin > now) {
          candidates.push({
            type:         'tadkir',
            prayerKey:    key,
            minutes:      tadkirMin,
            displayTime:  _minutesToTime(tadkirMin),
            minutesUntil: tadkirMin - now,
          });
        }
      }

      // ---- 2. Adhan itself --------------------------------------------------
      if (futureMin > now) {
        candidates.push({
          type:         'adhan',
          prayerKey:    key,
          minutes:      futureMin,
          displayTime:  _minutesToTime(prayerMin), // Show the real time, not the wrapped value
          minutesUntil: futureMin - now,
        });
      }
    }

    // ---- 3. Suhoor (only when not skipped) -----------------------------------
    if (!skipSuhoor) {
      // Use the provided suhoor time; fall back to imsak
      const rawSuhoor = suhoorMinutes ?? this._imsak;
      if (rawSuhoor !== null) {
        const futureSuhoor = toFuture(rawSuhoor);
        if (futureSuhoor > now) {
          candidates.push({
            type:         'suhoor',
            prayerKey:    null,
            minutes:      futureSuhoor,
            displayTime:  _minutesToTime(rawSuhoor),
            minutesUntil: futureSuhoor - now,
          });
        }
      }
    }

    // ---- 4. Tarhim (Ramadan only, not skipped) -------------------------------
    if (isRamadan && !skipSuhoor) {
      // Use the provided tarhim time; estimate as Fajr minus 10 minutes
      const rawTarhim    = tarhimMinutes ?? (this._times.fajr - 10);
      const futureTarhim = toFuture(rawTarhim);
      if (futureTarhim > now) {
        candidates.push({
          type:         'tarhim',
          prayerKey:    null,
          minutes:      futureTarhim,
          displayTime:  _minutesToTime(rawTarhim),
          minutesUntil: futureTarhim - now,
        });
      }
    }

    if (candidates.length === 0) return null;

    // Sort by minutesUntil (lowest first); break ties with type priority
    const PRIORITY = { suhoor: 0, tarhim: 1, adhan: 2, tadkir: 3 };
    candidates.sort((a, b) => {
      if (a.minutesUntil !== b.minutesUntil) return a.minutesUntil - b.minutesUntil;
      return (PRIORITY[a.type] ?? 9) - (PRIORITY[b.type] ?? 9);
    });

    // Suhoor/tarhim get special precedence: if the first candidate is a tadkir
    // but a suhoor/tarhim is within 90 minutes, show that one first.
    const first = candidates[0];
    if (first.type === 'tadkir') {
      const priorityAction = candidates.find(
        c => (c.type === 'suhoor' || c.type === 'tarhim') && c.minutesUntil <= 90
      );
      if (priorityAction) return priorityAction;
    }

    return first;
  }

  /**
   * Returns the Iftar countdown (Maghrib = iftar time during Ramadan).
   *
   * Counts down to the next Maghrib:
   *   - If Maghrib has not yet occurred today: count to today's time
   *   - If Maghrib has already passed: count to tomorrow's Maghrib
   *
   * @returns {{
   *   totalSeconds: number,
   *   formatted:    string,  // "HH:MM" when > 1 hour; "MM:SS" when <= 1 hour
   *   isPast:       boolean, // True when today's Maghrib (iftar) has passed
   * }|null}
   */
  getIftarCountdown() {
    if (this._times.maghrib === undefined) return null;

    const nowSec     = _nowSeconds();
    const maghribSec = this._times.maghrib * 60;

    // Seconds until the next Maghrib
    let diff = maghribSec - nowSec;
    const isPast = diff <= 0;

    if (isPast) {
      // Today's Maghrib has passed — count to tomorrow
      diff += 86400;
    }

    const d       = Math.max(0, Math.floor(diff));
    const hours   = Math.floor(d / 3600);
    const minutes = Math.floor((d % 3600) / 60);
    const seconds = d % 60;

    // Show HH:MM when more than an hour away; MM:SS for the final hour (more precise)
    const formatted = hours >= 1
      ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
      : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;

    return { totalSeconds: d, formatted, isPast };
  }

  // -------------------------------------------------------------------------
  // PRIVATE HELPERS
  // -------------------------------------------------------------------------

  /**
   * Returns true when all five required prayer times are present.
   *
   * @returns {boolean}
   * @private
   */
  _hasAllTimes() {
    return PRAYER_KEYS.every(k => typeof this._times[k] === 'number');
  }
}

// ---------------------------------------------------------------------------
// MODULE-LEVEL EXPORTS
// ---------------------------------------------------------------------------

/**
 * Returns today's date key in "YYYY-MM-DD" format.
 * Used for cache comparisons.
 *
 * @returns {string} e.g. "2026-03-28"
 */
export function _todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Returns a moon-phase emoji based on the Hijri day number.
 * Approximate 30-day cycle.
 *
 * @param   {number} hijriDay - Day of the Hijri month (1–30)
 * @returns {string}          Emoji character
 */
export function moonPhaseEmoji(hijriDay) {
  const d = ((parseInt(hijriDay, 10) || 1) - 1) % 30;
  if (d < 2)  return '🌑';
  if (d < 6)  return '🌒';
  if (d < 9)  return '🌓';
  if (d < 13) return '🌔';
  if (d < 17) return '🌕';
  if (d < 21) return '🌖';
  if (d < 24) return '🌗';
  if (d < 28) return '🌘';
  return '🌑';
}

/**
 * App-wide singleton instance of the engine.
 *
 * Import and use as:
 * ```js
 * import { engine } from './nida-engine.js';
 * engine.loadTimes({ fajr: "05:23", ... });
 * ```
 *
 * @type {NidaEngine}
 */
export const engine = new NidaEngine();
