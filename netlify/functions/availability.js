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
  adviser_b: process.env.ZOHO_OWNER_B || '1484359000177588001',
};

// ── CORS headers ──────────────────────────────────────────────────
function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.some(o => origin && origin.startsWith(o))
    ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin':  allowed,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
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
    // Use UTC+12 as safe default (NZST)
    const startOfDay = date + 'T00:00:00+12:00';
    const endOfDay   = date + 'T23:59:59+12:00';

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
  // Search Events where Owner = adviser and date overlaps with our day
  const criteria = encodeURIComponent(
    '(Owner:equals:' + ownerId + ')' +
    'and(Start_DateTime:between:' + startOfDay + ',' + endOfDay + ')'
  );

  const res = await fetch(
    'https://www.zohoapis.com/crm/v3/Events/search?criteria=' + criteria +
    '&fields=Event_Title,Start_DateTime,End_DateTime&per_page=50',
    {
      headers: {
        Authorization: 'Zoho-oauthtoken ' + token,
        'Content-Type': 'application/json',
      },
    }
  );

  const data = await res.json();

  if (!data.data || !data.data.length) {
    console.log('[ACRM] No events found for adviser on', startOfDay);
    return [];
  }

  console.log('[ACRM] Found', data.data.length, 'events for adviser');

  // Convert events to busy time ranges (HH:MM format)
  const busySlots = [];
  data.data.forEach(function(event) {
    if (!event.Start_DateTime || !event.End_DateTime) return;

    const start = new Date(event.Start_DateTime);
    const end   = new Date(event.End_DateTime);

    // Generate all 30-min slots that overlap with this event
    var slotTime = new Date(start);
    // Round down to nearest 30 min
    slotTime.setMinutes(slotTime.getMinutes() < 30 ? 0 : 30, 0, 0);

    while (slotTime < end) {
      var hh = String(slotTime.getUTCHours() + 12).padStart(2, '0'); // NZ offset
      if (parseInt(hh) >= 24) hh = String(parseInt(hh) - 24).padStart(2, '0');
      var mm = String(slotTime.getMinutes()).padStart(2, '0');
      busySlots.push(hh + ':' + mm);
      slotTime.setMinutes(slotTime.getMinutes() + 30);
    }
  });

  // Deduplicate slots
  var unique = busySlots.filter(function(slot, idx) {
    return busySlots.indexOf(slot) === idx;
  });
  console.log('[ACRM] Busy slots:', unique);
  return unique;
}
