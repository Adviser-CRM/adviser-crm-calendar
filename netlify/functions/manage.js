// ── Adviser CRM Manage Booking Endpoint ───────────────────────────
// Netlify Function: netlify/functions/manage.js
//
// Handles booking lookup, cancellation and reschedule prep
// GET  /.netlify/functions/manage?token=xxx          → get booking details
// POST /.netlify/functions/manage?token=xxx&action=cancel → cancel booking

const ALLOWED_ORIGINS = [
  'https://adviser-crm.github.io',
  'https://calendar.advisercrm.co.nz',
  'http://localhost',
];

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

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    const params = event.queryStringParameters || {};
    const token  = params.token;
    const action = params.action || event.httpMethod === 'POST' ? (JSON.parse(event.body || '{}').action || params.action) : null;

    if (!token) {
      return { statusCode: 200, headers, body: JSON.stringify({ error: 'Invalid booking link' }) };
    }

    // ── Decode token ──────────────────────────────────────────────
    let ref, zoomId, startDateTime;
    try {
      const decoded = Buffer.from(token, 'base64url').toString('utf-8');
      const parts   = decoded.split('|');
      ref           = parts[0];
      zoomId        = parts[1];
      startDateTime = parts[2];
    } catch(e) {
      return { statusCode: 200, headers, body: JSON.stringify({ error: 'Invalid booking token' }) };
    }

    if (!ref || !zoomId) {
      return { statusCode: 200, headers, body: JSON.stringify({ error: 'Invalid booking token' }) };
    }

    console.log('[ACRM] Manage request:', action || 'lookup', ref, zoomId);

    // ── Check if meeting is in the past ───────────────────────────
    const meetingTime = new Date(startDateTime);
    const now         = new Date();
    const isPast      = meetingTime < now;

    if (isPast && action === 'cancel') {
      return { statusCode: 200, headers, body: JSON.stringify({ error: 'This meeting has already passed and cannot be cancelled.' }) };
    }

    // ── Get Zoom meeting details ───────────────────────────────────
    const zoomToken = await getZoomToken();
    let meetingDetails = null;

    try {
      const res = await fetch('https://api.zoom.us/v2/meetings/' + zoomId, {
        headers: { Authorization: 'Bearer ' + zoomToken },
      });
      const text = await res.text();
      console.log('[ACRM] Zoom lookup status:', res.status, text.substring(0, 200));
      if (res.ok) {
        meetingDetails = JSON.parse(text);
      } else {
        // Meeting might not exist or already cancelled
        console.log('[ACRM] Zoom meeting not found:', zoomId);
      }
    } catch(e) {
      console.log('[ACRM] Zoom lookup error:', e.message);
    }

    // If Zoom meeting not found, still show booking details from token
    // (meeting may have been manually deleted)
    if (!meetingDetails) {
      // Return basic info from token so user can at least see their booking
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success:       true,
          ref:           ref,
          zoomId:        zoomId,
          topic:         'Your Meeting',
          startTime:     startDateTime,
          startNZ:       formatDateTime(startDateTime),
          duration:      60,
          joinUrl:       null,
          isPast:        isPast,
          token:         token,
          zoomNotFound:  true,
        }),
      };
    }

    // ── Handle reschedule ────────────────────────────────────────
    if (action === 'reschedule') {
      // Cancel the original Zoom meeting
      try {
        await fetch('https://api.zoom.us/v2/meetings/' + zoomId, {
          method:  'DELETE',
          headers: { Authorization: 'Bearer ' + zoomToken },
        });
        console.log('[ACRM] Original Zoom meeting deleted for reschedule:', zoomId);
      } catch(e) {
        console.log('[ACRM] Zoom delete error on reschedule:', e.message);
      }

      // Update Zoho Event to show rescheduled
      try {
        const zohoToken2 = await getZohoToken();
        await cancelZohoEvent(zohoToken2, ref, 'RESCHEDULED');
      } catch(e) {
        console.log('[ACRM] Zoho reschedule error:', e.message);
      }

      // Get client details from Zoho Event
      let clientDetails = null;
      try {
        const zohoToken3 = await getZohoToken();
        clientDetails = await getClientDetailsFromZoho(zohoToken3, ref);
        console.log('[ACRM] Client details retrieved:', clientDetails);
      } catch(e) {
        console.log('[ACRM] Could not get client details:', e.message);
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          action: 'reschedule_ready',
          ref,
          client: clientDetails,
        }),
      };
    }

    // ── Handle cancel ─────────────────────────────────────────────
    if (action === 'cancel') {
      // Delete Zoom meeting
      try {
        await fetch('https://api.zoom.us/v2/meetings/' + zoomId, {
          method:  'DELETE',
          headers: { Authorization: 'Bearer ' + zoomToken },
        });
        console.log('[ACRM] Zoom meeting deleted:', zoomId);
      } catch(e) {
        console.log('[ACRM] Zoom delete error:', e.message);
      }

      // Update Zoho CRM Event status to cancelled
      try {
        const zohoToken = await getZohoToken();
        await cancelZohoEvent(zohoToken, ref);
      } catch(e) {
        console.log('[ACRM] Zoho cancel error:', e.message);
      }

      // Send cancellation emails
      try {
        const topic   = meetingDetails.topic || 'Meeting';
        const startNZ = formatDateTime(meetingDetails.start_time);

        await sendEmail({
          to:      meetingDetails.registrants_confirmation_email || null,
          subject: 'Your booking has been cancelled — ' + topic,
          html:    cancelEmailHtml({ topic, startNZ, ref }),
        });
      } catch(e) {
        console.log('[ACRM] Cancel email error:', e.message);
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, action: 'cancelled', ref }),
      };
    }

    // ── Default: return booking details + client info for display ──
    // Extract client name from Zoom meeting topic
    // Format: "Meeting Type — First Last (Online Booking)"
    let clientDetails = null;
    try {
      const topic = meetingDetails.topic || '';
      const namePart = topic
        .replace(/^.*?—\s*/, '')           // remove "Meeting Type — "
        .replace(/\s*\(Online Booking\).*$/, '') // remove " (Online Booking)"
        .trim();
      const nameParts = namePart.split(' ');
      const firstName = nameParts[0] || '';
      const lastName  = nameParts.slice(1).join(' ') || '';

      if (firstName) {
        clientDetails = { firstName, lastName, email: '', phone: '' };
        console.log('[ACRM] Client name from Zoom topic:', firstName, lastName);

        // Look up email and phone from Zoho CRM by name
        try {
          const zohoToken = await getZohoToken();

          // Search Contacts by last name
          const searchRes = await fetch(
            'https://www.zohoapis.com/crm/v3/Contacts/search?criteria=' +
            encodeURIComponent('(Last_Name:equals:' + lastName + ')') +
            '&fields=First_Name,Last_Name,Email,Phone,Mobile',
            { headers: { Authorization: 'Zoho-oauthtoken ' + zohoToken } }
          );
          const searchData = await searchRes.json();

          if (searchData.data && searchData.data.length) {
            // Find best match by first name
            const match = searchData.data.find(function(c) {
              return c.First_Name && c.First_Name.toLowerCase() === firstName.toLowerCase();
            }) || searchData.data[0];

            clientDetails.email = match.Email || '';
            clientDetails.phone = match.Phone || match.Mobile || '';
            console.log('[ACRM] Found contact in Zoho:', clientDetails.email);
          } else {
            // Try Leads
            const leadsRes = await fetch(
              'https://www.zohoapis.com/crm/v3/Leads/search?criteria=' +
              encodeURIComponent('(Last_Name:equals:' + lastName + ')') +
              '&fields=First_Name,Last_Name,Email,Phone,Mobile',
              { headers: { Authorization: 'Zoho-oauthtoken ' + zohoToken } }
            );
            const leadsData = await leadsRes.json();
            if (leadsData.data && leadsData.data.length) {
              const match = leadsData.data.find(function(l) {
                return l.First_Name && l.First_Name.toLowerCase() === firstName.toLowerCase();
              }) || leadsData.data[0];
              clientDetails.email = match.Email || '';
              clientDetails.phone = match.Phone || match.Mobile || '';
              console.log('[ACRM] Found lead in Zoho:', clientDetails.email);
            }
          }
        } catch(ze) {
          console.log('[ACRM] Zoho contact lookup failed:', ze.message);
        }
      }
    } catch(e) {
      console.log('[ACRM] Could not extract client details:', e.message);
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success:       true,
        ref:           ref,
        zoomId:        zoomId,
        topic:         meetingDetails.topic,
        startTime:     meetingDetails.start_time,
        startNZ:       formatDateTime(meetingDetails.start_time),
        duration:      meetingDetails.duration,
        joinUrl:       meetingDetails.join_url,
        isPast:        isPast,
        token:         token,
        client:        clientDetails,
      }),
    };

  } catch(err) {
    console.error('[ACRM] Manage error:', err);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ error: 'Something went wrong. Please contact us directly.' }),
    };
  }
};

