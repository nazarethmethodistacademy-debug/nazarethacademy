// Netlify Function: /.netlify/functions/sms-balance
// Server-side proxy to SMSOnlineGH's account balance endpoint. The browser can never call
// api.smsonlinegh.com directly (no CORS support on their side), so this function does it
// instead, using the API key stored as a Netlify environment variable (never sent to the browser).
//
// Docs: https://dev.smsonlinegh.com/docs/v5/http/balance.html

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

  try {
    const res = await fetch('https://api.smsonlinegh.com/v5/account/balance', {
      method: 'POST',
      headers: {
        'Host': 'api.smsonlinegh.com',
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': 'key ' + apiKey
      },
      body: JSON.stringify({})
    });

    const text = await res.text();
    let data;
    try { data = JSON.parse(text); }
    catch (e) {
      // SMSOnlineGH returned something that isn't JSON (rare, but happens on some error pages)
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'SMSOnlineGH returned an unexpected response: ' + text.slice(0, 200) })
      };
    }

    // Pass the real SMSOnlineGH response straight through — the frontend already knows how
    // to read { handshake, data } and turn it into a balance/error message.
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
