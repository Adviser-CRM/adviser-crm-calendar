// ── Adviser CRM Booking Endpoint ──────────────────────────────────
// Netlify Function: netlify/functions/book.js
// 
// Environment variables required (set in Netlify dashboard):
//   ZOOM_ACCOUNT_ID
//   ZOOM_CLIENT_ID
//   ZOOM_CLIENT_SECRET
//   ZOHO_CLIENT_ID
//   ZOHO_CLIENT_SECRET
//   ZOHO_REFRESH_TOKEN
//   EMAIL_FROM          (e.g. bookings@advisercrm.co.nz)
//   NOTIFY_EMAIL        (internal notification email)
//
// Dependencies: none (uses built-in fetch — Node 18+)

const ALLOWED_ORIGINS = [
  'https://adviser-crm.github.io',
  'https://calendar.advisercrm.co.nz',
  'https://www.advisercrm.co.nz',
  'https://advisercrm.co.nz',
  'http://localhost',
];

const MEETING_TYPES = {
  demo:       { name: 'Product Demo',               duration: 60 },
  support:    { name: 'Technical Support',           duration: 30 },
  onboarding: { name: 'New User Onboarding',         duration: 60 },
  training:   { name: 'Training',                    duration: 60 },
  billing:    { name: 'Account & Billing Review',    duration: 30 },
  change:     { name: 'I Want to Change Something',  duration: 30 },
  new:        { name: 'I Want to Add Something New', duration: 30 },
};

const ADVISERS = {
  'adviser_a': { email: process.env.ADVISER_A_EMAIL || 'seand@advisercrm.co.nz',   name: 'Sean Davis' },
  'adviser_b': { email: process.env.ADVISER_B_EMAIL || 'kyra@advisercrm.co.nz',    name: 'Kyra Santulio' },
};

// ── CORS headers ──────────────────────────────────────────────────
function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.some(o => origin && origin.startsWith(o))
    ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin':  allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

