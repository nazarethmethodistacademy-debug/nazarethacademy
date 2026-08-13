# Ecole Systems — Desktop App

Wraps the existing `app/index.html` (unchanged) in an Electron window, so it
opens like a normal installed app — no browser chrome, its own icon, Start
Menu / Applications entry.

The app itself is unchanged: still a single self-contained HTML file that
saves its data to the browser's (in this case, Electron's) local storage on
the device. Nothing about how it works day-to-day is different.

## To update the app later

Just replace `app/index.html` with the newer version and rebuild. Nothing
else needs to change.

**If you also use the Android app**, copy the same updated file into
`android-app/www/index.html` too (both copies need to match — see the
Android section below).

## Building the installers

You need Node.js 18+ installed. Then, from this folder:

```
npm install
```

### Windows .exe
Run this **on a Windows machine** (most reliable) or via CI:
```
npm run dist:win
```
Output: `release/Ecole Systems Setup 1.0.0.exe`

### macOS .dmg
Must be run **on a Mac** — Apple doesn't allow building/signing `.dmg`
installers on other platforms:
```
npm run dist:mac
```
Output: `release/Ecole Systems-1.0.0.dmg`

### Linux (bonus, AppImage)
```
npm run dist:linux
```

### Building all three via GitHub Actions (no Mac/Windows needed)
A workflow is already included at `.github/workflows/build.yml`. To use it:

1. Push this folder to a new GitHub repo (public or private — Actions works
   on both; private repos on a free account get 2,000 build-minutes/month,
   which easily covers this).
2. Go to the repo's **Actions** tab. The workflow runs automatically on
   every push to `main`, or click **Run workflow** to trigger it by hand
   any time.
3. Once it finishes (a few minutes), open the completed run and scroll to
   **Artifacts** — you'll find `windows-installer`, `macos-installer`, and
   `linux-installer`, each a zip containing that platform's installer.

This builds each installer on a *real* Windows/Mac/Linux machine (GitHub's
own runners), so there's no cross-compiling weirdness — it's the same as
running `npm run dist:win` on an actual Windows PC.

## Unsigned-app warnings

These installers aren't code-signed (that requires a paid Apple Developer
account and a Windows code-signing certificate). The first time someone
runs the installer:
- **Windows** shows a SmartScreen "Windows protected your PC" prompt →
  "More info" → "Run anyway".
- **macOS** shows "cannot be opened because the developer cannot be
  verified" → right-click the app → "Open" → confirm.

This is normal for internally-distributed apps and doesn't affect how the
app runs — it's just a first-run warning.

## Android

The `android-app/` folder wraps the same `app/index.html` in a native
Android shell using [Capacitor](https://capacitorjs.com/) instead of
Electron. The GitHub Actions workflow builds this automatically alongside
the desktop installers — check the same Actions run's **Artifacts** section
for `android-apk`.

**This produces a debug APK** (unsigned, for direct install/testing —
not a Play Store release build). To install it on a phone:
1. Download `android-apk` from the Actions run, unzip to get `app-debug.apk`.
2. Transfer it to the phone (email, USB, cloud drive — any method).
3. On the phone, tap the file to install. Android will warn about
   "installing from unknown sources" the first time — this is expected for
   an app not from the Play Store; allow it for this install.

### Keeping the Android app in sync with the web/desktop app
`android-app/www/index.html` is a **separate copy** of `app/index.html` —
Capacitor bundles it into the APK at build time, it doesn't read the file
live. Whenever `app/index.html` is updated, copy the same file into
`android-app/www/index.html` too, then commit and push both. The next CI
run rebuilds the APK with the update baked in.

### Building it yourself instead of via CI
Requires Android Studio (or just the Android SDK + Java 17) installed
locally:
```
cd android-app
npm install
npx cap sync android
cd android
./gradlew assembleDebug
```
Output: `android/app/build/outputs/apk/debug/app-debug.apk`

### Publishing to the Play Store later
This debug build isn't Play-Store-ready — that needs a signed release
build (a keystore + `assembleRelease`) and a Google Play Developer account
($25 one-time). Say the word if you want that set up once you're ready to
publish there.
