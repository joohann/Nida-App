/**
 * @file        nida-location.js
 * @module      NidaLocation
 * @version     2.1.0
 * @since       2026-03-28
 * @description 5-layer location strategy for Nida v2 — with GPS drift detection and watchdog.
 *
 * ── LAYER ORDER (highest priority first) ────────────────────────────────────
 *
 *   Layer 1 — Home Assistant (HA)
 *     Reads coordinates from HA system config or the zone.home entity.
 *     HA is authoritative: when HA is available the other layers are never
 *     consulted. Prevents inconsistency with other HA integrations.
 *
 *   Layer 2 — GPS (browser / Capacitor 8)
 *     navigator.geolocation or @capacitor/geolocation.
 *     Requests user permission. Timeout: 10 seconds.
 *
 *   Layer 3 — IP geolocation
 *     https://ip-api.com/json — city/region level (~50 km).
 *     No API key required. Rate limit: 45 req/min per IP.
 *
 *   Layer 4 — Manual
 *     User-supplied coordinates, persisted in localStorage.
 *     Higher priority than GPS/IP: explicit user choice takes precedence.
 *
 *   Layer 5 — Fallback
 *     Mecca as geographical centre. The app is always functional.
 *     The UI always shows a clear warning when this layer is active.
 *
 * ── GPS DISPLAY & DRIFT DETECTION (v2.1) ────────────────────────────────────
 *
 *   Subtle display:
 *     getDisplayInfo() returns a compact object for the UI location badge:
 *     city name (or rounded coordinates), layer icon, refresh availability.
 *
 *   Drift detection:
 *     startWatching() starts a background GPS watcher.
 *     When the new position is > DRIFT_THRESHOLD_KM from the stored position,
 *     a 'drift' event fires via the onDrift callback.
 *     The app can then show a subtle refresh banner.
 *     At > DRIFT_AUTO_UPDATE_KM the location is updated automatically.
 *
 *   Haversine distance:
 *     Internal _haversine() calculates the shortest surface distance between
 *     two geo-coordinates (accuracy: ~0.5%).
 *
 * DEVELOPER.md conventions:
 *   - resolveLocation() always returns a LocationResult (never null/throw)
 *   - Layer numbers are named constants, no magic numbers
 *   - GPS permission errors → permissionDenied: true in LocationResult
 *   - Persistence: localStorage, prefix 'nida-location-'
 *   - Callbacks via public setters (onDrift, onLocationUpdated)
 *   - All console logs prefixed with [NidaLocation]
 *
 * @author  Nida v2 Team
 * @license MIT
 */

// ---------------------------------------------------------------------------
// CONSTANTS — LAYERS
// ---------------------------------------------------------------------------

/**
 * Layer numbers. Lower = higher priority.
 * @enum {number}
 */
export const LOCATION_LAYER = {
  HA:       1,
  GPS:      2,
  IP:       3,
  MANUAL:   4,
  FALLBACK: 5,
};

/** @type {Record<number, string>} Human-readable label per layer */
export const LAYER_LABELS = {
  [LOCATION_LAYER.HA]:       'Home Assistant',
  [LOCATION_LAYER.GPS]:      'GPS',
  [LOCATION_LAYER.IP]:       'IP geolocation',
  [LOCATION_LAYER.MANUAL]:   'Manual',
  [LOCATION_LAYER.FALLBACK]: 'Fallback (Mecca)',
};

/** @type {Record<number, string>} Compact emoji icon per layer (for the subtle UI badge) */
export const LAYER_ICONS = {
  [LOCATION_LAYER.HA]:       '🏠',
  [LOCATION_LAYER.GPS]:      '📍',
  [LOCATION_LAYER.IP]:       '🌐',
  [LOCATION_LAYER.MANUAL]:   '✏️',
  [LOCATION_LAYER.FALLBACK]: '⚠️',
};

// ---------------------------------------------------------------------------
// CONSTANTS — DRIFT THRESHOLDS
// ---------------------------------------------------------------------------

/**
 * Minimum displacement in km that triggers a drift notification.
 * Below this distance: silent update, no UI alert.
 *
 * 5 km is precise enough: at 5 km prayer times differ by less than 1 minute.
 *
 * @constant {number}
 */
const DRIFT_THRESHOLD_KM = 5;

/**
 * Displacement in km at which the location is updated automatically
 * without prompting the user. e.g. when travelling to another city.
 *
 * @constant {number}
 */
const DRIFT_AUTO_UPDATE_KM = 50;

