/**
 * @file        nida-api.js
 * @module      NidaApi
 * @version     2.0.0
 * @since       2026-03-28
 * @description AlaDhan API v1 wrapper for Nida v2.
 *
 * Responsibilities:
 *   - Fetch daily prayer times via api.aladhan.com/v1
 *   - Fetch monthly calendar (batch, fewer API calls)
 *   - Fetch Hijri date conversion
 *   - Request caching with TTL (prevents duplicate calls on re-renders)
 *   - Retry logic with exponential back-off
 *   - Normalise API responses to NidaEngine-compatible format
 *
 * AlaDhan API v1 — stable endpoints (no auth required):
 *   GET https://api.aladhan.com/v1/timings/{timestamp}
 *   GET https://api.aladhan.com/v1/calendar/{year}/{month}
 *   GET https://api.aladhan.com/v1/gToH/{date}
 *
 * Calculation standard: Muslim World League (MWL) = method 3
 *   - Fajr angle:  18°
 *   - Isha angle:  17°
 *   - Used in Europe, Far East, parts of North America
 *
 * DEVELOPER.md conventions:
 *   - All public methods are async and never throw — they return null on error
 *   - Internal state via a _cache Map (key = cache key string)
 *   - All network errors are logged with [NidaApi] prefix
 *   - Timeout via AbortController (15 seconds)
 *
 * @author  Nida v2 Team
 * @license MIT
 */

// ---------------------------------------------------------------------------
// CONSTANTS
// ---------------------------------------------------------------------------

/**
 * Base URL of the AlaDhan API v1.
 * Version is pinned to v1 for stability.
 *
 * @constant {string}
 */
const API_BASE = 'https://api.aladhan.com/v1';

/**
 * Calculation standard: Muslim World League (MWL).
 * Value 3 is the fixed code for MWL in the AlaDhan API.
 *
 * Other commonly used methods for reference:
 *   1 = University of Islamic Sciences, Karachi
 *   2 = Islamic Society of North America (ISNA)
 *   3 = Muslim World League (MWL)  ← default for Nida v2
 *   4 = Umm Al-Qura University, Makkah
 *   5 = Egyptian General Authority of Survey
 *
 * @constant {number}
 */
export const METHOD_MWL = 3;

/**
 * Maximum number of retry attempts for a failed request.
 *
 * @constant {number}
 */
const MAX_RETRIES = 3;

/**
 * Base wait time (ms) for exponential back-off.
 * Attempt 1: 1000 ms, attempt 2: 2000 ms, attempt 3: 4000 ms.
 *
 * @constant {number}
 */
const BACKOFF_BASE_MS = 1000;

/**
 * Per-request timeout in milliseconds.
 *
 * @constant {number}
 */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Cache TTL for daily timing calls (6 hours).
 * Times do not change within a single day, but periodic re-validation
 * is warranted to handle DST corrections.
 *
 * @constant {number}
 */
const TIMINGS_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Cache TTL for monthly calendar calls (24 hours).
 * A monthly calendar is stable for the entire month.
 *
 * @constant {number}
 */
const CALENDAR_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Cache TTL for Hijri conversion calls (24 hours).
 *
 * @constant {number}
 */
const HIJRI_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// INTERNAL HELPERS
// ---------------------------------------------------------------------------

/**
 * Sleeps for the given number of milliseconds.
 * Used in retry logic.
 *
 * @param   {number} ms - Milliseconds to wait
 * @returns {Promise<void>}
 */
function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Builds a cache key from an endpoint path and query parameters.
 * Parameters are sorted so the key is consistent regardless of object order.
 *
 * @param   {string} endpoint - e.g. 'timings'
 * @param   {object} params   - Query parameters as an object
 * @returns {string}          Combined cache key
 */
function _buildCacheKey(endpoint, params) {
  const sorted = Object.keys(params)
    .sort()
    .map(k => `${k}=${params[k]}`)
    .join('&');
  return `${endpoint}?${sorted}`;
}

/**
 * Returns the current UNIX timestamp in seconds.
 * Used as the path parameter for the AlaDhan timings endpoint.
 *
 * @returns {number} UNIX timestamp (seconds)
 */