// ── Zoom helpers ──────────────────────────────────────────────────
async function getZoomToken() {
  const creds = Buffer.from(
    process.env.ZOOM_CLIENT_ID + ':' + process.env.ZOOM_CLIENT_SECRET
  ).toString('base64');
  const res = await fetch(
    'https://zoom.us/oauth/token?grant_type=account_credentials&account_id=' + process.env.ZOOM_ACCOUNT_ID,
    { method: 'POST', headers: { Authorization: 'Basic ' + creds } }
  );
  const data = await res.json();
  if (!data.access_token) throw new Error('Zoom token failed');
  return data.access_token;
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
  if (!data.access_token) throw new Error('Zoho token failed');
  return data.access_token;
}

async function getClientDetailsFromZoho(token, ref) {
  // Search for the Zoho Event by ref and extract client details from description
  try {
    // Search by Event_Title which contains the ref
    const titleCriteria = encodeURIComponent('(Event_Title:contains:' + ref + ')');
    let res = await fetch(
      'https://www.zohoapis.com/crm/v3/Events/search?criteria=' + titleCriteria +
      '&fields=id,Event_Title,Description,Who_Id',
      { headers: { Authorization: 'Zoho-oauthtoken ' + token } }
    );
    let data = await res.json();

    // Fallback: search by Description
    if (!data.data || !data.data.length) {
      const descCriteria = encodeURIComponent('(Description:contains:' + ref + ')');
      res = await fetch(
        'https://www.zohoapis.com/crm/v3/Events/search?criteria=' + descCriteria +
        '&fields=id,Event_Title,Description,Who_Id',
        { headers: { Authorization: 'Zoho-oauthtoken ' + token } }
      );
      data = await res.json();
    }

    console.log('[ACRM] Zoho search response:', JSON.stringify(data).substring(0, 200));
    if (!data.data || !data.data.length) return null;

    const desc = data.data[0].Description || '';
    console.log('[ACRM] Found Zoho event for ref:', ref, 'desc length:', desc.length);

    // Parse client details from description
    // Parse client details from description (Client/Email/Phone lines)
    const clientMatch = desc.match(/Client:[\s]*([^\n]+)/);
    const emailMatch  = desc.match(/Email:[\s]*([^\n]+)/);
    const phoneMatch  = desc.match(/Phone:[\s]*([^\n]+)/);

    const fullName  = clientMatch ? clientMatch[1].trim() : '';
    const nameParts = fullName.split(' ');

    return {
      firstName: nameParts[0] || '',
      lastName:  nameParts.slice(1).join(' ') || '',
      email:     emailMatch ? emailMatch[1].trim() : '',
      phone:     phoneMatch ? phoneMatch[1].trim() : '',
    };
  } catch(e) {
    console.log('[ACRM] Error getting client details:', e.message);
    return null;
  }
}