/**
 * How often (ms) the GPS watchdog polls for a position when interval-polling
 * is active. 5 minutes is sufficient — prayer times are day-stable.
 *
 * @constant {number}
 */
const WATCH_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Minimum time (ms) between two consecutive drift notifications.
 * Prevents the UI from being flooded when GPS is unstable.
 *
 * @constant {number}
 */
const DRIFT_DEBOUNCE_MS = 60 * 1000; // 1 minute

// ---------------------------------------------------------------------------
// CONSTANTS — MISC
// ---------------------------------------------------------------------------

/** Mecca fallback location */
const FALLBACK_LOCATION = {
  lat: 21.4225, lon: 39.8262,
  city: 'Mecca', country: 'Saudi Arabia', timezone: 'Asia/Riyadh',
};

/** IP geolocation endpoint — free, no auth */
const IP_GEO_URL = 'https://ip-api.com/json?fields=status,lat,lon,city,country,timezone';

const GPS_TIMEOUT_MS    = 10_000;
const GPS_HIGH_ACCURACY = false;   // false = battery-efficient; sufficient for prayer times
const GPS_MAX_AGE_MS    = 5 * 60 * 1000;
const IP_TIMEOUT_MS     = 8_000;

/** localStorage key prefix */
const STORAGE_PREFIX = 'nida-location-';

/** Cache TTL for automatic reuse (30 min) */
const LOCATION_CACHE_TTL_MS = 30 * 60 * 1000;

// ---------------------------------------------------------------------------
// TYPE DEFINITIONS (JSDoc)
// ---------------------------------------------------------------------------

/**
 * @typedef {object} LocationResult
 * @property {number}      lat               - Latitude
 * @property {number}      lon               - Longitude
 * @property {string}      city              - City name (empty when unknown)
 * @property {string}      country           - Country name (empty when unknown)
 * @property {string|null} timezone          - IANA timezone string
 * @property {number|null} accuracy          - GPS accuracy in metres
 * @property {number}      layer             - LOCATION_LAYER enum value
 * @property {string}      layerLabel        - Human-readable layer name
 * @property {string}      layerIcon         - Emoji icon for the layer
 * @property {boolean}     isFallback        - True when layer 5 (Mecca) is used
 * @property {boolean}     permissionDenied  - True when GPS permission was denied
 * @property {number}      resolvedAt        - Resolution timestamp in ms
 */

/**
 * @typedef {object} DriftEvent
 * @property {LocationResult} previous    - Previously stored location
 * @property {LocationResult} current     - Newly detected location
 * @property {number}  distanceKm         - Distance in km (Haversine)
 * @property {boolean} autoUpdated        - True when already updated automatically
 * @property {boolean} needsConfirm       - True when user confirmation is required
 */

/**
 * @typedef {object} LocationDisplayInfo
 * @property {string}      label       - "Amsterdam" or "6.91°N, 107.62°E"
 * @property {string}      icon        - Emoji icon for the active layer
 * @property {string}      layerLabel  - Human-readable layer name
 * @property {boolean}     isFallback  - True when the Mecca emergency fallback is active
 * @property {boolean}     canRefresh  - True when a GPS refresh is available
 * @property {boolean}     hasDrift    - True when an unconfirmed drift is pending
 * @property {number|null} driftKm     - Distance of the pending drift
 * @property {string|null} driftCity   - City name of the new position
 */

// ---------------------------------------------------------------------------
// MAIN CLASS
// ---------------------------------------------------------------------------

/**
 * @class NidaLocation
 *
 * Manages the 5-layer location strategy for Nida v2.
 * Includes GPS drift detection, background watchdog, and subtle UI display support.
 */
export class NidaLocation {
  constructor() {
    /** @type {object|null} HA hass object @private */
    this._hass = null;

    /** @type {{ lat: number, lon: number, city: string }|null} @private */
    this._manual = this._loadManual();

    /** @type {{ result: LocationResult, expiresAt: number }|null} @private */
    this._locationCache = null;

    /** @type {boolean} True when GPS was denied in this session @private */
    this._gpsDenied = false;

    /**
     * Active watchPosition ID (navigator.geolocation).
     * @type {number|null}
     * @private
     */
    this._watchId = null;

    /**
     * Interval ID for periodic polling (when watchPosition is unavailable).
     * @type {number|null}
     * @private
     */
    this._watchIntervalId = null;

    /**
     * Timestamp of the last drift notification (for debouncing).
     * @type {number}
     * @private
     */
    this._lastDriftAt = 0;

    /**
     * Pending drift awaiting user confirmation.
     * @type {DriftEvent|null}
     * @private
     */
    this._pendingDrift = null;

    // ---- Public callbacks (set by the consuming app) ----------------------

    /**
     * Called whenever a significant location change is detected.
     * @type {((event: DriftEvent) => void)|null}
     */
    this.onDrift = null;

    /**
     * Called after every effective location update.
     * @type {((result: LocationResult) => void)|null}
     */
    this.onLocationUpdated = null;
  }

