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
  'adviser_b': { email: process.env.ADVISER_B_EMAIL || 'dennis@advisercrm.co.nz',  name: 'Dennis' },
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

    // ── Step 2: Find/create CRM record + Create Zoho Event ────────
    try {
      const zohoToken = await getZohoToken();

      // Find existing contact/lead/account or create new lead
      let crmRecord = null;
      try {
        crmRecord = await findCRMRecord(zohoToken, client.email);
        if (!crmRecord) {
          console.log('[ACRM] Email not found — creating new Lead');
          crmRecord = await createLead(zohoToken, client, mt.name);
        } else {
          console.log('[ACRM] Linked to existing', crmRecord.module, ':', crmRecord.name);
        }
      } catch(lookupErr) {
        console.log('[ACRM] CRM lookup/create error:', lookupErr.message);
      }

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

      // Build event data with CRM link
      const eventData = {
        Event_Title:    mt.name + ' — ' + clientName + ' (Online Booking)',
        Start_DateTime: toNZISO(evt.Start_DateTime),
        End_DateTime:   toNZISO(evt.End_DateTime),
        Owner:          { id: getZohoOwnerId(adviserId) },
        Venue:          zoomJoinUrl || 'Online — Zoom',
        Description:    description,
        Agenda:         client.notes || mt.name + ' with ' + clientName,
      };

      // Link to CRM record if found/created
      if (crmRecord) {
        if (crmRecord.module === 'Contacts' || crmRecord.module === 'Leads') {
          eventData['$se_module'] = crmRecord.module;
          eventData.Who_Id = { id: crmRecord.id };
        } else if (crmRecord.module === 'Accounts') {
          eventData['$se_module'] = 'Accounts';
          eventData.What_Id = { id: crmRecord.id };
        }
        console.log('[ACRM] Event linked to', crmRecord.module, crmRecord.id);
      }

      await createZohoEvent(zohoToken, eventData);
      console.log('[ACRM] Zoho event created and linked');
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

// ── Find contact/lead/account by email ────────────────────────────
async function findCRMRecord(token, email) {
  // Search in order: Contacts → Leads → Accounts
  const modules = ['Contacts', 'Leads', 'Accounts'];

  for (const module of modules) {
    try {
      const res = await fetch(
        'https://www.zohoapis.com/crm/v3/' + module + '/search?email=' + encodeURIComponent(email) + '&fields=id,Full_Name,Email',
        { headers: { Authorization: 'Zoho-oauthtoken ' + token } }
      );
      const data = await res.json();
      if (data.data && data.data.length > 0) {
        console.log('[ACRM] Found in', module, ':', data.data[0].id);
        return { module: module, id: data.data[0].id, name: data.data[0].Full_Name || data.data[0].Account_Name };
      }
    } catch(e) {
      console.log('[ACRM] Error searching', module, ':', e.message);
    }
  }
  return null;
}

// ── Create new Lead ────────────────────────────────────────────────
async function createLead(token, client, meetingType) {
  const nameParts = client.firstName.trim().split(' ');
  const res = await fetch('https://www.zohoapis.com/crm/v3/Leads', {
    method:  'POST',
    headers: { Authorization: 'Zoho-oauthtoken ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      data: [{
        First_Name:   client.firstName,
        Last_Name:    client.lastName || 'Unknown',
        Email:        client.email,
        Phone:        client.phone,
        Lead_Source:  'Online Booking',
        Description:  'Created via online booking — ' + meetingType + '\n' +
                      (client.notes ? 'Notes: ' + client.notes : ''),
      }]
    }),
  });
  const data = await res.json();
  if (data.data && data.data[0] && data.data[0].status === 'success') {
    console.log('[ACRM] Lead created:', data.data[0].details.id);
    return { module: 'Leads', id: data.data[0].details.id, name: client.firstName + ' ' + client.lastName };
  }
  throw new Error('Lead creation failed: ' + JSON.stringify(data));
}