// ── Main handler ──────────────────────────────────────────────────
exports.handler = async function(event, context) {
  const origin = event.headers.origin || event.headers.Origin || '';
  const headers = { ...corsHeaders(origin), 'Content-Type': 'application/json' };

  // Handle preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 200, headers, body: JSON.stringify({ success: false, error: 'Method not allowed' }) };
  }

  try {
    // ── Parse + validate payload ────────────────────────────────
    const payload = JSON.parse(event.body || '{}');
    const { meetingType, adviserId, event: evt, client } = payload;

    // Validate required fields
    const errors = [];
    if (!meetingType || !MEETING_TYPES[meetingType]) errors.push('Invalid meeting type');
    if (!adviserId  || !ADVISERS[adviserId])         errors.push('Invalid adviser');
    if (!client?.firstName?.trim())                  errors.push('First name required');
    if (!client?.lastName?.trim())                   errors.push('Last name required');
    if (!client?.email?.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) errors.push('Valid email required');
    if (!client?.phone?.trim())                      errors.push('Phone required');
    if (!evt?.Start_DateTime)                        errors.push('Start time required');

    if (errors.length) {
      return { statusCode: 200, headers, body: JSON.stringify({ success: false, error: errors.join(', ') }) };
    }

    // Validate start time is in the future
    if (new Date(evt.Start_DateTime) < new Date()) {
      return { statusCode: 200, headers, body: JSON.stringify({ success: false, error: 'Booking time must be in the future' }) };
    }

    const mt      = MEETING_TYPES[meetingType];
    const adviser = ADVISERS[adviserId];
    const ref     = generateRef();
    const clientName = client.firstName + ' ' + client.lastName;

    console.log('[ACRM] Booking request:', ref, meetingType, clientName, evt.Start_DateTime);

    // ── Step 1: Create Zoom meeting ─────────────────────────────
    let zoomJoinUrl  = null;
    let zoomStartUrl = null;
    let zoomId       = null;
    let zoomPassword = null;

    try {
      const zoomToken = await getZoomToken();
      const zoomMeeting = await createZoomMeeting(zoomToken, {
        topic:      mt.name + ' — ' + clientName,
        startTime:  evt.Start_DateTime,
        duration:   mt.duration,
        agenda:     'Booked via Adviser CRM booking page. Ref: ' + ref,
        hostEmail:  adviser.email,
      });
      zoomJoinUrl  = zoomMeeting.join_url;
      zoomStartUrl = zoomMeeting.start_url;
      zoomId       = zoomMeeting.id;
      zoomPassword = zoomMeeting.password;
      console.log('[ACRM] Zoom meeting created:', zoomId);
    } catch (zoomErr) {
      console.error('[ACRM] Zoom error:', zoomErr.message);
      // Don't fail the whole booking — continue without Zoom
      zoomJoinUrl = 'https://zoom.us (link will be sent separately)';
    }

    // ── Step 2: Create Zoho CRM Event ──────────────────────────
    try {
      const zohoToken = await getZohoToken();
      const description = [
        'ONLINE BOOKING — Ref: ' + ref,
        '',
        'Client: ' + clientName,
        'Email:  ' + client.email,
        'Phone:  ' + client.phone,
        client.notes ? 'Notes: ' + client.notes : '',
        '',
        'Zoom Join URL:    ' + (zoomJoinUrl  || 'N/A'),
        'Zoom Meeting ID:  ' + (zoomId       || 'N/A'),
        'Zoom Passcode:    ' + (zoomPassword || 'N/A'),
        '',
        'Host start URL:   ' + (zoomStartUrl || 'N/A'),
      ].filter(Boolean).join('\n');

      await createZohoEvent(zohoToken, {
        Event_Title:    mt.name + ' — ' + clientName + ' (Online Booking)',
        Start_DateTime: toNZISO(evt.Start_DateTime),
        End_DateTime:   toNZISO(evt.End_DateTime),
        Owner:          { id: getZohoOwnerId(adviserId) },
        Venue:          zoomJoinUrl || 'Online — Zoom',
        Description:    description,
      });
      console.log('[ACRM] Zoho event created');
    } catch (zohoErr) {
      console.error('[ACRM] Zoho error:', zohoErr.message);
      // Don't fail — log and continue
    }

    // ── Step 3: Send emails ─────────────────────────────────────
    const dateLabel = formatDateTime(evt.Start_DateTime);

    // Client email
    try {
      await sendEmail({
        to:      client.email,
        subject: 'Your ' + mt.name + ' is confirmed — ' + dateLabel,
        html:    clientEmailHtml({
          clientName, mt, adviser, dateLabel, zoomJoinUrl,
          zoomId, zoomPassword, ref,
        }),
      });
      console.log('[ACRM] Client email sent to:', client.email);
    } catch (emailErr) {
      console.error('[ACRM] Client email error:', emailErr.message);
    }

    // Adviser email
    try {
      await sendEmail({
        to:      adviser.email,
        subject: 'New booking: ' + mt.name + ' with ' + clientName + ' — ' + dateLabel,
        html:    adviserEmailHtml({
          clientName, client, mt, dateLabel,
          zoomStartUrl, zoomJoinUrl, zoomId, ref,
        }),
      });
      console.log('[ACRM] Adviser email sent to:', adviser.email);
    } catch (emailErr) {
      console.error('[ACRM] Adviser email error:', emailErr.message);
    }

    // ── Success ─────────────────────────────────────────────────
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success:      true,
        reference:    ref,
        zoomJoinUrl:  zoomJoinUrl,
        zoomMeetingId: String(zoomId || ''),
      }),
    };

  } catch (err) {
    console.error('[ACRM] Unexpected error:', err);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: false, error: 'An unexpected error occurred. Please try again or contact us directly.' }),
    };
  }
};

// ── Zoom helpers ──────────────────────────────────────────────────
async function getZoomToken() {
  const creds = Buffer.from(
    process.env.ZOOM_CLIENT_ID + ':' + process.env.ZOOM_CLIENT_SECRET
  ).toString('base64');

  const res = await fetch(
    'https://zoom.us/oauth/token?grant_type=account_credentials&account_id=' +
    process.env.ZOOM_ACCOUNT_ID,
    { method: 'POST', headers: { Authorization: 'Basic ' + creds } }
  );
  const data = await res.json();
  if (!data.access_token) throw new Error('Zoom token failed: ' + JSON.stringify(data));
  return data.access_token;
}

async function createZoomMeeting(token, opts) {
  const res = await fetch(
    'https://api.zoom.us/v2/users/' + encodeURIComponent(opts.hostEmail) + '/meetings',
    {
      method:  'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic:      opts.topic,
        type:       2,
        start_time: opts.startTime,
        duration:   opts.duration,
        timezone:   'Pacific/Auckland',
        agenda:     opts.agenda,
        settings: {
          host_video:       true,
          participant_video: true,
          join_before_host: false,
          waiting_room:     true,
          auto_recording:   'none',
        },
      }),
    }
  );
  const data = await res.json();
  if (!data.join_url) throw new Error('Zoom meeting creation failed: ' + JSON.stringify(data));
  return data;
}