async function cancelZohoEvent(token, ref, label) {
  label = label || 'CANCELLED';
  // Search for the event by ref in description
  const criteria = encodeURIComponent('(Description:contains:' + ref + ')');
  const res = await fetch(
    'https://www.zohoapis.com/crm/v3/Events/search?criteria=' + criteria + '&fields=id,Event_Title',
    { headers: { Authorization: 'Zoho-oauthtoken ' + token } }
  );
  const data = await res.json();
  if (!data.data || !data.data.length) {
    console.log('[ACRM] No Zoho event found for ref:', ref);
    return;
  }
  const eventId = data.data[0].id;

  // Update event title to show cancelled
  await fetch('https://www.zohoapis.com/crm/v3/Events', {
    method:  'PUT',
    headers: { Authorization: 'Zoho-oauthtoken ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      data: [{
        id:          eventId,
        Event_Title: '[' + label + '] ' + data.data[0].Event_Title,
      }]
    }),
  });
  console.log('[ACRM] Zoho event marked cancelled:', eventId);
}

// ── Email ─────────────────────────────────────────────────────────
async function sendEmail({ to, subject, html }) {
  if (!to || !process.env.RESEND_API_KEY) return;
  await fetch('https://api.resend.com/emails', {
    method:  'POST',
    headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from:    'Adviser CRM Bookings <' + (process.env.EMAIL_FROM || 'bookings@calendar.advisercrm.co.nz') + '>',
      to:      [to],
      subject: subject,
      html:    html,
    }),
  });
}

