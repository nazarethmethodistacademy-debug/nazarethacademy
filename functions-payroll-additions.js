// ═══════════════════════════════════════════════════════════════════════
// PAYROLL / EMPLOYEE CLOUD FUNCTIONS
// Add these exports to your existing functions/index.js (alongside
// cfLogin / cfChangePassword / cfCreateUser). They assume the same
// firebase-admin + firebase-functions setup already initialized there —
// don't call admin.initializeApp() twice.
// ═══════════════════════════════════════════════════════════════════════

const functions = require('firebase-functions');
const admin = require('firebase-admin');
// (Remove this line if functions/index.js already calls it)
if (!admin.apps.length) admin.initializeApp();

const PAYROLL_WRITE_ROLES = ['Admin', 'Bursar', 'Headteacher'];

function assertPayrollRole(context) {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Sign-in required.');
  }
  const role = context.auth.token.role;
  if (!PAYROLL_WRITE_ROLES.includes(role)) {
    throw new functions.https.HttpsError(
      'permission-denied',
      'Your role (' + role + ') cannot modify payroll data.'
    );
  }
  return role;
}

function assertAdmin(context) {
  if (!context.auth || context.auth.token.role !== 'Admin') {
    throw new functions.https.HttpsError('permission-denied', 'Admin access required.');
  }
}

// ─────────────────────────────────────────────────────────────────────────
// EMPLOYEES — clean, single-path writes. Matches saveEmployee() /
// deleteEmployee() in app.html field-for-field.
// ─────────────────────────────────────────────────────────────────────────

exports.saveEmployee = functions.https.onCall(async (data, context) => {
  assertPayrollRole(context);
  const { yearKey, employee } = data;
  if (!yearKey || !employee || !employee.staffId || !employee.name || !employee.salary) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'yearKey, and employee.staffId/name/salary are required.'
    );
  }

  const db = admin.database();
  const listRef = db.ref(`nazareth_academy/${yearKey}/employees`);
  const idRef   = db.ref(`nazareth_academy/${yearKey}/nextEmpId`);

  const listSnap = await listRef.get();
  const list = listSnap.val() || [];

  let id = employee.id;
  if (!id) {
    const idSnap = await idRef.get();
    id = idSnap.val() || 1;
    await idRef.set(id + 1);
  }

  const record = { ...employee, id };
  const idx = list.findIndex(e => e.id === id);
  if (idx >= 0) list[idx] = record; else list.push(record);

  await listRef.set(list);
  return { ok: true, id };
});

exports.deleteEmployee = functions.https.onCall(async (data, context) => {
  assertPayrollRole(context);
  const { yearKey, id } = data;
  if (!yearKey || id == null) {
    throw new functions.https.HttpsError('invalid-argument', 'yearKey and id are required.');
  }
  const ref = admin.database().ref(`nazareth_academy/${yearKey}/employees`);
  const snap = await ref.get();
  const list = (snap.val() || []).filter(e => e.id !== id);
  await ref.set(list);
  return { ok: true };
});

// ─────────────────────────────────────────────────────────────────────────
// PAYROLL RUNS
//
// IMPORTANT TRADE-OFF: confirmRunPayroll() in app.html doesn't just write
// payrollRuns — it also posts to expenses + journalEntries and increments
// nextExpId, as part of the same user action (GAAP P&L recognition).
//
// This function only locks down + handles payrollRuns/nextPrId. The
// expense + journal-entry posting stays on the normal client → saveDb()
// path (still gated by the general back-office role rule, just not by a
// per-field Cloud Function). That means a payroll run becomes a TWO-STEP
// operation from the client's point of view:
//   1. await runPayroll(...)         → posts the payroll run itself
//   2. db.expenses.push(...); postJournalEntry(...); saveDb();  → as today
//
// This is NOT fully atomic — if step 2 fails after step 1 succeeds, you'd
// have a posted payroll run with no matching expense/journal entry. Given
// the original goal (protect salary data from being altered by a modified
// client, not achieve full transactional consistency across the ledger),
// I think that trade-off is reasonable to start with. If you want full
// atomicity later, this function can absorb the expense + journal posting
// too — it's more code but the same pattern, and I can build that next.
// ─────────────────────────────────────────────────────────────────────────