function _unixNow() {
  return Math.floor(Date.now() / 1000);
}

/**
 * Formats a date as DD-MM-YYYY (AlaDhan standard).
 *
 * @param   {Date} [date=new Date()] - Date object
 * @returns {string}                 e.g. "28-03-2026"
 */
function _formatDateDMY(date = new Date()) {
  const d = String(date.getDate()).padStart(2, '0');
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const y = date.getFullYear();
  return `${d}-${m}-${y}`;
}

/**
 * Extracts and normalises prayer times from an AlaDhan API response.
 *
 * The API may return times with a timezone annotation, e.g. "05:23 (CEST)".
 * This function strips that annotation.
 *
 * @param   {object} timings - `data.timings` object from the AlaDhan API
 * @returns {object|null}    Normalised map: { fajr, dhuhr, asr, maghrib, isha, imsak, sunrise, sunset }
 */
function _normalizeTimings(timings) {
  if (!timings || typeof timings !== 'object') return null;

  /**
   * Strips an optional timezone annotation.
   * "05:23 (CEST)" → "05:23"
   *
   * @param   {string} t
   * @returns {string|null}
   */
  const clean = (t) => {
    if (!t) return null;
    return t.trim().split(' ')[0]; // Everything before the first space
  };

  return {
    fajr:     clean(timings.Fajr    || timings.fajr),
    dhuhr:    clean(timings.Dhuhr   || timings.dhuhr),
    asr:      clean(timings.Asr     || timings.asr),
    maghrib:  clean(timings.Maghrib || timings.maghrib),
    isha:     clean(timings.Isha    || timings.isha),
    imsak:    clean(timings.Imsak   || timings.imsak),    // Optional
    sunrise:  clean(timings.Sunrise || timings.sunrise),  // Optional
    sunset:   clean(timings.Sunset  || timings.sunset),   // Optional
    midnight: clean(timings.Midnight || timings.midnight), // Optional
  };
}

// ---------------------------------------------------------------------------
// MAIN CLASS
// ---------------------------------------------------------------------------

/**
 * @class NidaApi
 *
 * AlaDhan API client for Nida v2.
 *
 * Usage:
 * ```js
 * const api = new NidaApi({ method: METHOD_MWL });
 * const timings = await api.getTimings({ lat: 6.9175, lon: 107.6191 });
 * if (timings) engine.loadTimes(timings);
 * ```
 *
 * A singleton instance is recommended — one per app session.
 */
export class NidaApi {
  /**
   * @param {object} [opts={}]                - Configuration options
   * @param {number} [opts.method=METHOD_MWL] - AlaDhan calculation standard
   * @param {number} [opts.school=0]          - Hanafi (1) or Shafi'i (0) for Asr
   * @param {string} [opts.timezone]          - IANA timezone string (e.g. "Asia/Jakarta")
   *                                            When empty the API infers the timezone from coordinates
   */
  constructor(opts = {}) {
    /**
     * AlaDhan calculation standard.
     * Default: Muslim World League (3).
     *
     * @type {number}
     */
    this.method = opts.method ?? METHOD_MWL;

    /**
     * Jurisprudence school for Asr calculation.
     * 0 = Shafi'i (default in most countries)
     * 1 = Hanafi (Turkey, Pakistan, India, etc.)
     *
     * @type {number}
     */
    this.school = opts.school ?? 0;

    /**
     * Optional IANA timezone override.
     * When empty, the API determines the timezone from coordinates.
     *
     * @type {string|null}
     */
    this.timezone = opts.timezone || null;

    /**
     * In-memory request cache.
     * Key = cache key string, value = { data, expiresAt }
     *
     * @type {Map<string, { data: any, expiresAt: number }>}
     * @private
     */
    this._cache = new Map();
  }

  // -------------------------------------------------------------------------
  // PUBLIC METHODS — FETCHING TIMES
  // -------------------------------------------------------------------------