function cancelEmailHtml({ topic, startNZ, ref }) {
  return '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="margin:0;padding:0;background:#f4f7fa;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;">' +
  '<div style="max-width:600px;margin:0 auto;padding:24px 16px;">' +
    '<div style="background:linear-gradient(135deg,#07385D 0%,#0a4f82 100%);border-radius:16px 16px 0 0;padding:28px 32px;text-align:center;">' +
      '<span style="font-size:22px;font-weight:800;color:#ffffff;letter-spacing:-0.5px;">ADVISER</span>' +
      '<span style="font-size:22px;font-weight:300;color:#00ABE6;letter-spacing:-0.5px;"> CRM</span>' +
      '<h1 style="color:#fff;margin:16px 0 0;font-size:20px;font-weight:700;">Booking Cancelled</h1>' +
    '</div>' +
    '<div style="background:#fff;padding:32px;border:1px solid #e8edf2;border-top:none;border-radius:0 0 16px 16px;">' +
      '<p style="color:#5a7080;margin:0 0 20px;">Your booking has been cancelled successfully.</p>' +
      '<div style="background:#f4f7fa;border-radius:12px;padding:20px;margin-bottom:24px;">' +
        '<table width="100%" cellpadding="0" cellspacing="0" border="0">' +
          '<tr><td style="padding:7px 0;border-bottom:1px solid #e8edf2;"><span style="color:#5a7080;font-size:12px;font-weight:600;text-transform:uppercase;">Meeting</span></td><td style="padding:7px 0;border-bottom:1px solid #e8edf2;text-align:right;font-weight:600;color:#07385D;">' + topic + '</td></tr>' +
          '<tr><td style="padding:7px 0;border-bottom:1px solid #e8edf2;"><span style="color:#5a7080;font-size:12px;font-weight:600;text-transform:uppercase;">Was Scheduled For</span></td><td style="padding:7px 0;border-bottom:1px solid #e8edf2;text-align:right;font-weight:600;color:#07385D;">' + startNZ + '</td></tr>' +
          '<tr><td style="padding:7px 0;"><span style="color:#5a7080;font-size:12px;font-weight:600;text-transform:uppercase;">Reference</span></td><td style="padding:7px 0;text-align:right;font-family:monospace;font-weight:700;color:#07385D;">' + ref + '</td></tr>' +
        '</table>' +
      '</div>' +
      '<div style="text-align:center;margin:24px 0;">' +
        '<a href="https://calendar.advisercrm.co.nz" style="display:inline-block;background:linear-gradient(135deg,#00ABE6 0%,#0089b8 100%);color:#fff;padding:14px 32px;border-radius:12px;text-decoration:none;font-weight:700;font-size:15px;">Book a New Meeting</a>' +
      '</div>' +
      '<p style="color:#98aab8;font-size:12px;text-align:center;">Need help? Contact us at <a href="mailto:support@advisercrm.co.nz" style="color:#00ABE6;">support@advisercrm.co.nz</a></p>' +
      '<p style="color:#c8d5de;font-size:11px;text-align:center;margin-top:8px;">© 2026 Adviser CRM · Designed for Advice. Built for Growth.</p>' +
    '</div>' +
  '</div></body></html>';
}

function formatDateTime(dateStr) {
  if (!dateStr) return '—';
  try {
    var str = dateStr;
    // If no timezone info, treat as NZ time (+12:00)
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
