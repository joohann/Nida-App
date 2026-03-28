/**
 * @file        nida-card.js
 * @module      NidaCard
 * @version     2.1.0
 * @since       2026-03-28
 * @description Nida v2 prayer-time card — Lit 3.x standalone web component.
 *
 * Renders a collapsible Islamic prayer-time card that works both as a
 * standalone web component (browser, Capacitor 8, Electron 40) and as a
 * Home Assistant Lovelace card.
 *
 * Dependencies (core/):
 *   - nida-engine.js  v2.0.0  — prayer time calculations & day-transition fix
 *   - nida-api.js     v2.0.0  — AlaDhan API v1 wrapper (MWL, method 3)
 *   - nida-location.js v2.1.0 — 5-layer location strategy + GPS drift detection
 *
 * Key features:
 *   - Collapsed-first on all platforms (restored from localStorage)
 *   - 10 UI languages: en, nl, ar, de, fr, id, ms, tr, ur, fa
 *   - Subtle GPS location badge with refresh button
 *   - Drift banner: slides in when the device moves > 5 km, auto-updates > 50 km
 *   - Data source priority: HA sensors → AlaDhan API
 *   - Ramadan bar, skip-suhoor button, Eid countdown
 *   - Flip animation for settings panel
 *   - 2-step intro overlay for first-time users
 *
 * Imports (browser/CDN):
 *   Replace the CDN URL with 'lit' when using a bundler (Vite, Rollup, etc.)
 *   For HA production: bundle with rollup -p @rollup/plugin-node-resolve
 *
 * DEVELOPER.md conventions:
 *   - Render helpers are prefixed _render*
 *   - Private state helpers are prefixed _
 *   - All section dividers use the ── style
 *   - Translations are keyed on the 2-letter language code
 *
 * @author  Nida v2 Team
 * @license MIT
 */

// ── IMPORTS ──────────────────────────────────────────────────────────────────
// Lit 3.3.2 — standalone CDN build (ESM, no bundler required)
// For bundled builds replace with: import { LitElement, html, css } from 'lit';
import { LitElement, html, css } from 'https://cdn.jsdelivr.net/npm/lit@3.3.2/+esm';

// Core modules — same directory structure on all platforms
import { engine, moonPhaseEmoji, _todayKey } from './core/nida-engine.js';
import { api }                                from './core/nida-api.js';
import { locator, LOCATION_LAYER }            from './core/nida-location.js';
import { notify }                             from './core/nida-notify.js';

// ── CONSTANTS: HIJRI MONTH NAMES ─────────────────────────────────────────────

/** Hijri month names per language. Index 0 = Muharram (month 1). */
const HIJRI_MONTHS = {
  ar: ['محرم','صفر','ربيع الأول','ربيع الآخر','جمادى الأولى','جمادى الآخرة','رجب','شعبان','رمضان','شوال','ذو القعدة','ذو الحجة'],
  ur: ['محرم','صفر','ربیع الاول','ربیع الثانی','جمادی الاول','جمادی الثانی','رجب','شعبان','رمضان','شوال','ذوالقعدہ','ذوالحجہ'],
  tr: ['Muharrem','Safer','Rebiülevvel','Rebiülahir','Cemaziyelevvel','Cemaziyelahir','Recep','Şaban','Ramazan','Şevval','Zilkade','Zilhicce'],
  fa: ['محرم','صفر','ربیع‌الاول','ربیع‌الثانی','جمادی‌الاول','جمادی‌الثانی','رجب','شعبان','رمضان','شوال','ذیقعده','ذیحجه'],
  // Latin transliteration used for all other languages
  _: ['Muḥarram','Ṣafar','Rabīʿ al-Awwal','Rabīʿ al-Ākhir','Jumādā al-Ūlā','Jumādā al-Ākhira','Rajab','Shaʿbān','Ramaḍān','Shawwāl','Dhū al-Qaʿda','Dhū al-Ḥijja'],
};

/** Returns the localised Hijri month name for a 1-based month number. */
function _hijriMonth(monthNum, lang) {
  const idx = (parseInt(monthNum, 10) || 1) - 1;
  return (HIJRI_MONTHS[lang] ?? HIJRI_MONTHS._)[idx] ?? '';
}

// ── CONSTANTS: TRANSLATIONS ───────────────────────────────────────────────────

/** Full UI string map for all 10 supported languages. */
const T = {
  en: { next:'Next Prayer', remaining:'Remaining', tadkir:'Pre-adhan', adhan:'Adhan', tarhim:'Tarhim', suhoor:'Suhoor', ramadan:'Ramadan', day:'Day', imsak:'Imsak', iftar:'Iftar', settings:'Settings', show_date:'Show date', language:'Language', no_action:'No action', theme:'Theme', brightness:'Brightness', close:'Close card', skip_suhoor:'Skip Suhoor', show_ramadan:'Show Ramadan bar', show_skip:'Show skip suhoor', location:'Location', refresh:'Refresh', update:'Update', dismiss:'Dismiss', moved:'You moved', km:'km', prayers:{ fajr:'Fajr', dhuhr:'Dhuhr', asr:'Asr', maghrib:'Maghrib', isha:'Isha' } },
  nl: { next:'Volgend Gebed', remaining:'Resterend', tadkir:'Pre-adhan', adhan:'Adhan', tarhim:'Tarhim', suhoor:'Suhoor', ramadan:'Ramadan', day:'Dag', imsak:'Imsak', iftar:'Iftar', settings:'Instellingen', show_date:'Toon datum', language:'Taal', no_action:'Geen actie', theme:'Thema', brightness:'Helderheid', close:'Kaart sluiten', skip_suhoor:'Suhoor overslaan', show_ramadan:'Toon Ramadan balk', show_skip:'Toon suhoor overslaan', location:'Locatie', refresh:'Vernieuwen', update:'Bijwerken', dismiss:'Negeren', moved:'Je bent', km:'km verplaatst', prayers:{ fajr:'Fajr', dhuhr:'Dhuhr', asr:'Asr', maghrib:'Maghrib', isha:'Isha' } },
  ar: { next:'الصلاة القادمة', remaining:'المتبقي', tadkir:'تذكير', adhan:'أذان', tarhim:'ترحيم', suhoor:'سحور', ramadan:'رمضان', day:'يوم', imsak:'إمساك', iftar:'إفطار', settings:'إعدادات', show_date:'إظهار التاريخ', language:'اللغة', no_action:'لا إجراء', theme:'المظهر', brightness:'السطوع', close:'إغلاق', skip_suhoor:'تخطي السحور', show_ramadan:'إظهار شريط رمضان', show_skip:'إظهار تخطي السحور', location:'الموقع', refresh:'تحديث', update:'تحديث', dismiss:'تجاهل', moved:'تنقلت', km:'كم', prayers:{ fajr:'الفجر', dhuhr:'الظهر', asr:'العصر', maghrib:'المغرب', isha:'العشاء' } },
  de: { next:'Nächstes Gebet', remaining:'Verbleibend', tadkir:'Vor-Adhan', adhan:'Adhan', tarhim:'Tarhim', suhoor:'Suhoor', ramadan:'Ramadan', day:'Tag', imsak:'Imsak', iftar:'Iftar', settings:'Einstellungen', show_date:'Datum anzeigen', language:'Sprache', no_action:'Keine Aktion', theme:'Design', brightness:'Helligkeit', close:'Karte schließen', skip_suhoor:'Suhoor überspringen', show_ramadan:'Ramadan-Leiste', show_skip:'Suhoor-Skip anzeigen', location:'Standort', refresh:'Aktualisieren', update:'Aktualisieren', dismiss:'Ignorieren', moved:'Bewegt', km:'km', prayers:{ fajr:'Fajr', dhuhr:'Dhuhr', asr:'Asr', maghrib:'Maghrib', isha:'Isha' } },
  fr: { next:'Prochaine Prière', remaining:'Restant', tadkir:'Pré-adhan', adhan:'Adhan', tarhim:'Tarhim', suhoor:'Suhour', ramadan:'Ramadan', day:'Jour', imsak:'Imsak', iftar:'Iftar', settings:'Paramètres', show_date:'Afficher date', language:'Langue', no_action:'Aucune action', theme:'Thème', brightness:'Luminosité', close:'Fermer', skip_suhoor:'Ignorer Suhour', show_ramadan:'Barre Ramadan', show_skip:'Afficher ignorer', location:'Lieu', refresh:'Actualiser', update:'Mettre à jour', dismiss:'Ignorer', moved:'Déplacé de', km:'km', prayers:{ fajr:'Fajr', dhuhr:'Dhuhr', asr:'Asr', maghrib:'Maghrib', isha:'Isha' } },
  id: { next:'Sholat Berikutnya', remaining:'Tersisa', tadkir:'Pra-adzan', adhan:'Adzan', tarhim:'Tarhim', suhoor:'Sahur', ramadan:'Ramadan', day:'Hari', imsak:'Imsak', iftar:'Iftar', settings:'Pengaturan', show_date:'Tampilkan tanggal', language:'Bahasa', no_action:'Tidak ada', theme:'Tema', brightness:'Kecerahan', close:'Tutup kartu', skip_suhoor:'Lewati Sahur', show_ramadan:'Bilah Ramadan', show_skip:'Tampilkan lewati', location:'Lokasi', refresh:'Perbarui', update:'Perbarui', dismiss:'Abaikan', moved:'Bergerak', km:'km', prayers:{ fajr:'Subuh', dhuhr:'Dzuhur', asr:'Ashar', maghrib:'Maghrib', isha:'Isya' } },
  ms: { next:'Solat Seterusnya', remaining:'Baki', tadkir:'Pra-azan', adhan:'Azan', tarhim:'Tarhim', suhoor:'Sahur', ramadan:'Ramadan', day:'Hari', imsak:'Imsak', iftar:'Iftar', settings:'Tetapan', show_date:'Tunjuk tarikh', language:'Bahasa', no_action:'Tiada', theme:'Tema', brightness:'Kecerahan', close:'Tutup kad', skip_suhoor:'Langkau Sahur', show_ramadan:'Bar Ramadan', show_skip:'Tunjuk langkau', location:'Lokasi', refresh:'Muat semula', update:'Kemas kini', dismiss:'Abaikan', moved:'Bergerak', km:'km', prayers:{ fajr:'Subuh', dhuhr:'Zohor', asr:'Asar', maghrib:'Maghrib', isha:'Isyak' } },
  tr: { next:'Sonraki Namaz', remaining:'Kalan', tadkir:'Ezan Öncesi', adhan:'Ezan', tarhim:'Terhim', suhoor:'Sahur', ramadan:'Ramazan', day:'Gün', imsak:'İmsak', iftar:'İftar', settings:'Ayarlar', show_date:'Tarihi göster', language:'Dil', no_action:'İşlem yok', theme:'Tema', brightness:'Parlaklık', close:'Kartı kapat', skip_suhoor:'Sahuru Atla', show_ramadan:'Ramazan çubuğu', show_skip:'Atla göster', location:'Konum', refresh:'Yenile', update:'Güncelle', dismiss:'Yoksay', moved:'Hareket ettiniz', km:'km', prayers:{ fajr:'Sabah', dhuhr:'Öğle', asr:'İkindi', maghrib:'Akşam', isha:'Yatsı' } },
  ur: { next:'اگلی نماز', remaining:'باقی', tadkir:'پیشِ اذان', adhan:'اذان', tarhim:'ترحیم', suhoor:'سحری', ramadan:'رمضان', day:'دن', imsak:'امساک', iftar:'افطار', settings:'ترتیبات', show_date:'تاریخ دکھائیں', language:'زبان', no_action:'کوئی عمل نہیں', theme:'تھیم', brightness:'روشنی', close:'بند کریں', skip_suhoor:'سحری چھوڑیں', show_ramadan:'رمضان بار', show_skip:'چھوڑیں دکھائیں', location:'مقام', refresh:'تازہ کریں', update:'اپ ڈیٹ', dismiss:'نظرانداز', moved:'منتقل', km:'کلومیٹر', prayers:{ fajr:'فجر', dhuhr:'ظہر', asr:'عصر', maghrib:'مغرب', isha:'عشاء' } },
  fa: { next:'نماز بعدی', remaining:'باقی‌مانده', tadkir:'پیش از اذان', adhan:'اذان', tarhim:'ترحیم', suhoor:'سحر', ramadan:'رمضان', day:'روز', imsak:'امساک', iftar:'افطار', settings:'تنظیمات', show_date:'نمایش تاریخ', language:'زبان', no_action:'هیچ عملی', theme:'پوسته', brightness:'روشنایی', close:'بستن', skip_suhoor:'رد کردن سحر', show_ramadan:'نوار رمضان', show_skip:'نمایش رد کردن', location:'مکان', refresh:'بازخوانی', update:'به‌روزرسانی', dismiss:'نادیده', moved:'جابجا شدید', km:'کیلومتر', prayers:{ fajr:'صبح', dhuhr:'ظهر', asr:'عصر', maghrib:'مغرب', isha:'عشاء' } },
};

