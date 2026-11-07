// ── Adviser CRM Invite Links ──────────────────────────────────────
// Netlify Function: netlify/functions/invite.js
//
//   GET  /.netlify/functions/invite?token=...        → validate an invite (used by index.html)
//   POST /.netlify/functions/invite  { passphrase, clientName, days }
//                                                     → create an invite (used by invite.html)
//
// Environment variables: INVITE_SECRET, INVITE_PASSPHRASE  (see netlify/lib/invites.js)

const { connectBlobs, createInvite, verifyInvite, DEFAULT_DAYS } = require('../lib/invites');

const ALLOWED_ORIGINS = [
  'https://adviser-crm.github.io',
  'https://calendar.advisercrm.co.nz',
  'https://adviser-crm-calendar.netlify.app',
];

const BOOKING_URL = 'https://calendar.advisercrm.co.nz/';

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.some(o => origin && origin.startsWith(o)) ? origin : ALLOWED_ORIGINS[1];
  return {
    'Access-Control-Allow-Origin':  allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
}

exports.handler = async function(event) {
  const origin  = event.headers.origin || event.headers.Origin || '';
  const headers = corsHeaders(origin);

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  connectBlobs(event);

  try {
    // ── Validate an invite ─────────────────────────────────────
    if (event.httpMethod === 'GET') {
      const token  = (event.queryStringParameters || {}).token;
      const result = await verifyInvite(token);
      if (!result.ok) {
        console.log('[ACRM] Invite rejected:', result.reason);
        return { statusCode: 200, headers, body: JSON.stringify({ valid: false, reason: result.reason, message: result.message }) };
      }
      return {
        statusCode: 200, headers,
        body: JSON.stringify({ valid: true, clientName: result.record.clientName || '', expiresAt: result.record.expiresAt }),
      };
    }

    // ── Create an invite ───────────────────────────────────────
    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const expected = process.env.INVITE_PASSPHRASE;
      if (!expected) {
        return { statusCode: 200, headers, body: JSON.stringify({ success: false, error: 'INVITE_PASSPHRASE is not configured in Netlify' }) };
      }
      if (!body.passphrase || body.passphrase !== expected) {
        console.log('[ACRM] Invite create: wrong passphrase');
        return { statusCode: 200, headers, body: JSON.stringify({ success: false, error: 'Incorrect passphrase' }) };
      }
      const days = Math.min(Math.max(parseInt(body.days, 10) || DEFAULT_DAYS, 1), 90);
      const { token, record } = await createInvite({
        clientName:  body.clientName,
        clientEmail: body.clientEmail,
        days,
        createdBy:   body.source === 'zoho' ? 'zoho-crm' : 'invite.html',
      });
      const link = BOOKING_URL + '?invite=' + encodeURIComponent(token);
      console.log('[ACRM] Invite created:', record.id, 'for', record.clientName || '(no name)', 'expires', record.expiresAt);
      return {
        statusCode: 200, headers,
        body: JSON.stringify({ success: true, link, token, clientName: record.clientName, expiresAt: record.expiresAt }),
      };
    }

    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  } catch (err) {
    console.error('[ACRM] Invite error:', err);
    return { statusCode: 200, headers, body: JSON.stringify({ success: false, valid: false, error: 'Server error: ' + err.message }) };
  }
};