// ── Zoho helpers ──────────────────────────────────────────────────
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

async function createZohoEvent(token, eventData) {
  const res = await fetch('https://www.zohoapis.com/crm/v3/Events', {
    method:  'POST',
    headers: { Authorization: 'Zoho-oauthtoken ' + token, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ data: [eventData] }),
  });
  const data = await res.json();
  if (data.data && data.data[0] && data.data[0].status === 'error') {
    throw new Error('Zoho event failed: ' + JSON.stringify(data.data[0]));
  }
  return data;
}

// Map adviser key to Zoho user ID
function getZohoOwnerId(adviserId) {
  const ids = {
    adviser_a: process.env.ZOHO_OWNER_A || '1484359000000083003',
    adviser_b: process.env.ZOHO_OWNER_B || '1484359000177588001',
  };
  return ids[adviserId] || ids.adviser_a;
}

// ── Email helpers ─────────────────────────────────────────────────
// Using Netlify's built-in email or a simple SMTP approach
// For now we use fetch to call an email API (e.g. Resend — free tier)
async function sendEmail({ to, subject, html }) {
  if (!process.env.RESEND_API_KEY) {
    console.log('[ACRM] No email API key — skipping email to:', to);
    return;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method:  'POST',
    headers: {
      Authorization:  'Bearer ' + process.env.RESEND_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from:    process.env.EMAIL_FROM || 'bookings@advisercrm.co.nz',
      to:      [to],
      subject: subject,
      html:    html,
    }),
  });
  const data = await res.json();
  if (data.statusCode && data.statusCode !== 200) {
    throw new Error('Email failed: ' + JSON.stringify(data));
  }
  return data;
}

// ── Email templates ───────────────────────────────────────────────
function clientEmailHtml({ clientName, mt, adviser, dateLabel, zoomJoinUrl, zoomId, zoomPassword, ref }) {
  return `<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px;">
  <div style="background:#07385D;padding:24px;border-radius:12px 12px 0 0;text-align:center;">
    <h1 style="color:#fff;margin:0;font-size:22px;">Booking Confirmed ✓</h1>
  </div>
  <div style="background:#fff;padding:28px;border:1px solid #e8edf2;border-top:none;border-radius:0 0 12px 12px;">
    <p style="color:#5a7080;">Hi ${clientName},</p>
    <p style="color:#1a2b3c;">Your <strong>${mt.name}</strong> has been confirmed. Here are your details:</p>
    <table style="width:100%;border-collapse:collapse;margin:20px 0;">
      <tr><td style="padding:10px;background:#f4f7fa;font-weight:600;color:#07385D;width:40%;">Meeting</td><td style="padding:10px;border-bottom:1px solid #e8edf2;">${mt.name}</td></tr>
      <tr><td style="padding:10px;background:#f4f7fa;font-weight:600;color:#07385D;">Date & Time</td><td style="padding:10px;border-bottom:1px solid #e8edf2;">${dateLabel} (NZ Time)</td></tr>
      <tr><td style="padding:10px;background:#f4f7fa;font-weight:600;color:#07385D;">Duration</td><td style="padding:10px;border-bottom:1px solid #e8edf2;">${mt.duration} minutes</td></tr>
      <tr><td style="padding:10px;background:#f4f7fa;font-weight:600;color:#07385D;">Meeting ID</td><td style="padding:10px;border-bottom:1px solid #e8edf2;">${zoomId || 'See link below'}</td></tr>
      <tr><td style="padding:10px;background:#f4f7fa;font-weight:600;color:#07385D;">Passcode</td><td style="padding:10px;border-bottom:1px solid #e8edf2;">${zoomPassword || 'N/A'}</td></tr>
      <tr><td style="padding:10px;background:#f4f7fa;font-weight:600;color:#07385D;">Reference</td><td style="padding:10px;">${ref}</td></tr>
    </table>
    <div style="text-align:center;margin:28px 0;">
      <a href="${zoomJoinUrl}" style="background:#00ABE6;color:#fff;padding:14px 32px;border-radius:10px;text-decoration:none;font-weight:700;font-size:16px;">Join Zoom Meeting</a>
    </div>
    <p style="color:#5a7080;font-size:13px;">Or copy this link into your browser:<br><a href="${zoomJoinUrl}" style="color:#00ABE6;">${zoomJoinUrl}</a></p>
    <hr style="border:none;border-top:1px solid #e8edf2;margin:24px 0;">
    <p style="color:#98aab8;font-size:12px;text-align:center;">Need to reschedule? Reply to this email or contact us at support@advisercrm.co.nz</p>
    <p style="color:#98aab8;font-size:12px;text-align:center;">© Adviser CRM · Designed for Advice. Built for Growth.</p>
  </div>
</body></html>`;
}