/** Intro overlay translations (2-step onboarding). */
const INTRO = {
  en: { t1:'Tap to collapse', b1:'Tap the top section to hide prayer times.', btn1:'Show me ▶', skip:'skip', t2:'Settings', b2:'Tap the gear icon to adjust language, theme and brightness.', btn2:'Got it ✓' },
  nl: { t1:'Tik om in te klappen', b1:'Tik op het bovenste vlak om gebedstijden te verbergen.', btn1:'Laat zien ▶', skip:'overslaan', t2:'Instellingen', b2:'Tik op het tandwiel voor taal, thema en helderheid.', btn2:'Begrepen ✓' },
  ar: { t1:'اضغط للطي', b1:'اضغط على الجزء العلوي لإخفاء أوقات الصلاة.', btn1:'أرني ▶', skip:'تخطي', t2:'الإعدادات', b2:'اضغط على أيقونة الترس لضبط اللغة والمظهر.', btn2:'فهمت ✓' },
  de: { t1:'Tippen zum Einklappen', b1:'Tippe auf den oberen Bereich, um die Gebetszeiten auszublenden.', btn1:'Zeig mir ▶', skip:'überspringen', t2:'Einstellungen', b2:'Tippe auf das Zahnrad-Symbol für Sprache, Design und Helligkeit.', btn2:'Verstanden ✓' },
  fr: { t1:'Appuyez pour réduire', b1:'Appuyez sur la section supérieure pour masquer les prières.', btn1:'Montrer ▶', skip:'passer', t2:'Paramètres', b2:"Appuyez sur l'engrenage pour régler la langue et le thème.", btn2:'Compris ✓' },
  id: { t1:'Ketuk untuk menyembunyikan', b1:'Ketuk bagian atas untuk menyembunyikan waktu sholat.', btn1:'Tunjukkan ▶', skip:'lewati', t2:'Pengaturan', b2:'Ketuk ikon roda gigi untuk bahasa, tema, dan kecerahan.', btn2:'Mengerti ✓' },
  ms: { t1:'Ketik untuk lipat', b1:'Ketik bahagian atas untuk menyembunyikan waktu solat.', btn1:'Tunjuk ▶', skip:'langkau', t2:'Tetapan', b2:'Ketik ikon gear untuk bahasa, tema dan kecerahan.', btn2:'Faham ✓' },
  tr: { t1:'Katlamak için dokun', b1:'Namaz vakitlerini gizlemek için üst bölüme dokun.', btn1:'Göster ▶', skip:'atla', t2:'Ayarlar', b2:'Dil, tema ve parlaklık için dişli simgesine dokun.', btn2:'Anladım ✓' },
  ur: { t1:'تہ کرنے کے لیے ٹیپ کریں', b1:'نماز کے اوقات چھپانے کے لیے اوپری حصے پر ٹیپ کریں۔', btn1:'دکھائیں ▶', skip:'چھوڑیں', t2:'ترتیبات', b2:'زبان اور تھیم کے لیے گیئر آئیکن ٹیپ کریں۔', btn2:'سمجھ گیا ✓' },
  fa: { t1:'برای جمع کردن ضربه بزنید', b1:'برای پنهان کردن اوقات نماز روی بخش بالایی ضربه بزنید.', btn1:'نشان بده ▶', skip:'رد شدن', t2:'تنظیمات', b2:'برای زبان و پوسته روی چرخ‌دنده ضربه بزنید.', btn2:'فهمیدم ✓' },
};

/** Language label map (code → native name) */
const LANG_LABELS = {
  nl:'Nederlands', en:'English', ar:'العربية', de:'Deutsch',
  fr:'Français', id:'Indonesia', ms:'Melayu', tr:'Türkçe', ur:'اردو', fa:'فارسی',
};

/** Languages that use right-to-left text direction. */
const RTL = new Set(['ar', 'ur', 'fa']);

// ── TRANSLATION HELPERS ───────────────────────────────────────────────────────

/** Returns a top-level translation string for the current language. */
const t  = (lang, key) => (T[lang] ?? T.en)[key]        ?? (T.en[key] ?? key);
/** Returns a prayer name translation. */
const tp = (lang, key) => (T[lang] ?? T.en).prayers?.[key] ?? key;
/** Returns an intro overlay string. */
const ti = (lang, key) => (INTRO[lang] ?? INTRO.en)[key] ?? (INTRO.en[key] ?? '');

// ── NIGHT KEY HELPER ──────────────────────────────────────────────────────────

/**
 * Returns a date key for the current Isha-to-Fajr night window.
 * Resets after noon so "skip suhoor" only persists for one night.
 */
