# Option B rollout — deployment steps

## What changed
- `functions/index.js` — new Cloud Functions: `login`, `changePassword`, `createUser`, `deleteUser`, `listUsers`.
- `database.rules.json` — per-node write rules keyed to `auth.token.role` (and `auth.token.class` for Class Teachers).
- `firebase.json` — wires both together.
- The app's HTML (`index.html`) has been patched to call these functions instead of checking password hashes in the browser.

## Prerequisites
1. You need the [Firebase CLI](https://firebase.google.com/docs/cli) and to be on the **Blaze (pay-as-you-go)** plan — Cloud Functions require it. Realtime Database usage at this app's scale costs a few dollars a month at most; Cloud Functions on the free tier's 2M invocations/month will not be exceeded by a single school's login/write volume.
2. `firebase login`
3. `firebase use <your-project-id>`

## Deploy
```bash
cd firebase-security
firebase deploy --only functions,database
```
This deploys the Cloud Functions and pushes the new `database.rules.json`.

## First login after deploy
Nothing changes for staff — they log in with their existing username/password exactly as before. The first successful login for each account **silently upgrades** that account's stored hash from SHA-256 to bcrypt (see `login` function) — no forced password reset, no downtime.

Once every active account has logged in at least once, you can optionally purge any remaining legacy `hash` fields as a final cleanup (there won't be any left if everyone's logged in since the deploy).

## What this does NOT yet cover (read this before considering it "done")

**1. Read-side data segregation is not yet enforced.**
The rules file grants `read` at the whole year node to *any* authenticated staff member — Teachers can technically read finance data if they inspect network traffic, even though the UI hides those pages from them. This is a deliberate, documented trade-off: your app currently loads *all* of a year's data in a single `fbDb.ref(FB_PATH).on('value', ...)` listener in `initDb()`. Firebase Realtime Database can only grant/deny read access at the exact path (or an ancestor of the path) a listener is attached to — a listener on the parent node isn't satisfied by permissions granted only on some of its children. Properly restricting reads per-role requires splitting that one listener into several (e.g. a separate listener per top-level node: `admissions`, `payments`, `grades`, etc.), each with its own rule. That's a bigger, separate refactor — happy to do it next if you want full read/write parity.

**2. Grades and timetable writes aren't restricted to "own class only" at the rules layer.**
Attendance *is* fully enforced (its key already encodes the class name, e.g. `Basic_3|2026-01-15`, so the rule can check it directly). Grades and timetable entries are keyed by `studentId|subjectId|term` with no class embedded, and `admissions` is a plain array rather than a map keyed by student ID — so a rule can't cheaply look up "what class is this student in" to verify a Class Teacher isn't touching another class's data. The client-side `lockedClassFor()` check still enforces this in the UI, but a Class Teacher who opened dev tools could bypass it. Two ways to close this properly:
   - Restructure `admissions` to be keyed by student ID (`admissions/{studentId}`) instead of an array, so rules can do `root.child(yearKey + '/admissions/' + <studentId>).child('cls').val()` lookups, or
   - Route grade/attendance/timetable writes through a small callable Cloud Function (same pattern as `login`) that checks class membership server-side before writing — more robust, and centralizes validation instead of relying on rules-language string tricks.

**3. No `.validate` schema rules yet.** Current rules check *who* can write, not *what shape* the data must be (e.g. nothing stops a malformed or negative payment amount from being written by an authorized user). Worth adding once the above two items are settled.

## Rollback
If anything goes wrong, you can restore permissive rules immediately with:
```bash
echo '{"rules": {".read": true, ".write": true}}' > database.rules.json
firebase deploy --only database
```
(Then fix forward — don't leave this in place, it's the same open-door state you had before.)
