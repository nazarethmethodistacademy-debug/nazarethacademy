// Netlify Function: /.netlify/functions/sms-send
// Server-side proxy to SMSOnlineGH's send-SMS endpoint. Same reasoning as sms-balance.js —
// the browser can't call SMSOnlineGH directly, so this function does it using the API key
// stored as a Netlify environment variable.
//
// Docs: https://dev.smsonlinegh.com/docs/v5/http/rest/messaging/sms_non_personalised.html

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const apiKey = process.env.SMSONLINEGH_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'SMSONLINEGH_API_KEY is not set in Netlify environment variables (Project configuration → Environment variables).' })
    };
  }

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch (e) { payload = {}; }

  const { senderId, phone, content } = payload;
  if (!phone || !content) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Both "phone" and "content" are required.' })
    };
  }

  try {
    const res = await fetch('https://api.smsonlinegh.com/v5/message/sms/send', {
      method: 'POST',
      headers: {
        'Host': 'api.smsonlinegh.com',
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': 'key ' + apiKey
      },
      body: JSON.stringify({
        text: content,
        type: 0,                      // 0 = standard GSM SMS
        sender: senderId || 'NazarethAca',
        destinations: [phone]
      })
    });

    const text = await res.text();
    let data;
    try { data = JSON.parse(text); }
    catch (e) {
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'SMSOnlineGH returned an unexpected response: ' + text.slice(0, 200) })
      };
    }

    // Pass the real SMSOnlineGH response straight through — the frontend already parses
    // { handshake, data: { destinations: [{ to, status }] } } to decide sent/failed.
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Could not reach SMSOnlineGH: ' + e.message })
    };
  }
};