// Map adviser key to Zoho user ID
function getZohoOwnerId(adviserId) {
  const ids = {
    adviser_a: process.env.ZOHO_OWNER_A || '1484359000000083003',
    adviser_b: process.env.ZOHO_OWNER_B || '1484359000123904001',
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
  const logoUrl = 'https://adviser-crm.github.io/adviser-crm-calendar/acrm-logo-email.png';
  // Text logo fallback — always visible in email clients
  const logoHtml = '<span style="font-size:22px;font-weight:800;color:#ffffff;letter-spacing:-0.5px;">ADVISER</span><span style="font-size:22px;font-weight:300;color:#00ABE6;letter-spacing:-0.5px;"> CRM</span>';
  return '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="margin:0;padding:0;background:#f4f7fa;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;">' +
  '<div style="max-width:600px;margin:0 auto;padding:24px 16px;">' +

    // Header — two column layout
    '<div style="background:linear-gradient(135deg,#07385D 0%,#0a4f82 100%);border-radius:16px 16px 0 0;padding:22px 28px;">' +
      '<table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>' +
        // Left: logo + confirmed pill
        '<td valign="middle" style="width:50%;">' +
          logoHtml +
          '<div style="margin-top:8px;display:inline-block;background:rgba(255,255,255,0.15);border-radius:20px;padding:4px 14px;">' +
            '<span style="color:#fff;font-size:11px;font-weight:600;">&#10003; Meeting Confirmed</span>' +
          '</div>' +
        '</td>' +
        // Right: meeting name + date
        '<td valign="middle" style="width:50%;text-align:right;">' +
          '<div style="color:rgba(255,255,255,0.6);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px;">' + mt.name + '</div>' +
          '<div style="color:#fff;font-size:16px;font-weight:700;line-height:1.3;">' + dateLabel + '</div>' +
          '<div style="color:rgba(255,255,255,0.5);font-size:11px;margin-top:4px;">NZ Time</div>' +
        '</td>' +
      '</tr></table>' +
    '</div>' +

    // Body
    '<div style="background:#fff;padding:32px;border:1px solid #e8edf2;border-top:none;border-radius:0 0 16px 16px;">' +
      '<p style="color:#5a7080;margin:0 0 20px;">Hi ' + clientName + ',</p>' +
      '<p style="color:#1a2b3c;margin:0 0 24px;">Your meeting has been confirmed. Here are your booking details:</p>' +

      // Detail cards
      '<div style="background:#f4f7fa;border-radius:12px;padding:20px;margin-bottom:24px;">' +
        '<table style="width:100%;border-collapse:collapse;">' +
          '<tr><td style="padding:8px 0;border-bottom:1px solid #e8edf2;"><span style="color:#5a7080;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Meeting</span></td><td style="padding:8px 0;border-bottom:1px solid #e8edf2;text-align:right;font-weight:600;color:#07385D;">' + mt.name + '</td></tr>' +
          '<tr><td style="padding:8px 0;border-bottom:1px solid #e8edf2;"><span style="color:#5a7080;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Date & Time</span></td><td style="padding:8px 0;border-bottom:1px solid #e8edf2;text-align:right;font-weight:600;color:#07385D;">' + dateLabel + '</td></tr>' +
          '<tr><td style="padding:8px 0;border-bottom:1px solid #e8edf2;"><span style="color:#5a7080;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Duration</span></td><td style="padding:8px 0;border-bottom:1px solid #e8edf2;text-align:right;font-weight:600;color:#07385D;">' + mt.duration + ' minutes</td></tr>' +
          '<tr><td style="padding:8px 0;border-bottom:1px solid #e8edf2;"><span style="color:#5a7080;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Zoom ID</span></td><td style="padding:8px 0;border-bottom:1px solid #e8edf2;text-align:right;font-weight:600;color:#07385D;">' + (zoomId || '—') + '</td></tr>' +
          '<tr><td style="padding:8px 0;border-bottom:1px solid #e8edf2;"><span style="color:#5a7080;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Passcode</span></td><td style="padding:8px 0;border-bottom:1px solid #e8edf2;text-align:right;font-weight:600;color:#07385D;">' + (zoomPassword || '—') + '</td></tr>' +
          '<tr><td style="padding:8px 0;"><span style="color:#5a7080;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Reference</span></td><td style="padding:8px 0;text-align:right;font-family:monospace;font-size:13px;color:#07385D;font-weight:700;">' + ref + '</td></tr>' +
        '</table>' +
      '</div>' +

      // Zoom button
      '<div style="text-align:center;margin:28px 0;">' +
        '<a href="' + zoomJoinUrl + '" style="display:inline-block;background:linear-gradient(135deg,#00ABE6 0%,#0089b8 100%);color:#fff;padding:16px 40px;border-radius:12px;text-decoration:none;font-weight:700;font-size:16px;box-shadow:0 4px 14px rgba(0,171,230,0.3);">Join Zoom Meeting →</a>' +
      '</div>' +

      '<p style="color:#98aab8;font-size:12px;text-align:center;margin:0 0 4px;">Or copy this link: <a href="' + zoomJoinUrl + '" style="color:#00ABE6;">' + zoomJoinUrl + '</a></p>' +

      '<hr style="border:none;border-top:1px solid #e8edf2;margin:24px 0;">' +

      '<p style="color:#98aab8;font-size:12px;text-align:center;margin:0 0 4px;">Need to reschedule? Reply to this email or contact us at <a href="mailto:support@advisercrm.co.nz" style="color:#00ABE6;">support@advisercrm.co.nz</a></p>' +
      '<p style="color:#c8d5de;font-size:11px;text-align:center;margin:8px 0 0;">© 2026 Adviser CRM · Designed for Advice. Built for Growth.</p>' +
    '</div>' +
  '</div>' +
  '</body></html>';
}

function adviserEmailHtml({ clientName, client, mt, dateLabel, zoomStartUrl, zoomJoinUrl, zoomId, ref }) {
  const logoUrl = 'https://adviser-crm.github.io/adviser-crm-calendar/acrm-logo-email.png';
  // Text logo fallback — always visible in email clients
  const logoHtml = '<span style="font-size:22px;font-weight:800;color:#ffffff;letter-spacing:-0.5px;">ADVISER</span><span style="font-size:22px;font-weight:300;color:#00ABE6;letter-spacing:-0.5px;"> CRM</span>';
  const notesRow = client.notes
    ? '<tr><td style="padding:8px 0;border-bottom:1px solid #e8edf2;"><span style="color:#5a7080;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Notes</span></td><td style="padding:8px 0;border-bottom:1px solid #e8edf2;text-align:right;color:#1a2b3c;">' + client.notes + '</td></tr>'
    : '';

  return '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="margin:0;padding:0;background:#f4f7fa;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;">' +
  '<div style="max-width:600px;margin:0 auto;padding:24px 16px;">' +

    // Header — two column layout
    '<div style="background:linear-gradient(135deg,#07385D 0%,#0a4f82 100%);border-radius:16px 16px 0 0;padding:22px 28px;">' +
      '<table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>' +
        // Left: logo + ref
        '<td valign="middle" style="width:50%;">' +
          logoHtml +
          '<div style="margin-top:6px;color:rgba(255,255,255,0.45);font-size:11px;font-family:monospace;">' + ref + '</div>' +
        '</td>' +
        // Right: new booking badge + meeting type
        '<td valign="middle" style="width:50%;text-align:right;">' +
          '<div style="display:inline-block;background:rgba(0,171,230,0.25);border-radius:8px;padding:4px 12px;margin-bottom:6px;">' +
            '<span style="color:#00ABE6;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;">New Booking</span>' +
          '</div>' +
          '<div style="color:#fff;font-size:16px;font-weight:700;line-height:1.3;">' + mt.name + '</div>' +
          '<div style="color:rgba(255,255,255,0.5);font-size:11px;margin-top:4px;">' + dateLabel + '</div>' +
        '</td>' +
      '</tr></table>' +
    '</div>' +

    // Body
    '<div style="background:#fff;padding:32px;border:1px solid #e8edf2;border-top:none;border-radius:0 0 16px 16px;">' +

      // Client details
      '<h2 style="color:#07385D;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;margin:0 0 12px;">Client Details</h2>' +
      '<div style="background:#f4f7fa;border-radius:12px;padding:16px 20px;margin-bottom:24px;">' +
        '<table style="width:100%;border-collapse:collapse;">' +
          '<tr><td style="padding:7px 0;border-bottom:1px solid #e8edf2;"><span style="color:#5a7080;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Name</span></td><td style="padding:7px 0;border-bottom:1px solid #e8edf2;text-align:right;font-weight:600;color:#1a2b3c;">' + clientName + '</td></tr>' +
          '<tr><td style="padding:7px 0;border-bottom:1px solid #e8edf2;"><span style="color:#5a7080;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Email</span></td><td style="padding:7px 0;border-bottom:1px solid #e8edf2;text-align:right;"><a href="mailto:' + client.email + '" style="color:#00ABE6;font-weight:600;">' + client.email + '</a></td></tr>' +
          '<tr><td style="padding:7px 0;border-bottom:1px solid #e8edf2;"><span style="color:#5a7080;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Phone</span></td><td style="padding:7px 0;border-bottom:1px solid #e8edf2;text-align:right;font-weight:600;color:#1a2b3c;">' + client.phone + '</td></tr>' +
          notesRow +
        '</table>' +
      '</div>' +

      // Meeting details
      '<h2 style="color:#07385D;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;margin:0 0 12px;">Meeting Details</h2>' +
      '<div style="background:#f4f7fa;border-radius:12px;padding:16px 20px;margin-bottom:24px;">' +
        '<table style="width:100%;border-collapse:collapse;">' +
          '<tr><td style="padding:7px 0;border-bottom:1px solid #e8edf2;"><span style="color:#5a7080;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Type</span></td><td style="padding:7px 0;border-bottom:1px solid #e8edf2;text-align:right;font-weight:600;color:#07385D;">' + mt.name + '</td></tr>' +
          '<tr><td style="padding:7px 0;border-bottom:1px solid #e8edf2;"><span style="color:#5a7080;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Date & Time</span></td><td style="padding:7px 0;border-bottom:1px solid #e8edf2;text-align:right;font-weight:600;color:#07385D;">' + dateLabel + '</td></tr>' +
          '<tr><td style="padding:7px 0;border-bottom:1px solid #e8edf2;"><span style="color:#5a7080;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Duration</span></td><td style="padding:7px 0;border-bottom:1px solid #e8edf2;text-align:right;font-weight:600;color:#07385D;">' + mt.duration + ' minutes</td></tr>' +
          '<tr><td style="padding:7px 0;"><span style="color:#5a7080;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Zoom ID</span></td><td style="padding:7px 0;text-align:right;font-weight:600;color:#07385D;">' + (zoomId || '—') + '</td></tr>' +
        '</table>' +
      '</div>' +

      // Host button
      '<div style="text-align:center;margin:24px 0 16px;">' +
        '<a href="' + (zoomStartUrl || zoomJoinUrl) + '" style="display:inline-block;background:linear-gradient(135deg,#059669 0%,#047857 100%);color:#fff;padding:14px 36px;border-radius:12px;text-decoration:none;font-weight:700;font-size:15px;box-shadow:0 4px 14px rgba(5,150,105,0.3);">Start Zoom Meeting (Host Link) →</a>' +
      '</div>' +
      '<p style="color:#98aab8;font-size:11px;text-align:center;margin:0 0 20px;">⚠ This is your private host link — do not share with the client</p>' +

      '<hr style="border:none;border-top:1px solid #e8edf2;margin:20px 0;">' +
      '<p style="color:#c8d5de;font-size:11px;text-align:center;margin:0;">© 2026 Adviser CRM · Designed for Advice. Built for Growth.</p>' +
    '</div>' +
  '</div>' +
  '</body></html>';
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
    // If no timezone info, append NZ offset to avoid UTC misinterpretation
    var str = dateStr;
    if (!str.includes('+') && !str.includes('Z') && !str.includes('z')) {
      str = str + '+12:00';
    }
    return new Date(str).toLocaleString('en-NZ', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: true,
      timeZone: 'Pacific/Auckland',
    });
  } catch(e) { return dateStr; }
}
