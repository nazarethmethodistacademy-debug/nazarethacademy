// netlify/functions/ai-assist.js
//
// Single shared proxy for all three AI features (AI Insight narrative, AI Chat
// Assistant, Anomaly Detection narrative) — same reasoning as sms-send.js:
// the API key lives here as a server-side env var, never in the client.
//
// Setup required before this works:
//   1. Netlify dashboard → Site settings → Environment variables →
//      add ANTHROPIC_API_KEY = <your key from console.anthropic.com>
//   2. (Recommended) add FIREBASE_SERVICE_ACCOUNT_JSON the same way your
//      Cloud Functions already authenticate, if you want to verify the
//      caller is a signed-in staff member before spending API credits —
//      see verifyCaller() below. Ships DISABLED by default so this works
//      immediately; flip REQUIRE_AUTH to true once you've added it.
//
// This function deliberately does NOT accept raw student PII dumps — every
// caller on the client side sends a small, pre-aggregated summary (names +
// numbers), not full records. Keeping that boundary in the client code is
// what keeps this safe to call; see the three call sites in app.html.

const REQUIRE_AUTH = false; // set true once FIREBASE_SERVICE_ACCOUNT_JSON is configured

const MODEL = 'claude-haiku-4-5-20251001'; // fast + cheap, right fit for short narrative summaries
const MAX_TOKENS = 500;

const SYSTEM_PROMPTS = {
  insight: `You are a plain-spoken assistant writing a short summary for a school bursar/admin about ONE student's fee, attendance, and academic standing. You'll be given a JSON object of already-computed numbers (not raw records). Write 2-4 sentences, warm but factual, no bullet points, no headers. Do not invent numbers not present in the data. Do not give legal, medical, or safeguarding advice — if something looks concerning, say the school should follow up directly rather than speculating why.`,

  chat: `You are a data assistant for "Ecole Systems", a school finance app. You'll be given a JSON snapshot of aggregate school data (enrollment totals, fee totals, top owing students, attendance rate, payroll/expense totals) and a staff member's question. Answer ONLY using the numbers in the snapshot. If the question needs data not present in the snapshot (e.g. one specific student's full payment history, or anything before/after the snapshot's period), say plainly that you don't have that level of detail here and suggest which page of the app would have it (Payment Tracker, Student Records, Attendance Report, etc.) — do not guess or make up figures. Keep answers under 5 sentences.`,

  anomaly: `You are a plain-spoken assistant summarizing a list of already-flagged financial anomalies (statistical outliers and duplicate entries) for a school bursar. You'll be given a JSON list of flagged items with the reason each was flagged. Write a short summary (3-5 sentences or a short list) explaining what was found and why it's worth a human looking at it. Do NOT accuse anyone of wrongdoing or use words like "fraud"/"theft"/"embezzlement" — these are statistical flags for review, not conclusions. Stay neutral and factual.`
};

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY is not configured on the server.' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const { mode, data, question } = payload;
  if (!SYSTEM_PROMPTS[mode]) {
    return { statusCode: 400, body: JSON.stringify({ error: 'mode must be one of: insight, chat, anomaly' }) };
  }

  if (REQUIRE_AUTH) {
    const authResult = await verifyCaller(event.headers.authorization);
    if (!authResult.ok) {
      return { statusCode: 401, body: JSON.stringify({ error: authResult.message }) };
    }
  }

  // Basic payload-size guard — this endpoint should only ever receive small
  // aggregated summaries, never a raw table dump. If something client-side
  // starts sending more than this, that's a bug to fix there, not here.
  const bodySize = JSON.stringify(data || {}).length;
  if (bodySize > 20000) {
    return { statusCode: 413, body: JSON.stringify({ error: 'Data payload too large — this endpoint expects an aggregated summary, not raw records.' }) };
  }

  const userContent = mode === 'chat'
    ? `Data snapshot:\n${JSON.stringify(data, null, 2)}\n\nQuestion: ${question || ''}`
    : `Data:\n${JSON.stringify(data, null, 2)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPTS[mode],
        messages: [{ role: 'user', content: userContent }]
      })
    });
    clearTimeout(timer);

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return { statusCode: res.status, body: JSON.stringify({ error: 'AI provider error', detail: errText.slice(0, 300) }) };
    }

    const json = await res.json();
    const text = (json.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) };
  } catch (e) {
    clearTimeout(timer);
    const isTimeout = e.name === 'AbortError';
    return { statusCode: 502, body: JSON.stringify({ error: isTimeout ? 'AI request timed out' : (e.message || 'Network error') }) };
  }
};

// Optional: verify the caller is a signed-in staff member before spending
// API credits. Mirrors the same custom-claims pattern your Cloud Functions
// already use for login. Requires the client to send the Firebase ID token
// as `Authorization: Bearer <token>` (see callAiAssist() in app.html) and
// FIREBASE_SERVICE_ACCOUNT_JSON to be set as a Netlify env var (paste the
// full service account JSON as a single-line string).
async function verifyCaller(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { ok: false, message: 'Missing Authorization header' };
  }
  try {
    const admin = require('firebase-admin');
    if (!admin.apps.length) {
      const svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
      admin.initializeApp({ credential: admin.credential.cert(svc) });
    }
    const token = authHeader.slice(7);
    const decoded = await admin.auth().verifyIdToken(token);
    if (!decoded.role) return { ok: false, message: 'No role claim on token' };
    return { ok: true, role: decoded.role };
  } catch (e) {
    return { ok: false, message: 'Invalid or expired token' };
  }
}