  // -------------------------------------------------------------------------
  // PUBLIC METHODS — CONFIGURATION
  // -------------------------------------------------------------------------

  /**
   * Injects the HA hass object.
   * Invalidates the cache so the next resolveLocation() re-evaluates HA.
   *
   * @param {object|null} hass - HA hass object, or null to detach HA
   */
  setHass(hass) {
    this._hass = hass;
    if (hass) this._locationCache = null;
  }

  /**
   * Saves a manually configured location.
   * Persisted in localStorage and optionally synced to HA.
   *
   * @param {object} location
   * @param {number} location.lat     - Latitude
   * @param {number} location.lon     - Longitude
   * @param {string} [location.city]  - Optional city name
   */
  setManualLocation({ lat, lon, city = '' }) {
    if (!_isValidCoord(lat, lon)) {
      console.warn('[NidaLocation] setManualLocation: invalid coordinates', { lat, lon });
      return;
    }
    this._manual = { lat, lon, city };
    this._saveManual(this._manual);
    this._syncManualToHA(this._manual);
    this._locationCache = null;
    this._pendingDrift  = null;
    console.info(`[NidaLocation] Manual location saved: ${lat}, ${lon} (${city})`);
  }

  /**
   * Clears the manually configured location.
   * After this call resolveLocation() falls back to GPS/IP.
   */
  clearManualLocation() {
    this._manual = null;
    try { localStorage.removeItem(`${STORAGE_PREFIX}manual`); } catch (_) {}
    this._locationCache = null;
    console.info('[NidaLocation] Manual location cleared');
  }

  // -------------------------------------------------------------------------
  // PUBLIC METHODS — RESOLVING LOCATION
  // -------------------------------------------------------------------------

  /**
   * Determines the best available location via the 5-layer strategy.
   * Always returns a LocationResult — never null or an exception.
   *
   * @param {object}  [opts={}]
   * @param {boolean} [opts.forceRefresh=false] - Bypass the cache
   * @param {boolean} [opts.skipGps=false]      - Skip the GPS layer
   * @param {boolean} [opts.skipIp=false]       - Skip the IP geolocation layer
   * @returns {Promise<LocationResult>}
   */
  async resolveLocation({ forceRefresh = false, skipGps = false, skipIp = false } = {}) {
    // Reuse cache when still valid
    if (!forceRefresh && this._locationCache) {
      if (Date.now() < this._locationCache.expiresAt) {
        return this._locationCache.result;
      }
    }

    // Layer 1: Home Assistant
    const ha = this._resolveFromHA();
    if (ha) return this._cacheAndReturn(ha);

    // Layer 4: Manual — before GPS because explicit user choice takes precedence
    if (this._manual) {
      return this._cacheAndReturn(
        this._buildResult(this._manual.lat, this._manual.lon, LOCATION_LAYER.MANUAL, {
          city: this._manual.city,
        })
      );
    }

    // Layer 2: GPS
    if (!skipGps && !this._gpsDenied) {
      const gps = await this._resolveFromGPS();
      if (gps) return this._cacheAndReturn(gps); // Includes permissionDenied cases
    }

    // Layer 3: IP geolocation
    if (!skipIp) {
      const ip = await this._resolveFromIP();
      if (ip) return this._cacheAndReturn(ip);
    }

    // Layer 5: Mecca fallback
    console.warn('[NidaLocation] All layers failed — Mecca fallback active');
    return this._cacheAndReturn(
      this._buildResult(
        FALLBACK_LOCATION.lat, FALLBACK_LOCATION.lon, LOCATION_LAYER.FALLBACK,
        { city: FALLBACK_LOCATION.city, country: FALLBACK_LOCATION.country,
          timezone: FALLBACK_LOCATION.timezone, isFallback: true }
      )
    );
  }

