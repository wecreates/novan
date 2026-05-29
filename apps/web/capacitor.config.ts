/**
 * capacitor.config.ts — Ionic Capacitor configuration for the Novan APK.
 *
 * Capacitor wraps the existing PWA in a native Android WebView and
 * produces a real signed `.apk`. The wrap is opt-in — your normal
 * `pnpm dev` / `pnpm build` flow is untouched. Only the operator who
 * wants the APK runs the Capacitor commands.
 *
 * Build flow once `@capacitor/core @capacitor/cli @capacitor/android`
 * are installed (operator runs once: `pnpm add -D @capacitor/core
 * @capacitor/cli @capacitor/android`):
 *
 *   1. pnpm build                                # produces apps/web/dist
 *   2. pnpm exec cap add android                 # one-time scaffold
 *   3. pnpm exec cap sync                        # copies dist into android/
 *   4. pnpm exec cap open android                # opens Android Studio
 *   5. Build → Generate Signed Bundle/APK in Android Studio
 *
 * The webDir points at the Vite build output. server.url is left empty
 * for offline-capable bundling; set it to a public URL if you want the
 * APK to be a thin wrapper around the live web app instead of a
 * shipped bundle.
 *
 * Honest scope: this is *configuration*, not a built APK. Building
 * requires Android Studio + JDK + the operator's signing key. We don't
 * commit any of those.
 */
import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId:    'com.novan.app',
  appName:  'Novan',
  webDir:   'dist',
  bundledWebRuntime: false,

  // When server.url is set, the APK acts as a thin shell around the
  // live web app at that URL. Useful for development; switch to a
  // bundled build (omit server.url) for production distribution.
  // server: { url: 'https://your-novan.tailscale-name.ts.net', cleartext: false },

  android: {
    // App icon + splash sourced from the existing PWA icon.png — no
    // separate Android resource generation needed unless the operator
    // wants per-density rasters (see https://capacitorjs.com/docs/guides/splash-screens-and-icons).
    backgroundColor: '#000000',
    allowMixedContent: false,
  },

  plugins: {
    // Splash screen — black to match the PWA aesthetic.
    SplashScreen: {
      launchShowDuration:  600,
      backgroundColor:     '#000000',
      androidSplashResourceName: 'splash',
      showSpinner:         false,
    },
    // Local notifications fallback (separate from Web Push — useful when
    // the APK is offline or when push isn't configured server-side).
    LocalNotifications: { iconColor: '#ffffff' },
  },
}

export default config
