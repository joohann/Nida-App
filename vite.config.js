/**
 * @file        vite.config.js
 * @version     1.4.0
 * @since       2026-03-28
 * @description Vite 5 build configuration for Nida v2.
 *
 * Import resolution:
 *   nida-card.js lives in www/nida/ and imports './core/nida-*.js'.
 *   The resolveId plugin intercepts those imports and redirects them
 *   to the real /core/ directory at the repo root.
 *
 * Capacitor externals:
 *   @capacitor/* packages are native plugins injected by the Capacitor
 *   runtime on the device. They do not exist in node_modules at build
 *   time and must be marked external so Rollup does not try to bundle them.
 *   At runtime, Capacitor's bridge resolves these imports automatically.
 */

import { defineConfig } from 'vite';
import { resolve }      from 'path';

export default defineConfig({
  root: '.',

  build: {
    outDir:      'dist',
    emptyOutDir: true,

    rollupOptions: {
      external: [
        // Capacitor core bridge — injected by `npx cap sync` into dist/
        '@capacitor/core',
        // Native plugins — resolved by the Capacitor runtime on the device
        '@capacitor/geolocation',
        '@capacitor/local-notifications',
      ],
    },
  },

  plugins: [
    {
      name: 'nida-core-resolver',
      /**
       * Intercepts './core/*' imports from www/nida/nida-card.js
       * and resolves them to /core/ at the repo root.
       *
       * @param {string} source   - Import specifier
       * @param {string} importer - Absolute path of the importing file
       * @returns {string|undefined}
       */
      resolveId(source, importer) {
        if (
          typeof source   === 'string' && source.startsWith('./core/') &&
          typeof importer === 'string' && importer.includes('www/nida/')
        ) {
          const filename = source.slice('./core/'.length);
          return resolve(__dirname, 'core', filename);
        }
      },
    },
  ],
});