  /**
   * Forces a GPS refresh and compares the result with the stored location.
   *
   * Workflow:
   *   1. Request a new GPS position
   *   2. Calculate Haversine distance to the cached location
   *   3. < DRIFT_THRESHOLD_KM (5 km)   → silent update, no UI alert
   *   4. < DRIFT_AUTO_UPDATE_KM (50 km) → drift event → user decides
   *   5. >= DRIFT_AUTO_UPDATE_KM        → auto-update + informational event
   *
   * @returns {Promise<LocationResult|null>} New location, or null on error/denial
   */
  async refreshGPS() {
    this._gpsDenied = false; // Reset denial flag for a fresh attempt
    const fresh = await this._resolveFromGPS();

    if (!fresh || fresh.permissionDenied) return null;

    const previous = this._locationCache?.result || null;

    if (!previous) {
      // No location stored yet — save immediately
      const updated = this._cacheAndReturn(fresh);
      this.onLocationUpdated?.(updated);
      return updated;
    }

    const km = _haversine(previous.lat, previous.lon, fresh.lat, fresh.lon);

    if (km < DRIFT_THRESHOLD_KM) {
      // Negligible displacement — silent update
      console.info(`[NidaLocation] GPS refresh: ${km.toFixed(1)} km — silent update`);
      const updated = this._cacheAndReturn(fresh);
      this.onLocationUpdated?.(updated);
      return updated;
    }

    if (km >= DRIFT_AUTO_UPDATE_KM) {
      // Large displacement (e.g. different city): update automatically
      console.info(`[NidaLocation] GPS refresh: ${km.toFixed(0)} km — auto-update`);
      const updated = this._cacheAndReturn(fresh);
      this._fireDriftEvent(previous, fresh, km, true);
      this.onLocationUpdated?.(updated);
      return updated;
    }

    // Middle range: wait for user confirmation
    console.info(`[NidaLocation] GPS refresh: ${km.toFixed(1)} km — awaiting confirmation`);
    this._storePendingDrift(previous, fresh, km);
    // Return the fresh position but do NOT yet update the active location
    return fresh;
  }

  /**
   * Confirms the pending drift and updates the location.
   * Call this when the user taps "Update" on the drift banner.
   *
   * @returns {LocationResult|null} Updated location, or null when no drift is pending
   */
  confirmDrift() {
    if (!this._pendingDrift) return null;
    const { current } = this._pendingDrift;
    this._pendingDrift = null;
    const updated = this._cacheAndReturn(current);
    this.onLocationUpdated?.(updated);
    console.info('[NidaLocation] Drift confirmed by user');
    return updated;
  }

  /**
   * Dismisses the pending drift and keeps the current location.
   * Call this when the user taps "Dismiss" on the drift banner.
   */
  dismissDrift() {
    this._pendingDrift = null;
    console.info('[NidaLocation] Drift dismissed by user');
  }

  // -------------------------------------------------------------------------
  // PUBLIC METHODS — GPS WATCHDOG
  // -------------------------------------------------------------------------

  /**
   * Starts a background GPS watcher that continuously monitors position.
   *
   * Strategy per platform:
   *   - Browser/Electron: navigator.geolocation.watchPosition (event-based, efficient)
   *   - Capacitor native: watchPosition via @capacitor/geolocation
   *   - No GPS hardware: setInterval polling every WATCH_INTERVAL_MS
   *
   * Call from connectedCallback() in the Lit component.
   * The watcher detects displacement and fires drift events via onDrift.
   *
   * @param {object}  [opts={}]
   * @param {boolean} [opts.useInterval=false] - Force interval polling
   */
  startWatching({ useInterval = false } = {}) {
    // Do not start twice
    if (this._watchId !== null || this._watchIntervalId !== null) {
      console.info('[NidaLocation] Watcher already active — skipped');
      return;
    }

    // Do not start when GPS was denied
    if (this._gpsDenied) {
      console.info('[NidaLocation] GPS denied — watcher not started');
      return;
    }

    if (!useInterval && typeof navigator !== 'undefined' && navigator.geolocation) {
      // Browser/Electron: native watchPosition
      this._watchId = navigator.geolocation.watchPosition(
        (pos) => {
          // Called by the OS GPS service whenever a new position is available
          this._handleWatchPosition(pos.coords.latitude, pos.coords.longitude);
        },
        (err) => {
          if (err.code === 1) {
            // PERMISSION_DENIED: stop the watcher and mark as denied
            this._gpsDenied = true;
            console.info('[NidaLocation] Watcher: GPS permission denied, stopped');
            this.stopWatching();
          }
          // Other errors (POSITION_UNAVAILABLE, TIMEOUT) are ignored —
          // the watcher will automatically retry on the next OS update
        },
        { enableHighAccuracy: GPS_HIGH_ACCURACY, maximumAge: GPS_MAX_AGE_MS, timeout: GPS_TIMEOUT_MS }
      );
      console.info('[NidaLocation] GPS watchPosition started (native)');

    } else {
      // Interval polling when watchPosition is unavailable
      // (e.g. Electron without GPS hardware, or useInterval forced to true)
      this._watchIntervalId = setInterval(async () => {
        const fresh = await this._resolveFromGPS();
        if (fresh && !fresh.permissionDenied && _isValidCoord(fresh.lat, fresh.lon)) {
          this._handleWatchPosition(fresh.lat, fresh.lon);
        }
      }, WATCH_INTERVAL_MS);
      console.info(`[NidaLocation] GPS interval polling started (every ${WATCH_INTERVAL_MS / 60000} min)`);
    }
  }

