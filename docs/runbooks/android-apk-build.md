# Building the Novan Android APK

This runbook is for the operator who wants a real `.apk` file (not just the PWA install). The PWA covers 95% of the use case; the APK is for sideloading, Play Store listing, or air-gapped distribution.

## One-time setup

```bash
# 1. Add Capacitor deps (one-time per checkout)
cd apps/web
pnpm add -D @capacitor/core @capacitor/cli @capacitor/android

# 2. Add the Android platform
pnpm exec cap add android
# → creates apps/web/android/ — gitignore this folder
```

You'll also need locally installed:

- **Android Studio** (Hedgehog 2023.1.1 or newer) — provides the SDK + Gradle build chain
- **JDK 17** (Android Studio bundles one; or `brew install --cask temurin@17`)

## Per-build flow

```bash
# 1. Build the web bundle
cd apps/web
pnpm build       # → apps/web/dist

# 2. Sync into Android project
pnpm exec cap sync android

# 3. Open Android Studio
pnpm exec cap open android
```

In Android Studio:

1. **Build → Generate Signed Bundle / APK**
2. Pick **APK**
3. Create or pick a keystore. **Back it up.** Losing the keystore means future updates require a fresh install — not just an upgrade.
4. Pick **release** build variant + **V2 (Full APK Signature)**
5. Wait — first build is slow (Gradle downloads). Subsequent builds are fast.
6. Output lands in `apps/web/android/app/build/outputs/apk/release/app-release.apk`

## Sideloading on your phone

1. Enable **Developer Options** → **USB Debugging** on the phone
2. `adb install apps/web/android/app/build/outputs/apk/release/app-release.apk`

Or transfer the `.apk` file via Google Drive / email / Tailscale Drop and tap it.

## Thin-shell vs. bundled mode

`capacitor.config.ts` defaults to **bundled** — the APK contains the full web build and works offline.

To switch to **thin-shell** mode (APK is a wrapper around the live web app):

```ts
server: { url: 'https://your-novan.tailscale-name.ts.net', cleartext: false }
```

Trade-off: thin-shell auto-updates without a new APK; bundled is offline-capable.

## What lives in this repo

- `apps/web/capacitor.config.ts` — Capacitor config (committed)
- `apps/web/android/` — generated platform code (gitignored — runs `cap add` to regenerate)
- This runbook

## What does NOT live in the repo

- Your keystore (`*.jks`, `*.keystore`)
- The signing key passwords
- The generated APK files

Keep those out of version control. If you lose the keystore you cannot push updates to the same Play Store listing — only ever distribute as a "new app."

## When to skip the APK

If you don't have a specific reason for a `.apk` (Play Store, enterprise distribution, offline phones), the PWA install (`/m/chat` → "Add to Home Screen") gives the same operator experience without any of this. The recommendation stays: **PWA is the right default; APK only if you need the artifact**.