function _nightKey() {
  const d = new Date();
  if (d.getHours() < 12) d.setDate(d.getDate() - 1);
  return `nida-skip-${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

// ── MAIN CLASS ────────────────────────────────────────────────────────────────

/**
 * @class NidaCard
 * @extends LitElement
 *
 * Nida v2 prayer-time web component.
 *
 * Usage as standalone:
 * ```html
 * <nida-card language="en" theme="dark"></nida-card>
 * ```
 *
 * Usage as HA Lovelace card:
 * ```yaml
 * type: custom:nida-card
 * language: en
 * theme: auto
 * ```
 */
export class NidaCard extends LitElement {

  // ── SHADOW DOM ─────────────────────────────────────────────────────────────

  createRenderRoot() {
    return this.attachShadow({ mode: 'open', delegatesFocus: true });
  }

  // ── REACTIVE PROPERTIES ────────────────────────────────────────────────────

  static get properties() {
    return {
      hass:              {},            // Home Assistant hass object (injected by HA)
      _config:           {},
      _dark:             { type: Boolean },
      _flipped:          { type: Boolean },
      _collapsed:        { type: Boolean },
      _lang:             { type: String  },
      _theme:            { type: String  },
      _brightness:       { type: Number  },
      _showTitle:        { type: Boolean },
      _skipSuhoor:       { type: Boolean },
      _showRamadanBar:   { type: Boolean },
      _showSkipBtn:      { type: Boolean },
      _introStep:        { type: Number  },
      _locationInfo:     { type: Object  }, // LocationDisplayInfo from locator
      _pendingDrift:     { type: Object  }, // DriftEvent | null
      _dataLoaded:       { type: Boolean }, // True once engine has been loaded with times
    };
  }

  // ── CONFIGURATION ──────────────────────────────────────────────────────────

  /**
   * Called by HA when the card config is set, and also usable standalone
   * by setting the `config` attribute or calling this method directly.
   *
   * @param {object} config - Card configuration object
   */
  setConfig(config) {
    this._config        = config;
    this._theme         = config.theme      || 'auto';
    this._showTitle     = config.show_date  !== false;
    this._brightness    = config.brightness !== undefined ? config.brightness : 50;
    this._lang          = config.language   || null;
    this._showRamadanBar = config.show_ramadan !== false;
    this._showSkipBtn   = config.show_skip  !== false;
    this._flipped       = false;

    // Restore collapsed state (default: true = collapsed)
    const saved = localStorage.getItem('nida-collapsed');
    this._collapsed = saved !== null ? saved === 'true' : true;

    // Restore suhoor-skip for tonight
    this._skipSuhoor = localStorage.getItem(_nightKey()) === 'true';

    // Intro overlay: show on first visit
    this._introStep = localStorage.getItem('nida-intro-seen') ? 0 : 1;
  }

  /**
   * HA property setter — called whenever the HA state changes.
   * Extracts prayer times from HA sensors and loads them into the engine.
   */
  set hass(value) {
    this.hass = value; // eslint-disable-line no-setter-return
    locator.setHass(value);
    this._loadFromHA(value);
    // Keep the notify singleton in sync: hass and isRamadan may have changed.
    notify.updateOpts({ hass: value, isRamadan: this._isRamadan() });
    this.requestUpdate();
  }

  // ── LIFECYCLE ──────────────────────────────────────────────────────────────

  connectedCallback() {
    super.connectedCallback();

    // Ensure keyboard-focusable for TV / Fully Browser
    if (!this.hasAttribute('tabindex')) this.setAttribute('tabindex', '0');
    this._hostKeydown = (e) => {
      if (e.key === 'Enter' && e.target === this) {
        const first = this.shadowRoot?.querySelector('[tabindex="0"], button, select');
        if (first) { e.preventDefault(); first.focus(); }
      }
    };
    this.addEventListener('keydown', this._hostKeydown);

    // 1-second tick for live countdown
    this._tick = setInterval(() => this.requestUpdate(), 1000);

    // Theme detection
    this._applyTheme();
    this._themeObs = new MutationObserver(() => this._applyTheme());
    this._themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['style','class'] });

    // Initialize language if not yet set
    if (!this._lang) this._lang = this._detectLang();

    // Location & API data — async boot sequence
    this._bootData();

    // GPS drift callback — drives the drift banner
    locator.onDrift = (event) => {
      if (event.needsConfirm) {
        this._pendingDrift = event;
      } else {
        // Auto-updated: briefly show a toast-style indicator
        this._pendingDrift = null;
      }
      this._locationInfo = locator.getDisplayInfo();
      this.requestUpdate();
    };

    locator.onLocationUpdated = () => {
      this._locationInfo = locator.getDisplayInfo();
      this.requestUpdate();
      // Re-fetch prayer times for the new location
      this._fetchFromAPI();
    };

    // Start GPS background watcher (no-op when GPS not available)
    locator.startWatching();

    // ── Notification pipeline ─────────────────────────────────────────────
    // Wire the callback before start() so no fired event is ever missed.
    notify.onFired = (action) => this._onNotifyFired(action);

    notify.start({
      hass:       this.hass,
      skipSuhoor: this._skipSuhoor,
      isRamadan:  this._isRamadan(),
      lang:       this._lang ?? 'en',
    });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    clearInterval(this._tick);
    this._themeObs?.disconnect();
    this.removeEventListener('keydown', this._hostKeydown);
    locator.stopWatching();
    locator.onDrift = null;
    locator.onLocationUpdated = null;
    notify.stop();
    notify.onFired = null;
  }

  // ── DATA LOADING ───────────────────────────────────────────────────────────

  /**
   * Boot sequence: resolve location → load data from HA or API.
   * @private
   */
  async _bootData() {
    // Resolve location (uses 5-layer strategy, quick when HA is available)
    await locator.resolveLocation();
    this._locationInfo = locator.getDisplayInfo();
    this.requestUpdate();

    // If HA sensors are available they were already loaded in set hass().
    // Otherwise fetch from the AlaDhan API.
    if (!this._dataLoaded) {
      await this._fetchFromAPI();
    }
  }

  /**
   * Reads prayer times from HA sensor entities and loads them into the engine.
   * HA sensor naming convention used by the Nida HA integration:
   *   sensor.01_imsak_readable, sensor.02_fajr_readable, ... sensor.08_isha_readable
   *
   * @param {object} hass - HA hass object
   * @private
   */
  _loadFromHA(hass) {
    if (!hass) return;

    const s = (entity) => hass.states?.[entity]?.state;

    const timings = {
      imsak:   s('sensor.01_imsak_readable'),
      fajr:    s('sensor.02_fajr_readable'),
      dhuhr:   s('sensor.04_dhuhr_readable'),
      asr:     s('sensor.05_asr_readable'),
      maghrib: s('sensor.07_maghrib_readable'),
      isha:    s('sensor.08_isha_readable'),
    };

    // Only load when all five prayer times are available and valid
    const valid = ['fajr','dhuhr','asr','maghrib','isha']
      .every(k => timings[k] && timings[k] !== 'unavailable');

    if (valid) {
      engine.loadTimes(timings, _todayKey());
      this._dataLoaded = true;
    }
  }

  /**
   * Fetches prayer times from the AlaDhan API for the resolved location.
   * Used when HA sensors are not available (standalone mode).
   * @private
   */
  async _fetchFromAPI() {
    const loc = await locator.resolveLocation();
    if (!loc) return;

    const timings = await api.getTimings({ lat: loc.lat, lon: loc.lon });
    if (timings) {
      engine.loadTimes(timings, _todayKey());
      this._dataLoaded = true;
      this.requestUpdate();
    }
  }

  // ── THEME ──────────────────────────────────────────────────────────────────

  /**
   * Determines dark/light mode from config, system preference, or HA theme.
   * @private
   */
  _applyTheme() {
    if (this._theme === 'dark')  { this._dark = true;  return; }
    if (this._theme === 'light') { this._dark = false; return; }

    // Auto: read HA background colour variable
    const bg = getComputedStyle(document.documentElement)
      .getPropertyValue('--primary-background-color').trim();
    if (bg) {
      let r, g, b;
      if (bg.startsWith('#')) {
        const h = bg.replace('#','');
        r = parseInt(h.slice(0,2),16); g = parseInt(h.slice(2,4),16); b = parseInt(h.slice(4,6),16);
      } else {
        const m = bg.match(/\d+/g);
        if (m?.length >= 3) { r = +m[0]; g = +m[1]; b = +m[2]; }
      }
      if (r !== undefined) {
        this._dark = (r*299 + g*587 + b*114) / 1000 < 128;
        return;
      }
    }
    this._dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  // ── LANGUAGE DETECTION ─────────────────────────────────────────────────────

  /** @private */
  _detectLang() {
    if (this._config?.language) return this._config.language;
    // Map browser language to supported language code
    const br = navigator.language?.split('-')[0] || 'en';
    return LANG_LABELS[br] ? br : 'en';
  }

  // ── HA STATE HELPERS ───────────────────────────────────────────────────────

  /** @private */
  _s(entity)       { return this.hass?.states?.[entity]?.state; }
  /** @private */
  _a(entity, attr) { return this.hass?.states?.[entity]?.attributes?.[attr]; }

  // ── INTERACTION HANDLERS ───────────────────────────────────────────────────

  /** Toggle the collapsible prayer list. @private */
  _toggleCollapse(e) {
    e.stopPropagation();
    this._collapsed = !this._collapsed;
    localStorage.setItem('nida-collapsed', String(this._collapsed));
  }

  /** Toggle skip-suhoor for tonight. @private */
  _toggleSkipSuhoor(e) {
    e.stopPropagation();
    this._skipSuhoor = !this._skipSuhoor;
    localStorage.setItem(_nightKey(), String(this._skipSuhoor));
    // Hot-update the notify singleton — no restart required.
    notify.setSkipSuhoor(this._skipSuhoor);
    // Sync to HA input_boolean if it exists
    if (this.hass?.states?.['input_boolean.nida_skip_suhoor'] !== undefined) {
      this.hass.callService('input_boolean', this._skipSuhoor ? 'turn_on' : 'turn_off',
        { entity_id: 'input_boolean.nida_skip_suhoor' });
    }
  }

  /** Flip to settings panel. @private */
  _openSettings(e) { e.stopPropagation(); this._flipped = true; }

  /** Flip back from settings. @private */
  _closeSettings() { this._flipped = false; }

  /** Handle GPS refresh button tap. @private */
  async _handleRefreshGPS(e) {
    e.stopPropagation();
    await locator.refreshGPS();
    this._locationInfo = locator.getDisplayInfo();
    this.requestUpdate();
  }

  /** User taps "Update" on the drift banner. @private */
  _confirmDrift(e) {
    e.stopPropagation();
    locator.confirmDrift();
    this._pendingDrift = null;
    this._locationInfo = locator.getDisplayInfo();
  }

  /** User taps "Dismiss" on the drift banner. @private */
  _dismissDrift(e) {
    e.stopPropagation();
    locator.dismissDrift();
    this._pendingDrift = null;
  }

  // ── STATE HELPERS ──────────────────────────────────────────────────────────

  /** Returns true when Ramadan binary sensor is on. @private */
  _isRamadan() {
    return this._s('binary_sensor.is_ramadan') === 'on'
        || this._s('sensor.is_ramadan')        === 'on';
  }

  /**
   * Calculates upcoming Eid from the Hijri calendar.
   * @returns {{ name: string, days: number, emoji: string, today?: boolean }|null}
   * @private
   */
  _eid() {
    const mo = parseInt(this._s('sensor.hijri_month') || 0, 10);
    const dy = parseInt(this._s('sensor.hijri_day')   || 0, 10);
    if (!mo || !dy) return null;
    if (mo === 9)              return { name:'Eid al-Fitr',  days: 30-dy,    emoji:'🌙' };
    if (mo === 10 && dy <= 3)  return { name:'Eid al-Fitr',  days: 0,        emoji:'🌙', today:true };
    if (mo === 12 && dy < 10)  return { name:'Eid al-Adha',  days: 10-dy,    emoji:'🐑' };
    if (mo === 12 && dy <= 13) return { name:'Eid al-Adha',  days: 0,        emoji:'🐑', today:true };
    if (mo === 11) { const d = 30-dy+10; if (d <= 30) return { name:'Eid al-Adha', days: d, emoji:'🐑' }; }
    return null;
  }

  /** Returns a gradient CSS value based on brightness and dark/light mode. @private */
  _bg() {
    const b = this._brightness / 100;
    if (this._dark) {
      const v = Math.round(b * 35);
      return `linear-gradient(160deg,rgb(${v},${Math.round(v*1.15)},${Math.round(v*1.3)}) 0%,rgb(${Math.round(v*0.7)},${Math.round(v*0.8)},${Math.round(v*0.95)}) 100%)`;
    }
    const base = Math.round(210 + b * 45);
    return `linear-gradient(160deg,rgb(${base},${Math.round(base*0.97)},${Math.round(base*0.88)}) 0%,rgb(${Math.round(base*0.96)},${Math.round(base*0.93)},${Math.round(base*0.83)}) 100%)`;
  }

  // ── RENDER ─────────────────────────────────────────────────────────────────

  render() {
    // Ensure config exists (standalone usage without setConfig)
    if (!this._config) this.setConfig({});
    if (!this._lang)   this._lang = this._detectLang();

    const lang      = this._lang;
    const isRtl     = RTL.has(lang);
    const themeClass = this._dark ? 'dark' : 'light';
    const isRamadan = this._isRamadan();
    const eid       = this._eid();
    const info      = this._locationInfo || locator.getDisplayInfo();

    return html`
      <link href="https://fonts.googleapis.com/css2?family=Amiri:wght@400;700&family=Cairo:wght@300;400;600;700;800&display=swap" rel="stylesheet">
      <div class="flip-container" style="position:relative;">
        <div class="flipper ${this._flipped ? 'flipped' : ''}">
          ${this._renderFront(lang, isRtl, themeClass, isRamadan, eid, info)}
          ${this._renderBack(lang)}
        </div>
        ${this._introStep > 0 ? this._renderIntro(lang) : ''}
      </div>`;
  }

  // ── FRONT FACE ─────────────────────────────────────────────────────────────

  /** @private */
  _renderFront(lang, isRtl, themeClass, isRamadan, eid, info) {
    const next      = engine.getNextPrayer();
    const countdown = engine.getCountdown();
    const progress  = engine.getProgress();
    const prayers   = engine.getPrayerList();
    const action    = engine.getNextAction({
      isRamadan,
      skipSuhoor:    this._skipSuhoor,
      tarhimMinutes: this._s('sensor.nida_tarhim_readable')
        ? this._parseReadable('sensor.nida_tarhim_readable') : null,
      suhoorMinutes: this._s('sensor.nida_suhoor_readable')
        ? this._parseReadable('sensor.nida_suhoor_readable') : null,
    });

    const hijriDay      = this._s('sensor.hijri_day')   || '—';
    const hijriMonthNum = this._s('sensor.hijri_month') || '1';
    const hijriYear     = this._s('sensor.hijri_year')  || '';
    const holiday       = this._s('sensor.islamic_holiday_today');
    const holidayName   = this._a('sensor.islamic_holiday_today', 'holiday_name');
    const moon          = moonPhaseEmoji(parseInt(hijriDay, 10) || 15);

    const nextName = next ? tp(lang, next.key) : '—';
    const cd       = countdown?.formatted ?? '--:--';

    return html`
      <div class="face front">
        <div class="card ${themeClass} ${isRtl ? 'rtl' : ''}"
             style="background:${this._bg()};">

          <!-- ── HEADER BLOCK (tap to collapse) ──────────────────────────── -->
          <div class="header-block"
               tabindex="1"
               @click=${this._toggleCollapse}
               @keydown=${(e) => { if (e.key==='Enter'||e.key===' ') { e.preventDefault(); this._toggleCollapse(e); } }}>

            <div class="next-block">
              <div class="next-inner">
                <div class="next-icon">🕌</div>
                <div class="next-text">
                  <span class="next-label">${t(lang, 'next')}</span>
                  <span class="next-name">${nextName}</span>
                </div>
                <div class="next-right">
                  <span class="cd-label">${t(lang, 'remaining')}</span>
                  <span class="cd">${cd}</span>
                </div>
              </div>

              <!-- Hijri date + location badge -->
              ${this._showTitle ? html`
                <div class="date-row">
                  <span>${moon}</span>
                  <span>${hijriDay} ${_hijriMonth(hijriMonthNum, lang)} ${hijriYear}</span>
                  ${holiday === 'on' && holidayName
                    ? html`<span class="sep">·</span><span class="holiday-badge">✨ ${holidayName}</span>`
                    : ''}
                  ${this._renderLocationBadge(lang, info)}
                </div>` : ''}
            </div>

            <!-- Progress bar -->
            <div class="progress-bar">
              <div class="progress-fill" style="width:${progress}%"></div>
            </div>

          </div><!-- /header-block -->

          <!-- ── DRIFT BANNER ────────────────────────────────────────────── -->
          ${this._pendingDrift ? this._renderDriftBanner(lang) : ''}

          <!-- ── COLLAPSIBLE PRAYER LIST ─────────────────────────────────── -->
          <div class="prayers-wrapper ${this._collapsed ? 'collapsed' : ''}">
            <div class="prayers-inner">
              <div class="prayers">

                <!-- Ramadan bar (full-width row) -->
                ${isRamadan && this._showRamadanBar ? this._renderRamadanBar(lang) : ''}

                <!-- Dynamic slot: Ramadan action / Eid / next notification -->
                ${this._renderDynamicSlot(lang, isRamadan, eid, action)}

                <!-- Five daily prayers -->
                ${prayers.map((p, i) => this._renderPrayerItem(p, lang, i === prayers.length - 1))}

              </div><!-- /prayers -->

              <!-- Skip suhoor button -->
              ${this._renderSkipSuhoor(lang, isRamadan)}

            </div><!-- /prayers-inner -->
          </div><!-- /prayers-wrapper -->

        </div><!-- /card -->
      </div><!-- /face.front -->`;
  }

  // ── LOCATION BADGE ─────────────────────────────────────────────────────────

  /**
   * Renders a subtle inline location pill next to the Hijri date.
   * Shows city name (or coordinates) + layer icon + optional refresh button.
   * A small orange dot indicates a pending drift.
   *
   * @private
   */
  _renderLocationBadge(lang, info) {
    if (!info) return '';

    return html`
      <span class="loc-badge ${info.isFallback ? 'fallback' : ''}">
        <span class="loc-icon">${info.icon}</span>
        <span class="loc-label">${info.label}</span>
        ${info.hasDrift ? html`<span class="drift-dot" title="${info.driftKm} km"></span>` : ''}
        ${info.canRefresh ? html`
          <button class="loc-refresh"
                  title="${t(lang,'refresh')}"
                  @click=${this._handleRefreshGPS}>↺</button>` : ''}
      </span>`;
  }

  // ── DRIFT BANNER ───────────────────────────────────────────────────────────

  /**
   * Renders the animated drift confirmation banner.
   * Slides in between header-block and prayer list when a drift is pending.
   *
   * @private
   */
  _renderDriftBanner(lang) {
    const drift = this._pendingDrift;
    const city  = drift?.current?.city || '';
    const km    = drift ? Math.round(drift.distanceKm) : 0;

    return html`
      <div class="drift-banner">
        <div class="drift-text">
          <span class="drift-icon">📍</span>
          <span>${t(lang,'moved')} <strong>${km} ${t(lang,'km')}</strong>${city ? ` — ${city}` : ''}</span>
        </div>
        <div class="drift-actions">
          <button class="drift-btn confirm"
                  @click=${this._confirmDrift}>${t(lang,'update')}</button>
          <button class="drift-btn dismiss"
                  @click=${this._dismissDrift}>✕</button>
        </div>
      </div>`;
  }

  // ── PRAYER ITEM ────────────────────────────────────────────────────────────

  /** @private */
  _renderPrayerItem(p, lang, isLast) {
    return html`
      <div class="prayer-item ${p.isActive ? 'active' : p.isPast ? 'past' : ''}"
           data-prayer="${p.key}">
        <div class="prayer-emoji">${p.icon}</div>
        <div class="prayer-name">${tp(lang, p.key)}</div>
        <div class="prayer-time">${p.displayTime}</div>
        ${isLast ? html`
          <button class="gear-btn" tabindex="3" @click=${this._openSettings}>⚙</button>` : ''}
      </div>`;
  }

  // ── DYNAMIC SLOT ───────────────────────────────────────────────────────────

  /** @private */
  _renderDynamicSlot(lang, isRamadan, eid, action) {
    // Action label builder
    const actionLabel = (a) => {
      if (!a) return '';
      if (a.type === 'tadkir') return `${t(lang,'tadkir')} ${tp(lang, a.prayerKey)}`;
      if (a.type === 'adhan')  return `${t(lang,'adhan')} ${tp(lang, a.prayerKey)}`;
      if (a.type === 'tarhim') return t(lang,'tarhim');
      if (a.type === 'suhoor') return t(lang,'suhoor');
      return '';
    };

    if (isRamadan) {
      return html`
        <div class="dynamic-slot ramadan-slot">
          <div class="prayer-emoji">🌙</div>
          ${action ? html`
            <div class="prayer-name">${actionLabel(action)}</div>
            <div class="prayer-time">${action.displayTime}</div>` : html`
            <div class="prayer-name">${t(lang,'ramadan')} ${t(lang,'day')} ${this._a('sensor.is_ramadan','ramadan_day') || '—'}</div>`}
        </div>`;
    }

    if (eid?.today) {
      return html`
        <div class="dynamic-slot eid-slot">
          <div class="prayer-emoji">${eid.emoji}</div>
          <div class="prayer-name">${eid.name}</div>
          <div class="prayer-time" style="font-size:18px;">Mubarak! 🎉</div>
        </div>`;
    }

    if (eid && eid.days <= 30) {
      return html`
        <div class="dynamic-slot eid-soon-slot">
          <div class="prayer-emoji">${eid.emoji}</div>
          <div class="prayer-name">${eid.name}</div>
          <div class="prayer-time">${eid.days}</div>
        </div>`;
    }

    return html`
      <div class="dynamic-slot default-slot">
        <div class="prayer-emoji">🔔</div>
        ${action ? html`
          <div class="prayer-name">${actionLabel(action)}</div>
          <div class="prayer-time">${action.displayTime}</div>` : html`
          <div class="prayer-name">${t(lang,'no_action')}</div>`}
      </div>`;
  }

  // ── RAMADAN BAR ────────────────────────────────────────────────────────────

  /** @private */
  _renderRamadanBar(lang) {
    const cd = engine.getIftarCountdown();
    const maghrib = this._s('sensor.07_maghrib_readable') || '—';
    const imsak   = this._s('sensor.01_imsak_readable')   || '—';
    const ramDay  = this._a('sensor.is_ramadan','ramadan_day') || '—';

    return html`
      <div class="ramadan-bar-row">
        <div class="rbar-seg rbar-day">
          <div class="rbar-val">${ramDay}</div>
          <div class="rbar-lbl">${t(lang,'ramadan')}</div>
        </div>
        <div class="rbar-div"></div>
        <div class="rbar-seg">
          <div class="rbar-val">${imsak}</div>
          <div class="rbar-lbl">${t(lang,'imsak')}</div>
        </div>
        <div class="rbar-div"></div>
        <div class="rbar-seg">
          <div class="rbar-val">${maghrib}</div>
          <div class="rbar-lbl">${t(lang,'iftar')}</div>
        </div>
        <div class="rbar-div"></div>
        <div class="rbar-seg">
          <div class="rbar-val">${cd?.formatted || '—'}</div>
          <div class="rbar-lbl">${cd?.isPast ? '✓' : t(lang,'iftar')}</div>
        </div>
      </div>`;
  }

  // ── SKIP SUHOOR ────────────────────────────────────────────────────────────

  /** @private */
  _renderSkipSuhoor(lang, isRamadan) {
    const imsakAvail = this._s('sensor.01_imsak_readable');
    if (!this._showSkipBtn || (!isRamadan && !imsakAvail)) return '';

    return html`
      <div class="skip-suhoor-bar">
        <button class="skip-suhoor-btn ${this._skipSuhoor ? 'active' : 'inactive'}"
                tabindex="2"
                @click=${this._toggleSkipSuhoor}>
          ${this._skipSuhoor ? '✓' : '😴'}
          ${t(lang,'skip_suhoor')}
          ${this._skipSuhoor
            ? html`<span class="skip-note">— ${t(lang,'tarhim')} &amp; ${t(lang,'suhoor')}</span>`
            : ''}
        </button>
      </div>`;
  }

  // ── BACK FACE (SETTINGS) ───────────────────────────────────────────────────

  /** @private */
  _renderBack(lang) {
    return html`
      <div class="face back">
        <div class="settings-back">
          <button class="close-btn" tabindex="1" @click=${this._closeSettings}>
            <span class="close-icon">✕</span>
            ${t(lang,'close')}
          </button>

          <div class="settings-title">${t(lang,'settings')}</div>

          <div class="settings-row">
            <label>${t(lang,'show_date')}</label>
            <button class="tog ${this._showTitle ? 'on' : 'off'}" tabindex="2"
                    @click=${() => { this._showTitle = !this._showTitle; }}></button>
          </div>

          <div class="settings-row">
            <label>${t(lang,'show_ramadan')}</label>
            <button class="tog ${this._showRamadanBar ? 'on' : 'off'}" tabindex="3"
                    @click=${() => { this._showRamadanBar = !this._showRamadanBar; }}></button>
          </div>

          <div class="settings-row">
            <label>${t(lang,'show_skip')}</label>
            <button class="tog ${this._showSkipBtn ? 'on' : 'off'}" tabindex="4"
                    @click=${() => { this._showSkipBtn = !this._showSkipBtn; }}></button>
          </div>

          <div class="settings-row">
            <label>${t(lang,'theme')}</label>
            <select class="sel" tabindex="5"
                    @change=${(e) => { this._theme = e.target.value; this._applyTheme(); }}>
              <option value="auto"  ?selected=${this._theme==='auto'}>Auto</option>
              <option value="dark"  ?selected=${this._theme==='dark'}>Dark</option>
              <option value="light" ?selected=${this._theme==='light'}>Light</option>
            </select>
          </div>

          <div class="settings-row">
            <label>${t(lang,'language')}</label>
            <select class="sel" tabindex="6"
                    @change=${(e) => { this._lang = e.target.value; }}>
              ${Object.entries(LANG_LABELS).map(([code, name]) => html`
                <option value="${code}" ?selected=${this._lang===code}>${name}</option>`)}
            </select>
          </div>

          <div class="settings-row slider-row">
            <label>${t(lang,'brightness')} — ${this._brightness}%</label>
            <input type="range" class="slider" tabindex="7"
                   min="0" max="100" step="5"
                   .value=${String(this._brightness)}
                   @input=${(e) => { this._brightness = +e.target.value; }}>
          </div>

          <!-- Location layer info -->
          <div class="settings-loc">
            ${this._locationInfo?.icon || '📍'}
            ${this._locationInfo?.layerLabel || '—'}
            — ${this._locationInfo?.label || '—'}
          </div>

          <!-- Notification permission indicator -->
          <div class="settings-row notify-row">
            <label>Notifications</label>
            <button class="notify-perm-btn"
                    data-status="${notify.permissionStatus}"
                    tabindex="8"
                    ?disabled="${notify.permissionStatus === 'unsupported'}"
                    @click=${this._requestNotifyPermission}>
              ${{ granted:'🔔', denied:'🔕', unsupported:'🔇' }[notify.permissionStatus] ?? '🔔'}
              <span class="notify-perm-label">${notify.permissionStatus}</span>
            </button>
          </div>

        </div>
      </div>`;
  }

  /**
   * Called when the user taps the notification permission button in settings.
   * Re-triggers the full permission negotiation and re-renders.
   *
   * @returns {Promise<void>}
   * @private
   */
  async _requestNotifyPermission() {
    if (notify.permissionStatus === 'unsupported') return;
    await notify._requestPermission();
    this.requestUpdate();
  }

  /**
   * Handle a fired notification from NidaNotify.
   * Briefly highlights the matching prayer row with a pulse animation.
   *
   * @param {{ type: string, prayerKey: string|null }} action - The fired action.
   * @returns {void}
   * @private
   */
  _onNotifyFired(action) {
    const { prayerKey } = action;
    if (!prayerKey) return;

    const row = this.shadowRoot?.querySelector(`[data-prayer="${prayerKey}"]`);
    if (!row) return;

    // Remove then re-add the class so the animation re-triggers if already animating.
    row.classList.remove('nida-pulse');
    void row.offsetWidth; // force reflow
    row.classList.add('nida-pulse');

    // Remove after 3 animation cycles (3 × 1.1 s ≈ 3.4 s).
    setTimeout(() => row.classList.remove('nida-pulse'), 3500);
  }

  // ── INTRO OVERLAY ──────────────────────────────────────────────────────────

  /** @private */
  _renderIntro(lang) {
    const step = this._introStep;

    const advance = () => {
      if (step === 1) { this._introStep = 2; }
      else { this._introStep = 0; localStorage.setItem('nida-intro-seen','1'); }
    };
    const skip = () => { this._introStep = 0; localStorage.setItem('nida-intro-seen','1'); };

    return html`
      <div class="intro-overlay">
        <div class="intro-icon">${step === 1 ? '👆' : '⚙️'}</div>
        <div class="intro-title">${ti(lang, step===1 ? 't1' : 't2')}</div>
        <div class="intro-body">${ti(lang, step===1 ? 'b1' : 'b2')}</div>
        <div class="intro-dots">
          <div class="dot ${step===1?'active':''}"></div>
          <div class="dot ${step===2?'active':''}"></div>
        </div>
        <button class="intro-btn" @click=${advance}>
          ${ti(lang, step===1 ? 'btn1' : 'btn2')}
        </button>
        ${step === 1 ? html`
          <button class="intro-skip" @click=${skip}>${ti(lang,'skip')}</button>` : ''}
      </div>`;
  }

  // ── UTILITY ────────────────────────────────────────────────────────────────

  /**
   * Parses an HA "HH:MM" sensor state to minutes-after-midnight.
   * Returns null when the sensor is unavailable.
   * @private
   */
  _parseReadable(entity) {
    const val = this._s(entity);
    if (!val || val === 'unavailable') return null;
    const [h, m] = val.split(':').map(Number);
    return h * 60 + m;
  }

  getCardSize() { return 7; }

  // ── STYLES ─────────────────────────────────────────────────────────────────

  static get styles() {
    return css`
      :host {
        display: block;
        width: 100%;
        box-sizing: border-box;
        font-family: 'Cairo', sans-serif;
      }
      :host(:focus-within) {
        outline: 2px solid #c9a84c;
        outline-offset: 3px;
        border-radius: var(--ha-card-border-radius, 12px);
      }
      *, *::before, *::after { box-sizing: border-box; }

      /* ── FLIP CONTAINER ─────────────────────────────────────────────────── */
      .flip-container { width: 100%; perspective: 1200px; }
      .flipper {
        position: relative; width: 100%;
        transform-style: preserve-3d;
        transition: transform .6s cubic-bezier(.4,.2,.2,1);
      }
      .flipper.flipped { transform: rotateY(180deg); }
      .flipper.flipped .gear-btn { visibility: hidden; pointer-events: none; }

      .face.front {
        position: relative; width: 100%;
        backface-visibility: hidden;
        -webkit-backface-visibility: hidden;
        border-radius: var(--ha-card-border-radius, 12px);
        overflow: hidden;
      }
      .face.back {
        position: absolute; top: 0; left: 0; width: 100%; height: 100%;
        backface-visibility: hidden;
        -webkit-backface-visibility: hidden;
        border-radius: var(--ha-card-border-radius, 12px);
        overflow: hidden;
        transform: rotateY(180deg);
        background: #000;
        z-index: 10;
      }

      /* ── CARD ───────────────────────────────────────────────────────────── */
      .card {
        width: 100%;
        border-radius: var(--ha-card-border-radius, 12px);
        overflow: hidden;
        transition: background .4s;
        min-height: 120px;
      }

      /* ── HEADER BLOCK ───────────────────────────────────────────────────── */
      .header-block {
        border-radius: 10px;
        overflow: hidden;
        margin: 8px 8px 0;
        cursor: pointer;
        user-select: none;
        -webkit-tap-highlight-color: transparent;
        transition: transform .1s ease;
      }
      .header-block:active { transform: scale(.995); }

      .next-block { padding: 10px 12px 6px; width: 100%; }
      .next-inner  { display: flex; align-items: flex-start; gap: 12px; position: relative; }

      .next-icon {
        width: 48px; height: 48px;
        background: linear-gradient(135deg,#c9a84c,#a07830);
        border-radius: 12px;
        display: flex; align-items: center; justify-content: center;
        font-size: 24px; flex-shrink: 0;
      }
      .next-text  { flex: 1; min-width: 0; text-align: left; }
      .next-label { font-size: 9px; letter-spacing: 2px; text-transform: uppercase; font-weight: 600; display: block; margin-bottom: 2px; }
      .next-name  { font-family: 'Amiri', serif; font-size: 28px; font-weight: 700; line-height: 1.15; display: block; }

      .next-right   { position: absolute; right: 0; top: 0; display: flex; flex-direction: column; align-items: flex-end; }
      .cd-label     { font-size: 9px; letter-spacing: 2px; text-transform: uppercase; font-weight: 600; display: block; margin-bottom: 2px; }
      .cd           { font-family: 'Amiri', serif; font-size: 28px; font-weight: 700; line-height: 1.15; }

      /* ── DATE ROW + LOCATION BADGE ─────────────────────────────────────── */
      .date-row {
        font-size: 10px; font-weight: 800; opacity: .55;
        margin-top: 6px;
        display: flex; align-items: center; justify-content: center;
        gap: 4px; white-space: nowrap; flex-wrap: wrap;
      }
      .sep { opacity: .5; }
      .holiday-badge {
        display: inline-flex; align-items: center; gap: 4px;
        background: linear-gradient(135deg,rgba(201,168,76,.25),rgba(160,120,48,.15));
        border: 1px solid rgba(201,168,76,.45);
        border-radius: 20px; padding: 2px 9px;
        font-size: 11px; font-weight: 700; color: #f0c060;
      }

      /* Subtle location pill — low opacity, non-intrusive */
      .loc-badge {
        display: inline-flex; align-items: center; gap: 3px;
        opacity: .7; font-size: 9px; font-weight: 700;
        margin-left: 4px;
        transition: opacity .2s;
      }
      .loc-badge:hover { opacity: 1; }
      .loc-badge.fallback { color: #f0a050; }
      .loc-icon  { font-size: 10px; }
      .loc-label { max-width: 80px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

      /* Small orange dot = drift pending */
      .drift-dot {
        width: 6px; height: 6px; border-radius: 50%;
        background: #f0a050;
        flex-shrink: 0;
        animation: pulse-dot 1.5s ease-in-out infinite;
      }
      @keyframes pulse-dot {
        0%,100% { transform: scale(1);   opacity: 1; }
        50%      { transform: scale(1.4); opacity: .7; }
      }

      /* Invisible refresh button — only visible on hover/focus */
      .loc-refresh {
        background: none; border: none; cursor: pointer;
        font-size: 11px; padding: 0 2px;
        opacity: .5; transition: opacity .2s;
        color: inherit;
      }
      .loc-refresh:hover,
      .loc-refresh:focus { opacity: 1; outline: 1px solid #c9a84c; border-radius: 4px; }

      /* ── DRIFT BANNER ───────────────────────────────────────────────────── */
      .drift-banner {
        margin: 4px 8px 0;
        border-radius: 10px;
        padding: 8px 12px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        animation: drift-slide-in .35s cubic-bezier(.2,.8,.4,1) both;
        font-size: 11px; font-weight: 700;
      }
      @keyframes drift-slide-in {
        from { opacity: 0; transform: translateY(-8px) scaleY(.9); }
        to   { opacity: 1; transform: translateY(0)    scaleY(1);  }
      }
      .drift-text { display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0; }
      .drift-icon { font-size: 14px; flex-shrink: 0; }
      .drift-actions { display: flex; gap: 6px; flex-shrink: 0; }
      .drift-btn {
        border: none; border-radius: 8px;
        padding: 4px 10px; font-size: 11px; font-weight: 800;
        cursor: pointer; font-family: 'Cairo', sans-serif;
        transition: opacity .15s;
      }
      .drift-btn:active { transform: scale(.97); }
      .drift-btn.confirm { background: #c9a84c; color: #1a1200; }
      .drift-btn.dismiss { background: rgba(255,255,255,.12); color: inherit; }

      /* ── PROGRESS BAR ───────────────────────────────────────────────────── */
      .progress-bar {
        height: 10px; width: calc(100% - 24px);
        margin: 0 12px 4px;
        border-radius: 99px; overflow: hidden;
      }
      .progress-fill {
        height: 100%; border-radius: 99px;
        background: linear-gradient(90deg,#c9a84c,#f0d078);
        transition: width 1s linear;
        position: relative; overflow: hidden;
        animation: prog-glow 3s ease-in-out infinite;
      }
      .progress-fill::after {
        content: ''; position: absolute;
        top: 0; left: -100%; width: 60%; height: 100%;
        background: linear-gradient(90deg,transparent,rgba(255,255,255,.5),transparent);
        animation: shimmer 3s ease-in-out infinite;
      }
      @keyframes prog-glow {
        0%,100% { box-shadow: 0 0 3px rgba(201,168,76,.2); }
        50%      { box-shadow: 0 0 8px rgba(201,168,76,.6); }
      }
      @keyframes shimmer { 0% { left:-100%; } 100% { left:160%; } }

      /* ── COLLAPSIBLE WRAPPER ────────────────────────────────────────────── */
      .prayers-wrapper {
        display: grid; grid-template-rows: 1fr;
        transition: grid-template-rows .4s cubic-bezier(.4,0,.2,1),
                    opacity .35s ease, transform .35s cubic-bezier(.4,0,.2,1);
        opacity: 1; transform: translateY(0); overflow: hidden;
      }
      .prayers-wrapper.collapsed {
        grid-template-rows: 0fr;
        opacity: 0; transform: translateY(-6px);
      }
      .prayers-inner { min-height: 0; overflow: hidden; }

      /* ── PRAYER GRID ────────────────────────────────────────────────────── */
      .prayers {
        padding: 8px;
        display: grid;
        grid-template-columns: 1fr 1fr;
        grid-auto-rows: 1fr;
        gap: 7px;
      }

      /* ── RAMADAN BAR ────────────────────────────────────────────────────── */
      .ramadan-bar-row {
        grid-column: 1 / -1;
        background: rgba(255,255,255,.03);
        border: 1px solid rgba(255,255,255,.06);
        border-radius: 10px; padding: 7px 14px;
        display: grid;
        grid-template-columns: auto 1px 1fr 1px 1fr 1px 1fr;
        align-items: center;
      }
      .rbar-seg  { display: flex; flex-direction: column; align-items: center; padding: 0 12px; }
      .rbar-day  { align-items: center; padding-left: 2px; }
      .rbar-val  { font-family: 'Amiri',serif; font-size: 20px; font-weight: 700; color: #f0e6c8; line-height: 1; }
      .rbar-day .rbar-val { font-size: 26px; color: #c9a84c; }
      .rbar-lbl  { font-size: 9px; letter-spacing: 1.2px; text-transform: uppercase; color: rgba(201,168,76,.45); }
      .rbar-div  { width: 1px; height: 24px; background: rgba(201,168,76,.15); align-self: center; }

      /* ── DYNAMIC SLOT ───────────────────────────────────────────────────── */
      .dynamic-slot {
        position: relative; border-radius: 10px;
        padding: 9px 11px;
        display: flex; flex-direction: column; justify-content: center;
        overflow: hidden;
      }

      /* ── PRAYER ITEM ────────────────────────────────────────────────────── */
      .prayer-item {
        position: relative; padding: 9px 11px;
        border-radius: 10px; overflow: hidden;
      }
      .prayer-item::before {
        content: ''; position: absolute;
        left: 0; top: 0; bottom: 0; width: 3px;
        border-radius: 10px 0 0 10px;
      }
      .prayer-item.past    { opacity: .4; }
      .prayer-name  { font-size: 11px; font-weight: 700; margin-bottom: 1px; letter-spacing: .3px; }
      .prayer-time  { font-family: 'Amiri',serif; font-size: 22px; font-weight: 700; }
      .prayer-emoji { position: absolute; right: 8px; top: 8px; font-size: 14px; opacity: .12; }
      .prayer-item.active .prayer-emoji { opacity: .28; }

      /* Gear button — bottom-right of last prayer item */
      .gear-btn {
        position: absolute; right: 8px; bottom: 8px;
        background: none; border: none; cursor: pointer;
        padding: 0; font-size: 24px; opacity: .13;
        transition: opacity .2s; line-height: 1; z-index: 2;
      }
      .gear-btn:hover { opacity: .45; }

      /* ── SKIP SUHOOR ────────────────────────────────────────────────────── */
      .skip-suhoor-bar { padding: 0 8px 8px; }
      .skip-suhoor-btn {
        width: 100%; border: none; border-radius: 10px;
        padding: 9px 14px; cursor: pointer;
        font-family: 'Cairo',sans-serif; font-size: 11px; font-weight: 700;
        display: flex; align-items: center; justify-content: center; gap: 7px;
        transition: opacity .2s, transform .1s;
        -webkit-tap-highlight-color: transparent;
      }
      .skip-suhoor-btn:active { transform: scale(.98); }
      .skip-note { opacity: .5; font-size: 10px; }

      /* ── SETTINGS BACK ──────────────────────────────────────────────────── */
      .settings-back {
        padding: 20px 16px 16px;
        display: flex; flex-direction: column;
        height: 100%; background: #000; color: #e8dcc8;
      }
      .close-btn {
        display: flex; align-items: center; gap: 8px;
        background: none; border: none; cursor: pointer;
        color: #c9a84c; font-family: 'Cairo',sans-serif;
        font-size: 12px; font-weight: 700;
        padding: 0 0 18px; opacity: .85; transition: opacity .2s;
      }
      .close-btn:hover { opacity: 1; }
      .close-icon {
        width: 22px; height: 22px; border-radius: 50%;
        border: 1.5px solid rgba(201,168,76,.5);
        display: flex; align-items: center; justify-content: center;
        font-size: 12px; color: #c9a84c;
      }
      .settings-title { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 1.5px; margin-bottom: 16px; color: rgba(201,168,76,.45); }
      .settings-row   { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; font-size: 12px; font-weight: 600; gap: 10px; color: #e8dcc8; }
      .settings-row label { opacity: .7; flex-shrink: 0; }
      .slider-row { flex-direction: column; align-items: flex-start; gap: 5px; }

      .tog {
        width: 36px; height: 20px; border-radius: 10px;
        border: none; cursor: pointer; position: relative;
        transition: background .2s; flex-shrink: 0;
      }
      .tog.on  { background: #c9a84c; }
      .tog.off { background: rgba(150,150,150,.3); }
      .tog::after {
        content: ''; position: absolute;
        width: 14px; height: 14px; border-radius: 50%;
        background: #fff; top: 3px; transition: left .2s;
      }
      .tog.on::after  { left: 19px; }
      .tog.off::after { left: 3px; }

      .sel {
        background: rgba(255,255,255,.06);
        border: 1px solid rgba(201,168,76,.3);
        border-radius: 6px; padding: 3px 6px;
        font-size: 11px; font-family: 'Cairo',sans-serif;
        cursor: pointer; max-width: 130px; color: #e8dcc8;
      }
      .slider { width: 100%; accent-color: #c9a84c; cursor: pointer; }

      /* Location info line in settings */
      .settings-loc {
        margin-top: auto; padding-top: 16px;
        font-size: 10px; opacity: .4;
        font-family: 'Cairo',sans-serif;
      }

      /* ── INTRO OVERLAY ──────────────────────────────────────────────────── */
      .intro-overlay {
        position: absolute; inset: 0; z-index: 100;
        border-radius: var(--ha-card-border-radius,12px);
        display: flex; flex-direction: column;
        align-items: center; justify-content: center;
        padding: 18px 20px 16px; text-align: center;
        backdrop-filter: blur(3px);
        -webkit-backdrop-filter: blur(3px);
        background: rgba(0,0,0,.72);
        animation: intro-fade .4s ease;
        gap: 10px;
      }
      @keyframes intro-fade {
        from { opacity:0; transform:scale(.97); }
        to   { opacity:1; transform:scale(1); }
      }
      .intro-icon  { font-size: 32px; line-height: 1; }
      .intro-title { font-family:'Cairo',sans-serif; font-size:13px; font-weight:800; color:#f0e6c8; letter-spacing:.3px; }
      .intro-body  { font-family:'Cairo',sans-serif; font-size:11px; color:rgba(240,230,200,.75); line-height:1.5; max-width:240px; }
      .intro-dots  { display:flex; gap:5px; }
      .dot         { width:6px; height:6px; border-radius:50%; background:rgba(201,168,76,.3); transition:background .2s; }
      .dot.active  { background:#c9a84c; }
      .intro-btn   {
        background:linear-gradient(135deg,#c9a84c,#a07830);
        border:none; border-radius:8px; color:#1a1200;
        font-family:'Cairo',sans-serif; font-size:12px; font-weight:800;
        padding:7px 20px; cursor:pointer; margin-top:2px; transition:opacity .2s;
      }
      .intro-btn:hover { opacity:.85; }
      .intro-skip {
        font-size:10px; color:rgba(240,230,200,.35);
        cursor:pointer; text-decoration:underline;
        background:none; border:none; font-family:'Cairo',sans-serif; padding:0;
      }

      /* ── RTL ────────────────────────────────────────────────────────────── */
      .rtl .next-block { direction: rtl; }
      .rtl .prayer-item::before { left:auto; right:0; border-radius:0 10px 10px 0; }
      .rtl .prayer-emoji        { right:auto; left:8px; }
      .rtl .gear-btn            { right:auto; left:8px; }
      .rtl .next-right          { right:auto; left:0; align-items:flex-start; }

      /* ── DARK THEME ─────────────────────────────────────────────────────── */
      .card.dark .header-block         { background:rgba(255,255,255,.03); border:1px solid rgba(255,255,255,.05); }
      .card.dark .progress-bar         { background:rgba(201,168,76,.35); }
      .card.dark .next-label           { color:rgba(201,168,76,.5); }
      .card.dark .cd-label             { color:rgba(201,168,76,.4); }
      .card.dark .next-name,.card.dark .cd { color:#f0e6c8; }
      .card.dark .date-row             { color:#c9a84c; }
      .card.dark .prayer-item          { background:rgba(255,255,255,.04); border:1px solid rgba(255,255,255,.07); }
      .card.dark .prayer-item.active   { background:rgba(201,168,76,.09); border-color:rgba(201,168,76,.25); }
      .card.dark .prayer-item.active::before { background:linear-gradient(180deg,#c9a84c,#a07830); }
      .card.dark .prayer-name          { color:#e8dcc8; }
      .card.dark .prayer-item.active .prayer-name { color:#c9a84c; }
      .card.dark .prayer-time          { color:#f0e6c8; }
      .card.dark .prayer-item.active .prayer-time { color:#fff; }
      .card.dark .gear-btn             { color:#e8dcc8; }
      .card.dark .drift-banner         { background:rgba(201,168,76,.1); border:1px solid rgba(201,168,76,.2); color:#f0e6c8; }
      .card.dark .dynamic-slot.ramadan-slot { background:rgba(201,168,76,.07); border:1px solid rgba(201,168,76,.18); color:#c9a84c; }
      .card.dark .dynamic-slot.eid-slot     { background:rgba(120,80,200,.1); border:1px solid rgba(120,80,200,.25); color:#b89aff; }
      .card.dark .dynamic-slot.eid-soon-slot{ background:rgba(120,80,200,.07); border:1px solid rgba(120,80,200,.18); color:#b89aff; }
      .card.dark .dynamic-slot.default-slot { background:rgba(255,255,255,.04); border:1px solid rgba(255,255,255,.07); color:#e8dcc8; }
      .card.dark .skip-suhoor-btn.active    { background:rgba(201,168,76,.18); border:1px solid rgba(201,168,76,.35); color:#c9a84c; }
      .card.dark .skip-suhoor-btn.inactive  { background:rgba(255,255,255,.05); border:1px solid rgba(255,255,255,.1); color:rgba(232,220,200,.5); }

      /* ── LIGHT THEME ────────────────────────────────────────────────────── */
      .card.light .header-block         { background:rgba(0,0,0,.02); border:1px solid rgba(0,0,0,.05); }
      .card.light .progress-bar         { background:rgba(160,120,48,.35); }
      .card.light .next-label           { color:rgba(138,104,32,.6); }
      .card.light .cd-label             { color:rgba(138,104,32,.5); }
      .card.light .next-name,.card.light .cd { color:#3a2c0a; }
      .card.light .date-row             { color:#8a6820; }
      .card.light .prayer-item          { background:rgba(255,255,255,.75); border:1px solid rgba(160,120,48,.12); }
      .card.light .prayer-item.active   { background:rgba(201,168,76,.15); border-color:rgba(160,120,48,.35); }
      .card.light .prayer-item.active::before { background:linear-gradient(180deg,#c9a84c,#a07830); }
      .card.light .prayer-name          { color:#3a2c0a; }
      .card.light .prayer-item.active .prayer-name { color:#8a6820; }
      .card.light .prayer-time          { color:#2a1e04; }
      .card.light .prayer-item.active .prayer-time { color:#3a2c0a; }
      .card.light .gear-btn             { color:#3a2c0a; }
      .card.light .drift-banner         { background:rgba(201,168,76,.1); border:1px solid rgba(160,120,48,.25); color:#3a2c0a; }
      .card.light .drift-btn.dismiss    { background:rgba(0,0,0,.06); color:#3a2c0a; }
      .card.light .dynamic-slot.ramadan-slot { background:rgba(201,168,76,.12); border:1px solid rgba(160,120,48,.25); color:#8a6820; }
      .card.light .dynamic-slot.eid-slot     { background:rgba(120,80,200,.08); border:1px solid rgba(120,80,200,.2); color:#6040a0; }
      .card.light .dynamic-slot.eid-soon-slot{ background:rgba(120,80,200,.06); border:1px solid rgba(120,80,200,.15); color:#6040a0; }
      .card.light .dynamic-slot.default-slot { background:rgba(255,255,255,.75); border:1px solid rgba(160,120,48,.12); color:#3a2c0a; }
      .card.light .skip-suhoor-btn.active    { background:rgba(201,168,76,.12); border:1px solid rgba(160,120,48,.3); color:#8a6820; }
      .card.light .skip-suhoor-btn.inactive  { background:rgba(0,0,0,.04); border:1px solid rgba(160,120,48,.15); color:rgba(58,44,10,.4); }

      /* ── NOTIFICATION PULSE (fired by _onNotifyFired) ──────────────────── */
      @keyframes nida-pulse-ring {
        0%   { box-shadow: 0 0 0 0   rgba(201, 168, 76, 0.55); }
        70%  { box-shadow: 0 0 0 8px rgba(201, 168, 76, 0);    }
        100% { box-shadow: 0 0 0 0   rgba(201, 168, 76, 0);    }
      }
      .prayer-item.nida-pulse {
        animation: nida-pulse-ring 1.1s ease-out 3;
        /* border-radius already set on .prayer-item */
      }

      /* ── NOTIFICATION PERMISSION BUTTON (settings panel) ────────────────── */
      .notify-row { margin-top: 4px; }
      .notify-perm-btn {
        display: inline-flex; align-items: center; gap: 5px;
        padding: 4px 10px; border-radius: 6px; cursor: pointer;
        font-family: 'Cairo', sans-serif; font-size: 11px; font-weight: 700;
        border: 1px solid rgba(201,168,76,.3);
        background: rgba(255,255,255,.05); color: #e8dcc8;
        transition: background .15s, opacity .15s;
        white-space: nowrap;
      }
      .notify-perm-btn:hover:not([disabled]) { background: rgba(201,168,76,.12); }
      .notify-perm-btn[data-status="granted"] { color: #7ec896; border-color: rgba(126,200,150,.35); }
      .notify-perm-btn[data-status="denied"]  { color: #e07070; border-color: rgba(224,112,112,.35); }
      .notify-perm-btn[disabled]              { opacity: .4; cursor: default; }
      .notify-perm-label { text-transform: capitalize; }

      /* ── FOCUS STYLES (TV / keyboard navigation) ────────────────────────── */
      .header-block:focus,
      .skip-suhoor-btn:focus,
      .intro-btn:focus,
      .intro-skip:focus,
      .close-btn:focus,
      .gear-btn:focus,
      .tog:focus,
      .sel:focus,
      .slider:focus,
      .drift-btn:focus,
      .loc-refresh:focus,
      .notify-perm-btn:focus {
        outline: 2px solid #c9a84c !important;
        outline-offset: 3px;
        box-shadow: 0 0 0 3px rgba(201,168,76,.4) !important;
        border-radius: 8px;
      }
    `;
  }
}

// ── REGISTRATION ──────────────────────────────────────────────────────────────

customElements.define('nida-card', NidaCard);

// Version stamp in the browser console
console.log('%c NIDA CARD v2.1.0 ✓ ', 'background:#c9a84c;color:#1a1200;font-weight:bold;');