  /**
   * Stops the background GPS watcher.
   * Call from disconnectedCallback() in the Lit component.
   */
  stopWatching() {
    if (this._watchId !== null) {
      if (typeof navigator !== 'undefined') navigator.geolocation?.clearWatch(this._watchId);
      this._watchId = null;
      console.info('[NidaLocation] GPS watchPosition stopped');
    }
    if (this._watchIntervalId !== null) {
      clearInterval(this._watchIntervalId);
      this._watchIntervalId = null;
      console.info('[NidaLocation] GPS interval polling stopped');
    }
  }

  // -------------------------------------------------------------------------
  // PUBLIC METHODS — UI DISPLAY
  // -------------------------------------------------------------------------

  /**
   * Returns compact display information for the subtle location badge.
   *
   * The badge shows at minimum: city/coordinates + layer icon.
   * When GPS is available: also a refresh button (↺).
   * When a drift is pending: a subtle indicator with distance and new city name.
   *
   * @returns {LocationDisplayInfo}
   *
   * @example
   * const info = locator.getDisplayInfo();
   * // → {
   * //   label:      'Jakarta',
   * //   icon:       '📍',
   * //   canRefresh: true,
   * //   hasDrift:   true,
   * //   driftKm:    12,
   * //   driftCity:  'Bekasi'
   * // }
   */
  getDisplayInfo() {
    const result = this._locationCache?.result || null;

    if (!result) {
      return {
        label:      'Location unknown',
        icon:       '❓',
        layerLabel: 'Unknown',
        isFallback: true,
        canRefresh: this._canRefreshGPS(),
        hasDrift:   false,
        driftKm:    null,
        driftCity:  null,
      };
    }

    // Prefer city name over coordinates — less technical for end users
    const label = result.city
      ? result.city
      : `${result.lat.toFixed(2)}°N, ${result.lon.toFixed(2)}°E`;

    return {
      label,
      icon:       result.layerIcon,
      layerLabel: result.layerLabel,
      isFallback: result.isFallback,
      canRefresh: this._canRefreshGPS(),
      hasDrift:   this._pendingDrift !== null,
      driftKm:    this._pendingDrift ? Math.round(this._pendingDrift.distanceKm) : null,
      driftCity:  this._pendingDrift?.current?.city || null,
    };
  }

  /**
   * Returns the Haversine distance in km from the current location to new coordinates.
   * Useful in the UI for showing "you are X km from your saved location".
   *
   * @param   {number} lat
   * @param   {number} lon
   * @returns {number|null} Distance in km, or null when no location is known
   */
  distanceTo(lat, lon) {
    const current = this._locationCache?.result;
    if (!current || !_isValidCoord(lat, lon)) return null;
    return _haversine(current.lat, current.lon, lat, lon);
  }

  // -------------------------------------------------------------------------
  // LAYER 1 — HOME ASSISTANT
  // -------------------------------------------------------------------------