  /**
   * Fetches daily prayer times for a specific location and date.
   *
   * Endpoint: GET /v1/timings/{timestamp}
   *   ?latitude={lat}
   *   &longitude={lon}
   *   &method={method}
   *   &school={school}
   *   [&timezonestring={timezone}]
   *
   * @param {object}  opts          - Location options
   * @param {number}  opts.lat      - Latitude (e.g. 6.9175 for Bandung)
   * @param {number}  opts.lon      - Longitude (e.g. 107.6191)
   * @param {Date}    [opts.date]   - Date for the times (default: today)
   * @param {number}  [opts.method] - Override for calculation standard
   *
   * @returns {Promise<object|null>} Normalised times map or null on error
   *
   * @example
   * const timings = await api.getTimings({ lat: 6.9175, lon: 107.6191 });
   * // → { fajr: "05:23", dhuhr: "12:01", asr: "15:18", maghrib: "18:12", isha: "19:25", ... }
   */
  async getTimings({ lat, lon, date = new Date(), method } = {}) {
    if (lat === undefined || lon === undefined) {
      console.warn('[NidaApi] getTimings: lat and lon are required');
      return null;
    }

    // Convert the date to a UNIX timestamp (API path parameter for /v1/timings)
    const dateObj  = date instanceof Date ? date : new Date(date);
    const timestamp = Math.floor(dateObj.getTime() / 1000);

    const params = {
      latitude:  lat,
      longitude: lon,
      method:    method ?? this.method,
      school:    this.school,
    };

    // Attach timezone override when configured
    if (this.timezone) params.timezonestring = this.timezone;

    const cacheKey = _buildCacheKey(`timings/${timestamp}`, params);

    // Check cache first
    const cached = this._getFromCache(cacheKey);
    if (cached) return cached;

    const url  = this._buildUrl(`timings/${timestamp}`, params);
    const data = await this._fetchWithRetry(url);

    if (!data || !data.timings) {
      console.warn('[NidaApi] getTimings: no valid timings in response', data);
      return null;
    }

    const normalized = _normalizeTimings(data.timings);
    if (!normalized) return null;

    this._setCache(cacheKey, normalized, TIMINGS_CACHE_TTL_MS);
    return normalized;
  }

  /**
   * Fetches the monthly prayer calendar for a specific location.
   *
   * Endpoint: GET /v1/calendar/{year}/{month}
   *
   * Returns an array of 28–31 day objects, each containing:
   *   - timings: prayer times for that day
   *   - date:    Gregorian + Hijri date info
   *   - meta:    calculation standard info
   *
   * Use this for proactive pre-fetching at the start of a month.
   *
   * @param {object}  opts         - Options
   * @param {number}  opts.lat     - Latitude
   * @param {number}  opts.lon     - Longitude
   * @param {number}  [opts.year]  - Year (default: current year)
   * @param {number}  [opts.month] - Month 1–12 (default: current month)
   *
   * @returns {Promise<Array|null>} Array of day objects or null on error
   */
  async getCalendar({ lat, lon, year, month } = {}) {
    if (lat === undefined || lon === undefined) {
      console.warn('[NidaApi] getCalendar: lat and lon are required');
      return null;
    }

    const now = new Date();
    const y   = year  ?? now.getFullYear();
    const m   = month ?? (now.getMonth() + 1);

    const params = {
      latitude:  lat,
      longitude: lon,
      method:    this.method,
      school:    this.school,
    };
    if (this.timezone) params.timezonestring = this.timezone;

    const cacheKey = _buildCacheKey(`calendar/${y}/${m}`, params);

    const cached = this._getFromCache(cacheKey);
    if (cached) return cached;

    const url  = this._buildUrl(`calendar/${y}/${m}`, params);
    const data = await this._fetchWithRetry(url);

    if (!Array.isArray(data)) {
      console.warn('[NidaApi] getCalendar: response is not an array', data);
      return null;
    }

    // Normalise each day object
    const normalized = data.map(dayObj => ({
      date:    dayObj.date,    // { gregorian: {...}, hijri: {...} }
      meta:    dayObj.meta,    // { timezone, method, ... }
      timings: _normalizeTimings(dayObj.timings),
    }));

    this._setCache(cacheKey, normalized, CALENDAR_CACHE_TTL_MS);
    return normalized;
  }

