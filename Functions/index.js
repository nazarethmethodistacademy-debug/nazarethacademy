/**
 * Nazareth Academy Finance Portal — Server-side Auth (Option B)
 * ──────────────────────────────────────────────────────────────
 * Replaces client-side password checking with Firebase Auth custom tokens
 * carrying `role` (and `class`, for Class Teachers) as custom claims, so
 * Realtime Database security rules can finally see WHO is asking and
 * enforce your existing requireRole() permission model at the data layer
 * instead of only in the browser.
 *
 * Deploy with:
 *   cd functions && npm install
 *   firebase deploy --only functions
 *
 * Requires: Node 20 runtime, `firebase-admin` + `firebase-functions` + `bcryptjs`.
 */

const functions = require('firebase-functions/v1');
const { initializeApp } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');
const { getAuth } = require('firebase-admin/auth');
const bcrypt = require('bcryptjs');

initializeApp();
const db = getDatabase();

const USERS_PATH = 'nazareth_academy_users';
const LEGACY_SALT = 'NA_salt_2026'; // must match the old client-side salt exactly
const BCRYPT_ROUNDS = 12;

// ── Helper: SHA-256(password + legacy salt), same algorithm the old client used ──
const crypto = require('crypto');
function legacyHash(password) {
  return crypto.createHash('sha256').update(password + LEGACY_SALT).digest('hex');
}

// ── Helper: load the users array from RTDB ──
async function loadUsers() {
  const snap = await db.ref(USERS_PATH).once('value');
  const users = snap.val();
  if (Array.isArray(users) && users.length > 0) return users;

  // Node is empty — this used to be seeded by the browser on first load, but
  // the client can no longer write to this node (by design, see database.rules.json).
  // Seed the same default accounts here instead, once, the first time anyone
  // tries to log in against an empty user list.
  const defaults = [
    { username: 'admin',       role: 'Admin',       bcryptHash: await bcrypt.hash('admin123', BCRYPT_ROUNDS) },
    { username: 'bursar',      role: 'Bursar',      bcryptHash: await bcrypt.hash('bursar123', BCRYPT_ROUNDS) },
    { username: 'secretary',   role: 'Secretary',   bcryptHash: await bcrypt.hash('secretary123', BCRYPT_ROUNDS) },
    { username: 'headteacher', role: 'Headteacher', bcryptHash: await bcrypt.hash('headteacher123', BCRYPT_ROUNDS) },
    { username: 'Teacher',     role: 'Teacher',     bcryptHash: await bcrypt.hash('Teacher123.', BCRYPT_ROUNDS) },
  ];
  await db.ref(USERS_PATH).set(defaults);
  return defaults;
}

async function saveUsers(users) {
  await db.ref(USERS_PATH).set(users);
}

// ── Helper: require the caller to already be authenticated with a given role ──
function requireCallerRole(context, ...roles) {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'You must be signed in.');
  }
  if (!roles.includes(context.auth.token.role)) {
    throw new functions.https.HttpsError('permission-denied', 'You do not have permission for this action.');
  }
}

/**
 * ── login ──
 * Verifies username/password against the stored user record and returns a
 * Firebase custom token embedding { role, class } as custom claims.
 *
 * Transparently migrates legacy SHA-256 hashes to bcrypt on first successful
 * login after this upgrade — no forced password reset needed for staff.
 */