  /**
   * @returns {LocationResult|null}
   * @private
   */
  _resolveFromHA() {
    if (!this._hass) return null;

    // Source 1: HA system configuration (most reliable)
    const lat = this._hass.config?.latitude;
    const lon = this._hass.config?.longitude;
    if (_isValidCoord(lat, lon)) {
      console.info(`[NidaLocation] Layer 1 (HA config): ${lat}, ${lon}`);
      return this._buildResult(lat, lon, LOCATION_LAYER.HA, {
        timezone: this._hass.config?.time_zone || null,
      });
    }

    // Source 2: zone.home entity
    const zone = this._hass.states?.['zone.home'];
    if (zone) {
      const zLat = zone.attributes?.latitude;
      const zLon = zone.attributes?.longitude;
      if (_isValidCoord(zLat, zLon)) {
        console.info(`[NidaLocation] Layer 1 (zone.home): ${zLat}, ${zLon}`);
        return this._buildResult(zLat, zLon, LOCATION_LAYER.HA, {
          city: zone.attributes?.friendly_name || 'Home',
        });
      }
    }

    // Source 3: Nida-specific sensors (optional)
    const sLat = parseFloat(this._hass.states?.['sensor.nida_latitude']?.state);
    const sLon = parseFloat(this._hass.states?.['sensor.nida_longitude']?.state);
    if (_isValidCoord(sLat, sLon)) {
      console.info(`[NidaLocation] Layer 1 (sensor.nida_*): ${sLat}, ${sLon}`);
      return this._buildResult(sLat, sLon, LOCATION_LAYER.HA, {});
    }

    return null;
  }

  // -------------------------------------------------------------------------
  // LAYER 2 — GPS
  // -------------------------------------------------------------------------

  /**
   * @returns {Promise<LocationResult|null>}
   * @private
   */
  async _resolveFromGPS() {
    try {
      // Capacitor 8 native path (Android / iOS)
      if (typeof window !== 'undefined' && window.Capacitor?.isNativePlatform?.()) {
        return await this._resolveFromCapacitorGPS();
      }

      // Browser / Electron path
      if (typeof navigator === 'undefined' || !navigator.geolocation) {
        console.info('[NidaLocation] Layer 2 (GPS): navigator.geolocation not available');
        return null;
      }

      const position = await new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(
          resolve, reject,
          { enableHighAccuracy: GPS_HIGH_ACCURACY, timeout: GPS_TIMEOUT_MS, maximumAge: GPS_MAX_AGE_MS }
        );
      });