  /**
   * Converts a Gregorian date to the corresponding Hijri date.
   *
   * Endpoint: GET /v1/gToH/{date}
   *   date = DD-MM-YYYY format
   *
   * @param {Date|string} [date=new Date()] - Date to convert
   * @returns {Promise<{
   *   day:   string,   // Hijri day as string (e.g. "5")
   *   month: string,   // Hijri month number (e.g. "9" for Ramadan)
   *   year:  string,   // Hijri year (e.g. "1447")
   *   monthName: { ar: string, en: string }
   * }|null>}
   */
  async getHijriDate(date = new Date()) {
    const dateObj  = date instanceof Date ? date : new Date(date);
    const formatted = _formatDateDMY(dateObj);

    const cacheKey = `gToH/${formatted}`;
    const cached   = this._getFromCache(cacheKey);
    if (cached) return cached;

    const url  = this._buildUrl(`gToH/${formatted}`, {});
    const data = await this._fetchWithRetry(url);

    if (!data || !data.hijri) {
      console.warn('[NidaApi] getHijriDate: no hijri data in response', data);
      return null;
    }

    const hijri = data.hijri;
    const result = {
      day:       hijri.day,
      month:     hijri.month?.number?.toString() || '',
      year:      hijri.year,
      monthName: {
        ar: hijri.month?.ar || '',
        en: hijri.month?.en || '',
      },
      weekday: {
        ar: hijri.weekday?.ar || '',
        en: hijri.weekday?.en || '',
      },
    };

    this._setCache(cacheKey, result, HIJRI_CACHE_TTL_MS);
    return result;
  }

  /**
   * Returns all available calculation standards.
   *
   * Endpoint: GET /v1/methods
   *
   * Useful for building a method selector in the settings screen.
   *
   * @returns {Promise<Record<string, object>|null>} Map of method id to details
   */
  async getMethods() {
    const cacheKey = 'methods';
    const cached   = this._getFromCache(cacheKey);
    if (cached) return cached;

    const url  = this._buildUrl('methods', {});
    const data = await this._fetchWithRetry(url);

    if (!data || typeof data !== 'object') {
      console.warn('[NidaApi] getMethods: invalid response', data);
      return null;
    }

    // Cache for 24 hours — methods rarely change
    this._setCache(cacheKey, data, 24 * 60 * 60 * 1000);
    return data;
  }

  /**
   * Fetches the Qibla direction for a location.
   *
   * Endpoint: GET /v1/qibla/{latitude}/{longitude}
   *
   * @param {number} lat - Latitude
   * @param {number} lon - Longitude
   * @returns {Promise<{ direction: number }|null>} Degrees from North, or null on error
   */
  async getQibla(lat, lon) {
    if (lat === undefined || lon === undefined) return null;

    const cacheKey = `qibla/${lat.toFixed(4)}/${lon.toFixed(4)}`;
    const cached   = this._getFromCache(cacheKey);
    if (cached) return cached;

    const url  = this._buildUrl(`qibla/${lat}/${lon}`, {});
    const data = await this._fetchWithRetry(url);

    if (!data || data.direction === undefined) {
      console.warn('[NidaApi] getQibla: no direction in response', data);
      return null;
    }

    const result = { direction: Math.round(data.direction * 10) / 10 };
    this._setCache(cacheKey, result, 24 * 60 * 60 * 1000);
    return result;
  }

  // -------------------------------------------------------------------------
  // CACHE MANAGEMENT
  // -------------------------------------------------------------------------

  /**
   * Clears all in-memory cache entries.
   * Call this after a location change or manual refresh.
   */
  clearCache() {
    this._cache.clear();
    console.info('[NidaApi] Cache cleared');
  }

  /**
   * Removes expired cache entries.
   * Can be called periodically to free memory.
   */
  pruneCache() {
    const now = Date.now();
    for (const [key, entry] of this._cache.entries()) {
      if (entry.expiresAt < now) this._cache.delete(key);
    }
  }