exports.login = functions.https.onCall(async (data, context) => {
  const username = String(data.username || '').trim().toLowerCase();
  const password = String(data.password || '');

  if (!username || !password) {
    throw new functions.https.HttpsError('invalid-argument', 'Username and password are required.');
  }

  const users = await loadUsers();
  const idx = users.findIndex(u => u.username.toLowerCase() === username);
  if (idx === -1) {
    throw new functions.https.HttpsError('unauthenticated', 'Invalid username or password.');
  }
  const user = users[idx];

  // ── Brute-force protection: 7 failed attempts locks this account for 15 minutes ──
  const MAX_LOGIN_ATTEMPTS = 7;
  const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

  if (user.lockedUntil && user.lockedUntil > Date.now()) {
    const minutesLeft = Math.ceil((user.lockedUntil - Date.now()) / 60000);
    throw new functions.https.HttpsError(
      'resource-exhausted',
      `Too many failed login attempts. This account is locked — try again in ${minutesLeft} minute${minutesLeft !== 1 ? 's' : ''}.`
    );
  }

  let ok = false;

  if (user.bcryptHash) {
    // Already migrated — verify with bcrypt.
    ok = await bcrypt.compare(password, user.bcryptHash);
  } else if (user.hash) {
    // Legacy SHA-256 record — verify with the old scheme, then upgrade in place.
    ok = user.hash === legacyHash(password);
    if (ok) {
      user.bcryptHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      delete user.hash; // never keep the weak hash around once migrated
    }
  }

  if (!ok) {
    user.failedAttempts = (user.failedAttempts || 0) + 1;
    let message = 'Invalid username or password.';
    let code = 'unauthenticated';
    if (user.failedAttempts >= MAX_LOGIN_ATTEMPTS) {
      user.lockedUntil = Date.now() + LOCKOUT_DURATION_MS;
      user.failedAttempts = 0; // counter resets — the timed lock is now the active penalty
      message = `Too many failed login attempts. This account is now locked for ${LOCKOUT_DURATION_MS / 60000} minutes.`;
      code = 'resource-exhausted';
    }
    users[idx] = user;
    await saveUsers(users);
    throw new functions.https.HttpsError(code, message);
  }

  // Successful login — clear any failure tracking so past mistakes don't linger.
  if (user.failedAttempts || user.lockedUntil) {
    user.failedAttempts = 0;
    user.lockedUntil = null;
  }
  users[idx] = user;
  await saveUsers(users);

  const claims = { role: user.role, class: user.class || null };
  const token = await getAuth().createCustomToken(username, claims);
  return { token, role: user.role, class: user.class || null, username: user.username };
});

/**
 * ── changePassword ──
 * Self-service (or admin-on-behalf-of) password change. Mirrors the existing
 * UI, which always requires the CALLER's own current password, even when an
 * Admin is resetting someone else's password.
 */
exports.changePassword = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'You must be signed in.');
  }
  const targetUsername = String(data.targetUsername || '').trim();
  const currentPassword = String(data.currentPassword || '');
  const newPassword = String(data.newPassword || '');

  if (!targetUsername || !currentPassword || !newPassword) {
    throw new functions.https.HttpsError('invalid-argument', 'All fields are required.');
  }
  if (newPassword.length < 8) {
    throw new functions.https.HttpsError('invalid-argument', 'New password must be at least 8 characters.');
  }
  // Only Admins may change a password that isn't their own.
  const callerUsername = context.auth.uid; // uid == username, set at createCustomToken()
  if (targetUsername.toLowerCase() !== callerUsername.toLowerCase() && context.auth.token.role !== 'Admin') {
    throw new functions.https.HttpsError('permission-denied', 'You can only change your own password.');
  }

  const users = await loadUsers();
  const callerIdx = users.findIndex(u => u.username.toLowerCase() === callerUsername.toLowerCase());
  if (callerIdx === -1) {
    throw new functions.https.HttpsError('not-found', 'Your account could not be found.');
  }
  const caller = users[callerIdx];
  const callerOk = caller.bcryptHash
    ? await bcrypt.compare(currentPassword, caller.bcryptHash)
    : caller.hash === legacyHash(currentPassword);
  if (!callerOk) {
    throw new functions.https.HttpsError('unauthenticated', 'Current password is incorrect.');
  }

  const targetIdx = users.findIndex(u => u.username.toLowerCase() === targetUsername.toLowerCase());
  if (targetIdx === -1) {
    throw new functions.https.HttpsError('not-found', 'Target user not found.');
  }
  users[targetIdx].bcryptHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  delete users[targetIdx].hash;
  // A password change is a strong signal of legitimate access — clear any
  // brute-force lockout on the target account so a reset actually un-sticks them.
  users[targetIdx].failedAttempts = 0;
  users[targetIdx].lockedUntil = null;
  await saveUsers(users);

  return { ok: true };
});

/**
 * ── createUser ── (Admin only)
 */