exports.runPayroll = functions.https.onCall(async (data, context) => {
  const role = assertPayrollRole(context);
  const { yearKey, run } = data;
  if (!yearKey || !run || !Array.isArray(run.lines) || !run.lines.length) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'A valid payroll run with at least one line is required.'
    );
  }

  const db = admin.database();
  const runsRef = db.ref(`nazareth_academy/${yearKey}/payrollRuns`);
  const idRef   = db.ref(`nazareth_academy/${yearKey}/nextPrId`);

  const idSnap = await idRef.get();
  const id = idSnap.val() || 1;
  await idRef.set(id + 1);

  const record = {
    ...run,
    id,
    postedBy:   context.auth.token.name || context.auth.uid,
    postedRole: role,
    postedAt:   new Date().toISOString()
  };

  const runsSnap = await runsRef.get();
  const runs = runsSnap.val() || [];

  // Guard against duplicate period posting server-side too — the client
  // already asks "post another run anyway?" but a modified client could
  // skip that confirm() entirely.
  const dup = runs.find(r => r.month === run.month && r.year === run.year);
  if (dup && !run.allowDuplicate) {
    throw new functions.https.HttpsError(
      'already-exists',
      `A payroll run for ${run.month} ${run.year} already exists.`
    );
  }

  runs.push(record);
  await runsRef.set(runs);

  return { ok: true, id, record };
});

exports.deletePayrollRunLine = functions.https.onCall(async (data, context) => {
  assertAdmin(context); // matches requireRole('Admin') already enforced client-side
  const { yearKey, runId, empId } = data;
  if (!yearKey || runId == null || empId == null) {
    throw new functions.https.HttpsError('invalid-argument', 'yearKey, runId and empId are required.');
  }

  const ref = admin.database().ref(`nazareth_academy/${yearKey}/payrollRuns`);
  const snap = await ref.get();
  let runs = snap.val() || [];
  const run = runs.find(r => r.id === runId);
  if (!run) throw new functions.https.HttpsError('not-found', 'Payroll run not found.');

  run.lines = (run.lines || []).filter(l => l.empId !== empId);
  let runDeleted = false;
  if (run.lines.length === 0) {
    runs = runs.filter(r => r.id !== runId); // matches client behavior: drop empty runs
    runDeleted = true;
  }

  await ref.set(runs);
  return { ok: true, runDeleted };
});

// Corrects a single posted payroll line (Admin only, matches the client's
// requireRole('Admin') for this in openEditRunLine/saveEditRunLine). Keeps
// the same audit-trail fields the client already builds (editedAt/editedBy/
// editReason/origBasic/origNet) — this function just does the actual write.
exports.editPayrollRunLine = functions.https.onCall(async (data, context) => {
  assertAdmin(context);
  const { yearKey, runId, empId, updatedLine } = data;
  if (!yearKey || runId == null || empId == null || !updatedLine) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'yearKey, runId, empId and updatedLine are required.'
    );
  }

  const ref = admin.database().ref(`nazareth_academy/${yearKey}/payrollRuns`);
  const snap = await ref.get();
  const runs = snap.val() || [];
  const run = runs.find(r => r.id === runId);
  if (!run) throw new functions.https.HttpsError('not-found', 'Payroll run not found.');
  const lineIdx = (run.lines || []).findIndex(l => l.empId === empId);
  if (lineIdx < 0) throw new functions.https.HttpsError('not-found', 'Payroll line not found.');

  run.lines[lineIdx] = {
    ...updatedLine,
    empId, // never trust the client to keep this consistent with the lookup key
    editedAt: new Date().toISOString(),
    editedBy: context.auth.token.name || context.auth.uid
  };

  await ref.set(runs);
  return { ok: true };
});
