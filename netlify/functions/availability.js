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

    // Get Zoho token
    const token = await getZohoToken();

    // All of this adviser's events that overlap this NZ date (incl. multi-day and all-day)
    const events    = await fetchOwnerEvents(token, ownerId, date, date);
    const busySlots = busySlotsForDay(events, date);

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

// ── Busy-time helpers ─────────────────────────────────────────────
// Zoho's search can only filter on when an event STARTS, so a multi-day event
// (a holiday, a conference) would be missed on every day after its first.
// We therefore look back LOOKBACK_DAYS and check for any OVERLAP with the day.
// All-day events are stored by Zoho at midnight UTC (1 pm NZ), so we treat
// them as covering whole NZ calendar dates instead of using their raw times.
const LOOKBACK_DAYS = 60;
const BUFFER_MS     = 15 * 60 * 1000;   // 15-minute gap after each timed meeting
const SLOT_MS       = 30 * 60 * 1000;

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function nzInstant(dateStr, hhmm) {
  // Absolute time (ms) of an NZ wall-clock time, e.g. ("2026-11-03", "09:30")
  const local = dateStr + 'T' + (hhmm || '00:00') + ':00';
  return new Date(local + nzOffsetString(local)).getTime();
}
function zohoDateTime(ms) {
  // "2026-11-03T00:00:00+13:00" — the format Zoho search expects
  const local = new Date(ms + nzOffsetMinutesAt(new Date(ms)) * 60000).toISOString().slice(0, 19);
  return local + nzOffsetString(local);
}

async function fetchOwnerEvents(token, ownerId, fromDate, toDate) {
  // All events for one owner that could touch NZ dates fromDate..toDate (inclusive)
  const from = zohoDateTime(nzInstant(addDays(fromDate, -LOOKBACK_DAYS)));
  const to   = zohoDateTime(nzInstant(addDays(toDate, 1)) - 1000);
  const criteria = '((Owner:equals:' + ownerId + ')and(Start_DateTime:between:' + from + ',' + to + '))';
  const events = [];
  for (let page = 1; page <= 10; page++) {
    const url = 'https://www.zohoapis.com/crm/v3/Events/search' +
      '?criteria=' + encodeURIComponent(criteria) +
      '&fields=Event_Title,Start_DateTime,End_DateTime,All_day,Owner' +
      '&per_page=200&page=' + page;
    const res = await fetch(url, { headers: { Authorization: 'Zoho-oauthtoken ' + token } });
    if (res.status === 204) break;                       // no (more) results
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch (e) { console.log('[ACRM] Parse error:', text.substring(0, 300)); break; }
    if (!data.data || !data.data.length) {
      if (data.code || data.status === 'error') throw new Error('Zoho search failed: ' + text.substring(0, 300));
      break;
    }
    events.push(...data.data);
    if (!data.info || !data.info.more_records) break;
  }
  return events.filter(e => e.Start_DateTime && e.End_DateTime && (!e.Owner || e.Owner.id === ownerId));
}

function eventInterval(ev) {
  if (ev.All_day) {
    // Use the calendar dates Zoho stored (UTC), as whole NZ days
    const first = new Date(ev.Start_DateTime).toISOString().slice(0, 10);
    const last  = new Date(ev.End_DateTime).toISOString().slice(0, 10);
    return { start: nzInstant(first), end: nzInstant(addDays(last, 1)) };
  }
  return { start: Date.parse(ev.Start_DateTime), end: Date.parse(ev.End_DateTime) + BUFFER_MS };
}

function busySlotsForDay(events, dateStr) {
  // ["09:00", "09:30", ...] — every 30-minute NZ slot on dateStr that overlaps an event
  const intervals = events.map(eventInterval);
  const slots = [];
  for (let i = 0; i < 48; i++) {
    const hhmm = String(Math.floor(i / 2)).padStart(2, '0') + ':' + (i % 2 ? '30' : '00');
    const s = nzInstant(dateStr, hhmm);
    if (intervals.some(iv => iv.start < s + SLOT_MS && iv.end > s)) slots.push(hhmm);
  }
  return slots;
}

// ── NZ timezone helpers (handle NZST +12:00 / NZDT +13:00 automatically) ──
function nzOffsetMinutesAt(date) {
  // Offset of Pacific/Auckland from UTC (in minutes) at the given instant
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Pacific/Auckland', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date);
  const m = {};
  parts.forEach(p => { m[p.type] = p.value; });
  const asUTC = Date.UTC(+m.year, +m.month - 1, +m.day, +m.hour, +m.minute, +m.second);
  return Math.round((asUTC - date.getTime()) / 60000);
}
function nzOffsetString(localDateStr) {
  // ISO offset ("+12:00" or "+13:00") for an NZ wall-clock time like "2026-10-07T09:00:00"
  const guess   = new Date(localDateStr + 'Z');
  const first   = nzOffsetMinutesAt(guess);
  const instant = new Date(guess.getTime() - first * 60000);
  const mins    = nzOffsetMinutesAt(instant);
  const sign    = mins < 0 ? '-' : '+';
  const abs     = Math.abs(mins);
  return sign + String(Math.floor(abs / 60)).padStart(2, '0') + ':' + String(abs % 60).padStart(2, '0');
}