exports.createUser = functions.https.onCall(async (data, context) => {
  requireCallerRole(context, 'Admin');

  const username = String(data.username || '').trim();
  const role = String(data.role || '');
  const cls = data.class ? String(data.class) : null;
  const password = String(data.password || '');

  const VALID_ROLES = ['Admin', 'Bursar', 'Secretary', 'Headteacher', 'Teacher', 'Class Teacher'];
  if (!/^[a-zA-Z0-9_.\-]+$/.test(username)) {
    throw new functions.https.HttpsError('invalid-argument', 'Username may only contain letters, numbers, _ . -');
  }
  if (!VALID_ROLES.includes(role)) {
    throw new functions.https.HttpsError('invalid-argument', 'Invalid role.');
  }
  if (role === 'Class Teacher' && !cls) {
    throw new functions.https.HttpsError('invalid-argument', 'A Class Teacher must be assigned a class.');
  }
  if (password.length < 8) {
    throw new functions.https.HttpsError('invalid-argument', 'Password must be at least 8 characters.');
  }

  const users = await loadUsers();
  if (users.find(u => u.username.toLowerCase() === username.toLowerCase())) {
    throw new functions.https.HttpsError('already-exists', 'A user with that username already exists.');
  }

  const newUser = {
    username,
    role,
    bcryptHash: await bcrypt.hash(password, BCRYPT_ROUNDS),
  };
  if (role === 'Class Teacher') newUser.class = cls;

  users.push(newUser);
  await saveUsers(users);
  return { ok: true };
});

/**
 * ── deleteUser ── (Admin only)
 */
exports.deleteUser = functions.https.onCall(async (data, context) => {
  requireCallerRole(context, 'Admin');
  const username = String(data.username || '').trim();
  if (username.toLowerCase() === 'admin') {
    throw new functions.https.HttpsError('permission-denied', 'The admin account cannot be deleted.');
  }
  if (context.auth.uid.toLowerCase() === username.toLowerCase()) {
    throw new functions.https.HttpsError('permission-denied', 'You cannot delete your own account.');
  }
  const users = await loadUsers();
  const next = users.filter(u => u.username.toLowerCase() !== username.toLowerCase());
  await saveUsers(next);
  return { ok: true };
});

/**
 * ── listUsers ── (Admin only)
 * Returns username/role/class ONLY — password hashes never leave this
 * function's execution environment, unlike the old client-side model where
 * every logged-in browser cached every user's hash in localStorage.
 */
exports.listUsers = functions.https.onCall(async (data, context) => {
  requireCallerRole(context, 'Admin');
  const users = await loadUsers();
  return users.map(u => ({
    username: u.username,
    role: u.role,
    class: u.class || null,
    lockedUntil: (u.lockedUntil && u.lockedUntil > Date.now()) ? u.lockedUntil : null
  }));
});

/**
 * ─────────────────────────────────────────────────────────────
 * Payroll / HR — employees & payrollRuns are locked to server-only writes
 * in database.rules.json (see FB_LOCKED_KEYS on the client), so every
 * mutation to those two subtrees has to go through one of the five
 * functions below instead of the normal client saveDb() path.
 *
 * All five live under nazareth_academy/{yearKey}/... — the same
 * year-scoped tree the client reads from (FB_PATH = 'nazareth_academy/' +
 * ACTIVE_YEAR), so payroll data stays correctly partitioned per academic
 * year exactly like every other node under that path.
 * ─────────────────────────────────────────────────────────────
 */

function yearRef(yearKey, sub) {
  const key = String(yearKey || '').trim();
  if (!/^[a-zA-Z0-9_\-]+$/.test(key)) {
    throw new functions.https.HttpsError('invalid-argument', 'Invalid year key.');
  }
  return db.ref(`nazareth_academy/${key}/${sub}`);
}

/**
 * ── saveEmployee ── (Admin, Bursar)
 * Upserts by id. When `employee.id` is omitted (new hire), assigns the next
 * id from that year's nextEmpId counter, exactly the way the old client-side
 * db.nextEmpId++ used to, just moved server-side now that the client can no
 * longer write to this subtree directly.
 */
