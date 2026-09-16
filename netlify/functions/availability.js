// ── Adviser CRM Availability Endpoint ─────────────────────────────
// Netlify Function: netlify/functions/availability.js
//
// Checks Zoho CRM Events for an adviser on a given date
// Returns array of busy time slots so booking page can show real availability
//
// GET /.netlify/functions/availability?adviserId=adviser_a&date=2026-09-10

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
// Note: Update ZOHO_OWNER_B in Netlify env vars to Dennis's Zoho user ID

// ── CORS headers ──────────────────────────────────────────────────
function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.some(o => origin && origin.startsWith(o))
    ? origin : '*';
  return {
    'Access-Control-Allow-Origin':  allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

exports.handler = async function(event) {
  const origin  = event.headers.origin || event.headers.Origin || '';
  const headers = { ...corsHeaders(origin), 'Content-Type': 'application/json' };

  // Handle preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    const params    = event.queryStringParameters || {};
    const adviserId = params.adviserId;
    const date      = params.date; // YYYY-MM-DD

    // Validate
    if (!adviserId || !ZOHO_OWNER_IDS[adviserId]) {
      return { statusCode: 200, headers, body: JSON.stringify({ error: 'Invalid adviser' }) };
    }
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return { statusCode: 200, headers, body: JSON.stringify({ error: 'Invalid date' }) };
    }

    const ownerId = ZOHO_OWNER_IDS[adviserId];

    // Build start/end of day in NZ time (UTC+12 or UTC+13)
    // Use broad range to catch events in both NZST (+12) and NZDT (+13)
    const startOfDay = date + 'T00:00:00+12:00';
    const endOfDay   = date + 'T23:59:59+13:00';

    // Get Zoho token
    const token = await getZohoToken();

    // Search Zoho CRM Events for this adviser on this date
    const busySlots = await getAdviserEvents(token, ownerId, startOfDay, endOfDay);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success:    true,
        date:       date,
        adviserId:  adviserId,
        busySlots:  busySlots,
      }),
    };

  } catch (err) {
    console.error('[ACRM] Availability error:', err);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: false, busySlots: [], error: err.message }),
    };
  }
};

// ── Get Zoho OAuth token ──────────────────────────────────────────
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
  if (!data.access_token) throw new Error('Zoho token failed: ' + JSON.stringify(data));
  return data.access_token;
}

// ── Get adviser events from Zoho CRM ─────────────────────────────
async function getAdviserEvents(token, ownerId, startOfDay, endOfDay) {
  // Use Zoho CRM search API with criteria
  // COQL doesn't support Owner.id in WHERE — use search instead
  const startEncoded = encodeURIComponent(startOfDay);
  const endEncoded   = encodeURIComponent(endOfDay);

  // Search using Zoho CRM search API with date criteria
  // This is more targeted than fetching all events
  const searchUrl = 'https://www.zohoapis.com/crm/v3/Events/search' +
    '?criteria=(Start_DateTime:between:' + encodeURIComponent(startOfDay + ',' + endOfDay) + ')' +
    '&fields=Event_Title,Start_DateTime,End_DateTime,Owner' +
    '&per_page=50';

  console.log('[ACRM] Search URL:', searchUrl);

  const res = await fetch(searchUrl, {
    headers: {
      Authorization: 'Zoho-oauthtoken ' + token,
      'Content-Type': 'application/json',
    },
  });

  const text = await res.text();
  console.log('[ACRM] Raw Zoho response:', text.substring(0, 1000));

  let data;
  try { data = JSON.parse(text); }
  catch(e) { console.log('[ACRM] Parse error:', e.message); return []; }

  if (!data.data || !data.data.length) {
    console.log('[ACRM] No events found for date range');
    return [];
  }

  // Filter by owner on our side
  data.data = data.data.filter(function(event) {
    if (!event.Start_DateTime) return false;
    if (event.Owner && event.Owner.id !== ownerId) return false;
    return true;
  });

  console.log('[ACRM] Filtered to', data.data.length, 'events for owner', ownerId);

  if (!data.data.length) {
    console.log('[ACRM] No events for this adviser on this date');
    return [];
  }

  console.log('[ACRM] Found', data.data.length, 'events');

  // NZ is UTC+12 (NZST) in September before daylight saving
  const NZ_OFFSET_MS = 12 * 60 * 60 * 1000;

  const busySlots = [];
  data.data.forEach(function(event) {
    if (!event.Start_DateTime || !event.End_DateTime) return;
    console.log('[ACRM] Event:', event.Event_Title, event.Start_DateTime, '-', event.End_DateTime);

    const startUTC = new Date(event.Start_DateTime);
    const endUTC   = new Date(event.End_DateTime);
    const startNZ  = new Date(startUTC.getTime() + NZ_OFFSET_MS);
    // Add 15 minute buffer after each meeting
    const BUFFER_MS = 15 * 60 * 1000;
    const endNZ    = new Date(endUTC.getTime() + NZ_OFFSET_MS + BUFFER_MS);

    console.log('[ACRM] NZ time:', startNZ.toISOString(), '-', endNZ.toISOString());

    // Generate 30-min slots covered by this event
    var slotTime = new Date(startNZ);
    var mins = slotTime.getUTCMinutes();
    slotTime.setUTCMinutes(mins < 30 ? 0 : 30, 0, 0);

    while (slotTime < endNZ) {
      var hh = String(slotTime.getUTCHours()).padStart(2, '0');
      var mm = String(slotTime.getUTCMinutes()).padStart(2, '0');
      busySlots.push(hh + ':' + mm);
      slotTime.setUTCMinutes(slotTime.getUTCMinutes() + 30);
    }
  });

  return busySlots;
}
