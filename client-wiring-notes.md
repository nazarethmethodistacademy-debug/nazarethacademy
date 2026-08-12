# Client-side wiring (app.html) — reference, not yet applied

## 1. New callable handles, next to the existing ones at line ~13000

```js
const cfSaveEmployee         = fbFunctions ? fbFunctions.httpsCallable('saveEmployee')         : null;
const cfDeleteEmployee       = fbFunctions ? fbFunctions.httpsCallable('deleteEmployee')       : null;
const cfRunPayroll           = fbFunctions ? fbFunctions.httpsCallable('runPayroll')           : null;
const cfDeletePayrollRunLine = fbFunctions ? fbFunctions.httpsCallable('deletePayrollRunLine') : null;
```

## 2. `saveEmployee()` (line 10250) — replace the body from `if (_editingEmpId)` down

Before, it mutated `db.employees` locally then called the whole-doc `saveDb()`.
After, it hands the write to the Function and lets the existing realtime
listener (`fbDb.ref(FB_PATH).on('value', ...)`) sync `db.employees` back down
once the server confirms it — no local mutation needed.

```js
async function saveEmployee() {
  // ...same field reads as today (staffId, name, salary, etc.)...
  if (!staffId || !name || !salary) { toast('⚠ Staff ID, Name and Basic Salary are required', 'error'); return; }

  const employee = { id: _editingEmpId || undefined, staffId, name, dept, role, hire, status,
                      ssnit, tin, salary, transport, housing, otherAllow, bank, account,
                      phone, email, tier2Scheme, notes, exemptSsnit, exemptTier2, exemptPaye };
  try {
    await cfSaveEmployee({ yearKey: ACTIVE_YEAR, employee });
    closeModal('pr-employee-modal');
    toast('✅ Employee ' + (_editingEmpId ? 'updated' : 'registered') + ' — ' + name);
    // renderPayroll() fires from the on('value') listener once the write lands
  } catch (err) {
    toast('⚠ ' + (err.message || 'Could not save employee'), 'error');
  }
}
```

## 3. `deleteEmployee()` (line 10295)

```js
async function deleteEmployee(id) {
  const emp = (db.employees || []).find(e => e.id === id);
  if (!confirm('Remove ' + (emp ? emp.name : 'this employee') + ' from the register?')) return;
  try {
    await cfDeleteEmployee({ yearKey: ACTIVE_YEAR, id });
    toast('🗑 Employee removed');
  } catch (err) {
    toast('⚠ ' + (err.message || 'Could not remove employee'), 'error');
  }
}
```

## 4. `confirmRunPayroll()` (line 10475) — the two-step version

Keep the PAYE/SSNIT calculation exactly as-is (it's pure math, no reason to
move it server-side). Split the *posting*:

```js
async function confirmRunPayroll() {
  // ...same field reads + lines calculation as today, unchanged...

  const run = { month, year, term, date, approver, notes, lines };

  let posted;
  try {
    const result = await cfRunPayroll({ yearKey: ACTIVE_YEAR, run });
    posted = result.data.record;
  } catch (err) {
    if (err.code === 'already-exists' &&
        confirm(err.message + ' Post another run anyway?')) {
      const result = await cfRunPayroll({ yearKey: ACTIVE_YEAR, run: { ...run, allowDuplicate: true } });
      posted = result.data.record;
    } else {
      toast('⚠ ' + (err.message || 'Could not post payroll'), 'error');
      return;
    }
  }

  // Steps below are UNCHANGED from today — still go through the normal
  // saveDb() path, still gated by the general back-office rule. This is
  // the atomicity trade-off noted in functions-payroll-additions.js.
  const totalGross     = lines.reduce((a,l) => a+l.gross, 0);
  const totalEmplrCost = lines.reduce((a,l) => a+(l.emplrSsnit||0)+(l.tier2||0), 0);
  // ... db.expenses.push(...), postJournalEntry(...) exactly as today ...
  saveDb();

  closeModal('pr-run-modal');
  toast('✅ Payroll posted — ' + emps.length + ' employees · GHS ' + fmt(lines.reduce((a,l)=>a+l.net,0)) + ' net pay');
  if (document.getElementById('pr-run-send-sms')?.checked) {
    sendPayrollSmsAlerts(posted, lines, emps);
  }
}
```

## 5. `deletePayrollRunLine()` (line 10305)

```js
async function deletePayrollRunLine(runId, empId) {
  if (!requireRole('Admin')) return;
  try {
    await cfDeletePayrollRunLine({ yearKey: ACTIVE_YEAR, runId, empId });
    toast('🗑 Payroll entry removed');
  } catch (err) {
    toast('⚠ ' + (err.message || 'Could not remove entry'), 'error');
  }
}
```

## Note
The snippets above use `ACTIVE_YEAR` as a placeholder — the actual
variable in app.html is `ACTIVE_YEAR` (see `window.FB_PATH = 'nazareth_academy/' + ACTIVE_YEAR`
at line 5724). Swap in `ACTIVE_YEAR` wherever `ACTIVE_YEAR` appears above.