exports.saveEmployee = functions.https.onCall(async (data, context) => {
  requireCallerRole(context, 'Admin', 'Bursar');

  const yearKey = data.yearKey;
  const input = data.employee || {};

  const staffId = String(input.staffId || '').trim();
  const name = String(input.name || '').trim();
  const salary = Number(input.salary) || 0;
  if (!staffId || !name || !salary) {
    throw new functions.https.HttpsError('invalid-argument', 'Staff ID, Name and Basic Salary are required.');
  }

  const empRef = yearRef(yearKey, 'employees');
  const idRef = yearRef(yearKey, 'nextEmpId');

  const [empSnap, idSnap] = await Promise.all([empRef.once('value'), idRef.once('value')]);
  const employees = Array.isArray(empSnap.val()) ? empSnap.val() : [];
  let nextId = idSnap.val();
  if (typeof nextId !== 'number') nextId = 1;

  let assignedId = input.id;
  const record = {
    staffId, name,
    dept: input.dept || '',
    role: input.role || '',
    hire: input.hire || '',
    status: input.status || 'Active',
    ssnit: input.ssnit || '',
    tin: input.tin || '',
    salary,
    transport: Number(input.transport) || 0,
    housing: Number(input.housing) || 0,
    otherAllow: Number(input.otherAllow) || 0,
    bank: input.bank || '',
    account: input.account || '',
    phone: input.phone || '',
    email: input.email || '',
    username: input.username || '',
    tier2Scheme: input.tier2Scheme || '',
    notes: input.notes || '',
    exemptSsnit: !!input.exemptSsnit,
    exemptTier2: !!input.exemptTier2,
    exemptPaye: !!input.exemptPaye,
  };

  if (assignedId) {
    // Editing an existing employee
    const idx = employees.findIndex(e => e.id === assignedId);
    if (idx === -1) {
      throw new functions.https.HttpsError('not-found', 'Employee not found.');
    }
    employees[idx] = { ...employees[idx], ...record, id: assignedId };
    await empRef.set(employees);
  } else {
    // New hire — assign the next id
    assignedId = 'EMP-' + String(nextId).padStart(4, '0');
    employees.push({ ...record, id: assignedId });
    await Promise.all([empRef.set(employees), idRef.set(nextId + 1)]);
  }

  return { ok: true, id: assignedId };
});

/**
 * ── deleteEmployee ── (Admin, Bursar)
 */
exports.deleteEmployee = functions.https.onCall(async (data, context) => {
  requireCallerRole(context, 'Admin', 'Bursar');
  const yearKey = data.yearKey;
  const id = String(data.id || '');
  if (!id) {
    throw new functions.https.HttpsError('invalid-argument', 'Employee id is required.');
  }

  const empRef = yearRef(yearKey, 'employees');
  const snap = await empRef.once('value');
  const employees = Array.isArray(snap.val()) ? snap.val() : [];
  const next = employees.filter(e => e.id !== id);
  if (next.length === employees.length) {
    throw new functions.https.HttpsError('not-found', 'Employee not found.');
  }
  await empRef.set(next);
  return { ok: true };
});

/**
 * ── runPayroll ── (Admin, Bursar)
 * Posts a new payroll run for a month/year/term. Re-checks for a duplicate
 * period server-side (the client's own confirm() dialog can be bypassed by
 * a modified client, so this is the check that actually matters) unless
 * `run.allowDuplicate` is explicitly set, which the client only does after
 * the user has confirmed they want to post a second run for the same period.
 *
 * Trusts the client-computed payroll `lines` (gross/SSNIT/PAYE/net etc.) —
 * replicating Ghana's PAYE tax bands here would duplicate logic that
 * already lives in computeMonthlyPAYE() on the client; this function's job
 * is access control on the locked payrollRuns subtree, not recomputation.
 */
