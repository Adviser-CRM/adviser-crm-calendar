// ── Adviser CRM Monthly Availability Endpoint ─────────────────────
// Netlify Function: netlify/functions/monthly.js
//
// Returns busy slots for an adviser for an entire month
// GET /.netlify/functions/monthly?adviserId=adviser_a&year=2026&month=9

const ALLOWED_ORIGINS = [
  'https://adviser-crm.github.io',
  'https://calendar.advisercrm.co.nz',
  'https://www.advisercrm.co.nz',
  'https://advisercrm.co.nz',
  'http://localhost',
];

const ZOHO_OWNER_IDS = {
  adviser_a: process.env.ZOHO_OWNER_A || '1484359000000083003',
  adviser_b: process.env.ZOHO_OWNER_B || '1484359000123904001',
};

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.some(o => origin && origin.startsWith(o))
    ? origin : '*';
  return {
    'Access-Control-Allow-Origin':  allowed,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

exports.handler = async function(event) {
  const origin  = event.headers.origin || event.headers.Origin || '';
  const headers = { ...corsHeaders(origin), 'Content-Type': 'application/json' };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    const params    = event.queryStringParameters || {};
    const adviserId = params.adviserId;
    const year      = parseInt(params.year);
    const month     = parseInt(params.month); // 1-based

    if (!adviserId || !ZOHO_OWNER_IDS[adviserId]) {
      return { statusCode: 200, headers, body: JSON.stringify({ error: 'Invalid adviser' }) };
    }
    if (!year || !month || month < 1 || month > 12) {
      return { statusCode: 200, headers, body: JSON.stringify({ error: 'Invalid year/month' }) };
    }

    const ownerId = ZOHO_OWNER_IDS[adviserId];

    // Build month date range
    const startOfMonth = year + '-' + String(month).padStart(2, '0') + '-01T00:00:00+12:00';
    const lastDay      = new Date(year, month, 0).getDate();
    const endOfMonth   = year + '-' + String(month).padStart(2, '0') + '-' +
      String(lastDay).padStart(2, '0') + 'T23:59:59+13:00';

    console.log('[ACRM] Monthly fetch:', adviserId, year, month, startOfMonth, '->', endOfMonth);

    const token  = await getZohoToken();
    const events = await getMonthEvents(token, ownerId, startOfMonth, endOfMonth);

    // Build a map of date → { morning: bool, afternoon: bool }
    // morning = any busy slot 09:00-11:30
    // afternoon = any busy slot 12:00-16:30
    const busyByDay = {};

    events.forEach(function(event) {
      if (!event.Start_DateTime || !event.End_DateTime) return;

      const NZ_OFFSET_MS = 12 * 60 * 60 * 1000;
      const startUTC = new Date(event.Start_DateTime);
      const endUTC   = new Date(event.End_DateTime);
      const startNZ  = new Date(startUTC.getTime() + NZ_OFFSET_MS);
      // Add 15 minute buffer after each meeting
      const endNZ    = new Date(endUTC.getTime()   + NZ_OFFSET_MS + (15 * 60 * 1000));

      // Get the date key YYYY-MM-DD
      const dateKey = startNZ.getUTCFullYear() + '-' +
        String(startNZ.getUTCMonth() + 1).padStart(2, '0') + '-' +
        String(startNZ.getUTCDate()).padStart(2, '0');

      if (!busyByDay[dateKey]) busyByDay[dateKey] = [];

      // Generate 30-min busy slots
      var slotTime = new Date(startNZ);
      var mins = slotTime.getUTCMinutes();
      slotTime.setUTCMinutes(mins < 30 ? 0 : 30, 0, 0);

      while (slotTime < endNZ) {
        var hh = String(slotTime.getUTCHours()).padStart(2, '0');
        var mm = String(slotTime.getUTCMinutes()).padStart(2, '0');
        busyByDay[dateKey].push(hh + ':' + mm);
        slotTime.setUTCMinutes(slotTime.getUTCMinutes() + 30);
      }
    });

    // Deduplicate
    Object.keys(busyByDay).forEach(function(d) {
      busyByDay[d] = busyByDay[d].filter(function(s, i, a) { return a.indexOf(s) === i; });
    });

    console.log('[ACRM] Monthly busy days:', Object.keys(busyByDay).length);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success:   true,
        adviserId: adviserId,
        year:      year,
        month:     month,
        busyByDay: busyByDay,
      }),
    };

  } catch(err) {
    console.error('[ACRM] Monthly error:', err);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: false, busyByDay: {}, error: err.message }),
    };
  }
};

async function getZohoToken() {
  const res = await fetch(
    'https://accounts.zoho.com/oauth/v2/token' +
    '?grant_type=refresh_token' +
    '&client_id='     + process.env.ZOHO_CLIENT_ID +
    '&client_secret=' + process.env.ZOHO_CLIENT_SECRET +
    '&refresh_token=' + process.env.ZOHO_REFRESH_TOKEN,
    { method: 'POST' }
  );
  const data = await res.json();
  if (!data.access_token) throw new Error('Zoho token failed');
  return data.access_token;
}

async function getMonthEvents(token, ownerId, startOfMonth, endOfMonth) {
  const searchUrl = 'https://www.zohoapis.com/crm/v3/Events/search' +
    '?criteria=(Start_DateTime:between:' +
    encodeURIComponent(startOfMonth + ',' + endOfMonth) + ')' +
    '&fields=Event_Title,Start_DateTime,End_DateTime,Owner' +
    '&per_page=100';

  const res = await fetch(searchUrl, {
    headers: {
      Authorization: 'Zoho-oauthtoken ' + token,
      'Content-Type': 'application/json',
    },
  });

  const text = await res.text();
  console.log('[ACRM] Monthly Zoho response:', text.substring(0, 300));

  let data;
  try { data = JSON.parse(text); }
  catch(e) { return []; }

  if (!data.data || !data.data.length) return [];

  // Filter by owner
  return data.data.filter(function(e) {
    return e.Owner && e.Owner.id === ownerId;
  });
}