      const { latitude: lat, longitude: lon, accuracy } = position.coords;
      console.info(`[NidaLocation] Layer 2 (GPS): ${lat}, ${lon} (±${Math.round(accuracy)} m)`);
      return this._buildResult(lat, lon, LOCATION_LAYER.GPS, { accuracy: Math.round(accuracy) });

    } catch (err) {
      if (err.code === 1) {
        // PERMISSION_DENIED — mark so future calls skip GPS
        this._gpsDenied = true;
        console.info('[NidaLocation] Layer 2 (GPS): permission denied');
        // Return a special result so the UI can signal the denial to the user
        return this._buildResult(
          FALLBACK_LOCATION.lat, FALLBACK_LOCATION.lon, LOCATION_LAYER.GPS,
          { permissionDenied: true, isFallback: true }
        );
      }
      console.info(`[NidaLocation] Layer 2 (GPS): error (code=${err.code}) — ${err.message}`);
      return null;
    }
  }

  /**
   * GPS via Capacitor 8 @capacitor/geolocation plugin.
   * Dynamic import so the bundle does not break on non-Capacitor platforms.
   * @private
   */
  async _resolveFromCapacitorGPS() {
    try {
      const { Geolocation } = await import('@capacitor/geolocation');
      const perms = await Geolocation.requestPermissions();

      if (perms.location !== 'granted' && perms.coarseLocation !== 'granted') {
        this._gpsDenied = true;
        console.info('[NidaLocation] Layer 2 (Capacitor GPS): permission denied');
        return null;
      }

      const pos = await Geolocation.getCurrentPosition({
        enableHighAccuracy: GPS_HIGH_ACCURACY,
        timeout:    GPS_TIMEOUT_MS,
        maximumAge: GPS_MAX_AGE_MS,
      });

      const { latitude: lat, longitude: lon, accuracy } = pos.coords;
      console.info(`[NidaLocation] Layer 2 (Capacitor GPS): ${lat}, ${lon} (±${Math.round(accuracy)} m)`);
      return this._buildResult(lat, lon, LOCATION_LAYER.GPS, { accuracy: Math.round(accuracy) });

    } catch (err) {
      console.warn('[NidaLocation] Layer 2 (Capacitor GPS):', err.message);
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // LAYER 3 — IP GEOLOCATION
  // -------------------------------------------------------------------------

  /**
   * @returns {Promise<LocationResult|null>}
   * @private
   */
  async _resolveFromIP() {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), IP_TIMEOUT_MS);

    try {
      const res = await fetch(IP_GEO_URL, { signal: controller.signal });
      clearTimeout(tid);

      if (!res.ok) { console.warn(`[NidaLocation] Layer 3 (IP): HTTP ${res.status}`); return null; }

      const data = await res.json();
      if (data.status !== 'success' || !_isValidCoord(data.lat, data.lon)) {
        console.warn('[NidaLocation] Layer 3 (IP): invalid response', data.status);
        return null;
      }

      console.info(`[NidaLocation] Layer 3 (IP): ${data.lat}, ${data.lon} — ${data.city}`);
      return this._buildResult(data.lat, data.lon, LOCATION_LAYER.IP, {
        city: data.city, country: data.country, timezone: data.timezone,
      });

    } catch (err) {
      clearTimeout(tid);
      if (err.name === 'AbortError') console.warn('[NidaLocation] Layer 3 (IP): timeout');
      else console.warn('[NidaLocation] Layer 3 (IP):', err.message);
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // DRIFT DETECTION (internal)
  // -------------------------------------------------------------------------

  /**
   * Processes a new position from the GPS watcher.
   * Compares it with the cached location and decides on a drift action.
   *
   * Called by the watchPosition callback or interval polling.
   *
   * @param {number} lat - New latitude
   * @param {number} lon - New longitude
   * @private
   */
  _handleWatchPosition(lat, lon) {
    const current = this._locationCache?.result;

    // No location stored yet — save this as the first position
    if (!current) {
      const fresh = this._buildResult(lat, lon, LOCATION_LAYER.GPS, {});
      this._cacheAndReturn(fresh);
      this.onLocationUpdated?.(fresh);
      return;
    }

    // HA and manual layers are never overwritten by the GPS watchdog.
    // The user made a deliberate choice — we respect that.
    if (current.layer === LOCATION_LAYER.HA || current.layer === LOCATION_LAYER.MANUAL) {
      return;
    }

    const km = _haversine(current.lat, current.lon, lat, lon);

    // No significant displacement
    if (km < DRIFT_THRESHOLD_KM) return;

    // Debounce: do not notify more often than DRIFT_DEBOUNCE_MS
    const now = Date.now();
    if (now - this._lastDriftAt < DRIFT_DEBOUNCE_MS) return;
    this._lastDriftAt = now;

    // Build the fresh location object
    const fresh = this._buildResult(lat, lon, LOCATION_LAYER.GPS, {});

    if (km >= DRIFT_AUTO_UPDATE_KM) {
      // Large displacement: update automatically, inform the user
      console.info(`[NidaLocation] Watcher: drift ${km.toFixed(0)} km — auto-update`);
      this._cacheAndReturn(fresh);
      this._fireDriftEvent(current, fresh, km, true);
      this.onLocationUpdated?.(fresh);
    } else {
      // Medium displacement: subtle notification, user decides
      console.info(`[NidaLocation] Watcher: drift ${km.toFixed(1)} km — pending`);
      this._storePendingDrift(current, fresh, km);
    }
  }

  /**
   * Stores a pending drift and fires the onDrift event.
   * @private
   */
  _storePendingDrift(previous, current, distanceKm) {
    this._pendingDrift = { previous, current, distanceKm, autoUpdated: false, needsConfirm: true };
    this.onDrift?.(this._pendingDrift);
  }

  /**
   * Fires an informational drift event (already processed, no pending state).
   * @private
   */
  _fireDriftEvent(previous, current, distanceKm, autoUpdated) {
    this.onDrift?.({ previous, current, distanceKm, autoUpdated, needsConfirm: false });
  }

  /**
   * Returns true when a GPS refresh is available on this device/platform.
   * @returns {boolean}
   * @private
   */
  _canRefreshGPS() {
    if (this._gpsDenied) return false;
    if (typeof window !== 'undefined' && window.Capacitor?.isNativePlatform?.()) return true;
    if (typeof navigator !== 'undefined' && navigator.geolocation) return true;
    return false;
  }

  // -------------------------------------------------------------------------
  // PERSISTENCE
  // -------------------------------------------------------------------------

  /** @private */
  _loadManual() {
    try {
      const raw = localStorage.getItem(`${STORAGE_PREFIX}manual`);
      if (!raw) return null;
      const p = JSON.parse(raw);
      if (_isValidCoord(p.lat, p.lon)) return { lat: p.lat, lon: p.lon, city: p.city || '' };
    } catch (_) {}
    return null;
  }

  /** @private */
  _saveManual(m) {
    try { localStorage.setItem(`${STORAGE_PREFIX}manual`, JSON.stringify(m)); }
    catch (_) { console.warn('[NidaLocation] localStorage not available'); }
  }

  /** @private */
  _syncManualToHA(m) {
    if (!this._hass?.states?.['input_text.nida_location']) return;
    try {
      this._hass.callService('input_text', 'set_value', {
        entity_id: 'input_text.nida_location',
        value:     `${m.lat},${m.lon}`,
      });
    } catch (err) { console.warn('[NidaLocation] HA sync failed:', err.message); }
  }

  // -------------------------------------------------------------------------
  // HELPERS
  // -------------------------------------------------------------------------

  /**
   * Builds a normalised LocationResult object.
   * @private
   */
  _buildResult(lat, lon, layer, extras = {}) {
    return {
      lat:              parseFloat(Number(lat).toFixed(6)),
      lon:              parseFloat(Number(lon).toFixed(6)),
      city:             extras.city     || '',
      country:          extras.country  || '',
      timezone:         extras.timezone || null,
      accuracy:         extras.accuracy || null,
      layer,
      layerLabel:       LAYER_LABELS[layer]  || 'Unknown',
      layerIcon:        LAYER_ICONS[layer]   || '📍',
      isFallback:       extras.isFallback       || layer === LOCATION_LAYER.FALLBACK,
      permissionDenied: extras.permissionDenied || false,
      resolvedAt:       Date.now(),
    };
  }

  /** @private */
  _cacheAndReturn(result) {
    this._locationCache = { result, expiresAt: Date.now() + LOCATION_CACHE_TTL_MS };
    return result;
  }
}

// ---------------------------------------------------------------------------
// MODULE-LEVEL EXPORTS
// ---------------------------------------------------------------------------

/**
 * Calculates the shortest surface distance in km between two geo-coordinates
 * using the Haversine formula.
 *
 * Accuracy: ~0.5% (sufficient for drift detection at prayer-time granularity).
 * Altitude above sea level is ignored.
 *
 * @param   {number} lat1 - Latitude of point 1
 * @param   {number} lon1 - Longitude of point 1
 * @param   {number} lat2 - Latitude of point 2
 * @param   {number} lon2 - Longitude of point 2
 * @returns {number}      Distance in kilometres
 *
 * @example
 * haversine(52.37, 4.90, 51.92, 4.48) // Amsterdam → Rotterdam ≈ 57 km
 */
export function haversine(lat1, lon1, lat2, lon2) {
  return _haversine(lat1, lon1, lat2, lon2);
}

// Internal variant called by the class (avoids export overhead)
function _haversine(lat1, lon1, lat2, lon2) {
  const R    = 6371;                                             // Earth radius in km
  const dLat = _deg2rad(lat2 - lat1);
  const dLon = _deg2rad(lon2 - lon1);
  const a    =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(_deg2rad(lat1)) * Math.cos(_deg2rad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function _deg2rad(deg) { return deg * (Math.PI / 180); }

/**
 * Returns true when lat/lon form a valid coordinate pair.
 * Rejects (0, 0) — almost always a placeholder error.
 *
 * @param   {any} lat
 * @param   {any} lon
 * @returns {boolean}
 */
function _isValidCoord(lat, lon) {
  const a = Number(lat), b = Number(lon);
  return !isNaN(a) && !isNaN(b)
    && a >= -90  && a <= 90
    && b >= -180 && b <= 180
    && !(a === 0 && b === 0);
}

// ---------------------------------------------------------------------------
// SINGLETON EXPORT
// ---------------------------------------------------------------------------

/**
 * App-wide singleton NidaLocation instance.
 *
 * Minimal usage in a Lit component:
 * ```js
 * import { locator } from './nida-location.js';
 *
 * // In setConfig() / connectedCallback():
 * locator.setHass(this.hass);
 * locator.startWatching(); // Start the GPS watcher (on GPS-capable devices only)
 *
 * // Drift callback — drives the subtle UI banner:
 * locator.onDrift = ({ distanceKm, current, needsConfirm, autoUpdated }) => {
 *   if (autoUpdated) {
 *     // Show a brief toast: "Location updated to {current.city}"
 *   } else if (needsConfirm) {
 *     // Show a subtle banner: "You are {distanceKm} km from {current.city} — update?"
 *     // User taps banner  → locator.confirmDrift()
 *     // User taps ✕       → locator.dismissDrift()
 *   }
 * };
 *
 * // In disconnectedCallback():
 * locator.stopWatching();
 *
 * // Fetch display info for the location badge:
 * const info = locator.getDisplayInfo();
 * // → { label: 'Jakarta', icon: '📍', canRefresh: true, hasDrift: false, ... }
 * ```
 *
 * @type {NidaLocation}
 */
export const locator = new NidaLocation();