function adviserEmailHtml({ clientName, client, mt, dateLabel, zoomStartUrl, zoomJoinUrl, zoomId, ref }) {
  return `<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px;">
  <div style="background:#07385D;padding:20px;border-radius:12px 12px 0 0;">
    <h1 style="color:#fff;margin:0;font-size:18px;">New Booking: ${mt.name}</h1>
    <p style="color:#00ABE6;margin:4px 0 0;">Ref: ${ref}</p>
  </div>
  <div style="background:#fff;padding:24px;border:1px solid #e8edf2;border-top:none;border-radius:0 0 12px 12px;">
    <h2 style="color:#07385D;font-size:15px;">Client Details</h2>
    <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
      <tr><td style="padding:8px;background:#f4f7fa;font-weight:600;color:#07385D;width:35%;">Name</td><td style="padding:8px;border-bottom:1px solid #e8edf2;">${clientName}</td></tr>
      <tr><td style="padding:8px;background:#f4f7fa;font-weight:600;color:#07385D;">Email</td><td style="padding:8px;border-bottom:1px solid #e8edf2;"><a href="mailto:${client.email}">${client.email}</a></td></tr>
      <tr><td style="padding:8px;background:#f4f7fa;font-weight:600;color:#07385D;">Phone</td><td style="padding:8px;border-bottom:1px solid #e8edf2;">${client.phone}</td></tr>
      ${client.notes ? `<tr><td style="padding:8px;background:#f4f7fa;font-weight:600;color:#07385D;">Notes</td><td style="padding:8px;border-bottom:1px solid #e8edf2;">${client.notes}</td></tr>` : ''}
    </table>
    <h2 style="color:#07385D;font-size:15px;">Meeting Details</h2>
    <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
      <tr><td style="padding:8px;background:#f4f7fa;font-weight:600;color:#07385D;width:35%;">Type</td><td style="padding:8px;border-bottom:1px solid #e8edf2;">${mt.name}</td></tr>
      <tr><td style="padding:8px;background:#f4f7fa;font-weight:600;color:#07385D;">Date & Time</td><td style="padding:8px;border-bottom:1px solid #e8edf2;">${dateLabel} (NZ Time)</td></tr>
      <tr><td style="padding:8px;background:#f4f7fa;font-weight:600;color:#07385D;">Duration</td><td style="padding:8px;border-bottom:1px solid #e8edf2;">${mt.duration} minutes</td></tr>
      <tr><td style="padding:8px;background:#f4f7fa;font-weight:600;color:#07385D;">Zoom ID</td><td style="padding:8px;">${zoomId || 'See link'}</td></tr>
    </table>
    <div style="text-align:center;margin:20px 0;">
      <a href="${zoomStartUrl || zoomJoinUrl}" style="background:#059669;color:#fff;padding:12px 28px;border-radius:10px;text-decoration:none;font-weight:700;">Start Zoom Meeting (Host Link)</a>
    </div>
    <p style="color:#98aab8;font-size:12px;text-align:center;">This is your private host link — do not share with the client.</p>
  </div>
</body></html>`;
}

// ── Utility helpers ───────────────────────────────────────────────
function generateRef() {
  return 'ACR-' + Math.random().toString(36).substring(2, 8).toUpperCase();
}

function toNZISO(dateStr) {
  // Add NZ timezone offset if not already present
  if (!dateStr) return dateStr;
  if (dateStr.includes('+') || dateStr.includes('Z')) return dateStr;
  // Default to NZST +12:00 (adjust for NZDT +13:00 in summer if needed)
  return dateStr + '+12:00';
}

function formatDateTime(dateStr) {
  if (!dateStr) return '—';
  try {
    return new Date(dateStr).toLocaleString('en-NZ', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: true,
      timeZone: 'Pacific/Auckland',
    });
  } catch(e) { return dateStr; }
}
