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