exports.runPayroll = functions.https.onCall(async (data, context) => {
  requireCallerRole(context, 'Admin', 'Bursar');

  const yearKey = data.yearKey;
  const run = data.run || {};
  const month = String(run.month || '');
  const year = Number(run.year) || 0;
  const date = String(run.date || '');
  const lines = Array.isArray(run.lines) ? run.lines : [];

  if (!month || !year || !date) {
    throw new functions.https.HttpsError('invalid-argument', 'Month, year and payment date are required.');
  }
  if (!lines.length) {
    throw new functions.https.HttpsError('invalid-argument', 'No payroll lines to post.');
  }

  const runsRef = yearRef(yearKey, 'payrollRuns');
  const idRef = yearRef(yearKey, 'nextPrId');

  const [runsSnap, idSnap] = await Promise.all([runsRef.once('value'), idRef.once('value')]);
  const runs = Array.isArray(runsSnap.val()) ? runsSnap.val() : [];
  let nextId = idSnap.val();
  if (typeof nextId !== 'number') nextId = 1;

  const duplicate = runs.find(r => r.month === month && r.year === year);
  if (duplicate && !run.allowDuplicate) {
    throw new functions.https.HttpsError(
      'already-exists',
      `A payroll run for ${month} ${year} has already been posted.`
    );
  }

  const record = {
    id: nextId,
    month, year,
    term: run.term || '',
    date,
    approver: run.approver || '',
    notes: run.notes || '',
    lines,
    postedBy: context.auth.uid,
    postedAt: new Date().toISOString(),
  };

  runs.push(record);
  await Promise.all([runsRef.set(runs), idRef.set(nextId + 1)]);

  return { record };
});

/**
 * ── deletePayrollRunLine ── (Admin only — matches the client's own
 * requireRole('Admin') guard before this is ever called)
 * Removes one employee's line from a posted run. If that was the run's
 * last remaining line, the whole run is deleted too and `runDeleted: true`
 * is returned so the client knows to also clean up that run's SMS log.
 */
exports.deletePayrollRunLine = functions.https.onCall(async (data, context) => {
  requireCallerRole(context, 'Admin');

  const yearKey = data.yearKey;
  const runId = data.runId;
  const empId = data.empId;

  const runsRef = yearRef(yearKey, 'payrollRuns');
  const snap = await runsRef.once('value');
  const runs = Array.isArray(snap.val()) ? snap.val() : [];
  const runIdx = runs.findIndex(r => r.id === runId);
  if (runIdx === -1) {
    throw new functions.https.HttpsError('not-found', 'Payroll run not found.');
  }

  const run = runs[runIdx];
  const remainingLines = (run.lines || []).filter(l => l.empId !== empId);
  if (remainingLines.length === (run.lines || []).length) {
    throw new functions.https.HttpsError('not-found', 'Payroll line not found.');
  }

  let runDeleted = false;
  if (remainingLines.length === 0) {
    runs.splice(runIdx, 1);
    runDeleted = true;
  } else {
    runs[runIdx] = { ...run, lines: remainingLines };
  }

  await runsRef.set(runs);
  return { ok: true, runDeleted };
});

/**
 * ── editPayrollRunLine ── (Admin only — matches the client's own
 * requireRole('Admin') guard before this is ever called)
 * Replaces one line within a posted run with the client-recomputed
 * `updatedLine`, stamping editedBy/editedAt server-side so that audit
 * trail can't be spoofed by a modified client.
 */
exports.editPayrollRunLine = functions.https.onCall(async (data, context) => {
  requireCallerRole(context, 'Admin');

  const yearKey = data.yearKey;
  const runId = data.runId;
  const empId = data.empId;
  const updatedLine = data.updatedLine || {};

  const runsRef = yearRef(yearKey, 'payrollRuns');
  const snap = await runsRef.once('value');
  const runs = Array.isArray(snap.val()) ? snap.val() : [];
  const runIdx = runs.findIndex(r => r.id === runId);
  if (runIdx === -1) {
    throw new functions.https.HttpsError('not-found', 'Payroll run not found.');
  }

  const lines = runs[runIdx].lines || [];
  const lineIdx = lines.findIndex(l => l.empId === empId);
  if (lineIdx === -1) {
    throw new functions.https.HttpsError('not-found', 'Payroll line not found.');
  }

  lines[lineIdx] = {
    ...updatedLine,
    empId,
    editedBy: context.auth.uid,
    editedAt: new Date().toISOString(),
  };
  runs[runIdx] = { ...runs[runIdx], lines };

  await runsRef.set(runs);
  return { ok: true };
});