  // -------------------------------------------------------------------------
  // PRIVATE NETWORK METHODS
  // -------------------------------------------------------------------------

  /**
   * Executes a GET request with automatic retry on network errors.
   *
   * Retry strategy:
   *   - Exponential back-off: 1 s, 2 s, 4 s
   *   - Retries only on network errors; no retry on 4xx status codes
   *   - AbortController timeout after REQUEST_TIMEOUT_MS
   *
   * @param   {string}  url          - Full request URL
   * @param   {number}  [attempt=0]  - Internal retry counter
   * @returns {Promise<any|null>}    Parsed JSON `data` field, or null on fatal error
   * @private
   */
  async _fetchWithRetry(url, attempt = 0) {
    const controller = new AbortController();
    const timeoutId  = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (!response.ok) {
        console.warn(`[NidaApi] HTTP ${response.status} for: ${url}`);

        // Retry on server errors (5xx) only; not on client errors (4xx)
        if (response.status >= 500 && attempt < MAX_RETRIES) {
          await _sleep(BACKOFF_BASE_MS * Math.pow(2, attempt));
          return this._fetchWithRetry(url, attempt + 1);
        }

        return null;
      }

      const json = await response.json();

      // AlaDhan API always wraps responses in { code, status, data }
      if (json.code !== 200 || json.status !== 'OK') {
        console.warn(`[NidaApi] API error: code=${json.code} status=${json.status}`);
        return null;
      }

      return json.data;

    } catch (err) {
      clearTimeout(timeoutId);

      if (err.name === 'AbortError') {
        console.warn(`[NidaApi] Request timed out after ${REQUEST_TIMEOUT_MS} ms: ${url}`);
      } else {
        console.warn(`[NidaApi] Network error: ${err.message}`, url);
      }

      if (attempt < MAX_RETRIES) {
        const waitMs = BACKOFF_BASE_MS * Math.pow(2, attempt);
        console.info(`[NidaApi] Retry ${attempt + 1}/${MAX_RETRIES} after ${waitMs} ms`);
        await _sleep(waitMs);
        return this._fetchWithRetry(url, attempt + 1);
      }

      console.error(`[NidaApi] All ${MAX_RETRIES} retries failed for: ${url}`);
      return null;
    }
  }

  /**
   * Builds a full AlaDhan API URL.
   *
   * @param   {string} endpoint - Endpoint path (e.g. 'timings/1711584000')
   * @param   {object} params   - Query parameters as an object
   * @returns {string}          Full URL string
   * @private
   */
  _buildUrl(endpoint, params) {
    const url = new URL(`${API_BASE}/${endpoint}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== null && value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  // -------------------------------------------------------------------------
  // PRIVATE CACHE METHODS
  // -------------------------------------------------------------------------

  /**
   * Retrieves a value from the cache if it has not expired.
   *
   * @param   {string} key - Cache key
   * @returns {any|null}   Cached value or null when expired/absent
   * @private
   */
  _getFromCache(key) {
    const entry = this._cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this._cache.delete(key);
      return null;
    }
    return entry.data;
  }

  /**
   * Stores a value in the cache with a TTL.
   *
   * @param {string} key   - Cache key
   * @param {any}    data  - Value to cache
   * @param {number} ttlMs - Lifetime in milliseconds
   * @private
   */
  _setCache(key, data, ttlMs) {
    this._cache.set(key, { data, expiresAt: Date.now() + ttlMs });
  }
}

// ---------------------------------------------------------------------------
// SINGLETON EXPORT
// ---------------------------------------------------------------------------

/**
 * App-wide singleton API client instance.
 *
 * Configured by default with:
 *   - Calculation standard: Muslim World League (MWL, method 3)
 *   - School: Shafi'i (0)
 *
 * Import and use as:
 * ```js
 * import { api } from './nida-api.js';
 * const timings = await api.getTimings({ lat: 6.9175, lon: 107.6191 });
 * ```
 *
 * @type {NidaApi}
 */
export const api = new NidaApi({ method: METHOD_MWL });
