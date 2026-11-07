// ── Invite links for the hidden "Meeting with Sean Davis" booking type ──────
//
// An invite token is:  <id>.<expiry-epoch-seconds>.<signature>
//   - id        random, identifies the invite in the Netlify Blobs store
//   - expiry    when the link stops working if unused
//   - signature HMAC-SHA256 over "id.expiry" using INVITE_SECRET, so links
//               can't be guessed or forged
//
// Netlify Blobs (store "invites") remembers each invite and whether it has
// been used, which is what makes a link single-use.
//
// Environment variables (Netlify dashboard):
//   INVITE_SECRET       long random string used to sign tokens
//   INVITE_PASSPHRASE   what Sean types into invite.html to create a link

const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');

const STORE_NAME   = 'invites';
const DEFAULT_DAYS = 14;

function secret() {
  const s = process.env.INVITE_SECRET;
  if (!s) throw new Error('INVITE_SECRET is not set');
  return s;
}

function sign(id, exp) {
  return crypto.createHmac('sha256', secret()).update(id + '.' + exp).digest('base64url').slice(0, 22);
}

function store() {
  return getStore(STORE_NAME);
}

// Create a new invite and return { token, exp, record }
async function createInvite({ clientName, clientEmail, days, createdBy }) {
  const id  = crypto.randomBytes(9).toString('base64url');           // 12 chars
  const exp = Math.floor(Date.now() / 1000 + (Number(days) || DEFAULT_DAYS) * 86400);
  const token = id + '.' + exp + '.' + sign(id, exp);
  const record = {
    id,
    clientName: (clientName || '').trim(),
    clientEmail: (clientEmail || '').trim(),
    createdAt:  new Date().toISOString(),
    createdBy:  createdBy || 'invite.html',
    expiresAt:  new Date(exp * 1000).toISOString(),
    used:       false,
  };
  await store().setJSON(id, record);
  return { token, exp, record };
}

// Check a token. Returns { ok:true, record } or { ok:false, reason, message }
async function verifyInvite(token) {
  if (!token || typeof token !== 'string') return bad('missing', 'No invitation found in this link.');
  const parts = token.split('.');
  if (parts.length !== 3) return bad('malformed', 'This invitation link is not valid.');
  const [id, expStr, sig] = parts;
  const exp = parseInt(expStr, 10);
  if (!id || !exp || !sig) return bad('malformed', 'This invitation link is not valid.');

  const expected = sign(id, exp);
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return bad('bad_signature', 'This invitation link is not valid.');
  }
  if (Date.now() / 1000 > exp) {
    return bad('expired', 'This invitation has expired. Please contact Sean for a new link.');
  }

  const record = await store().get(id, { type: 'json' });
  if (!record) return bad('unknown', 'This invitation link is not recognised.');
  if (record.used) {
    return bad('used', 'This invitation has already been used. Please contact Sean if you need another meeting.');
  }
  return { ok: true, id, record };
}

// Mark an invite as used (called once a booking is confirmed)
async function consumeInvite(id, bookingRef) {
  const s = store();
  const record = (await s.get(id, { type: 'json' })) || { id };
  record.used       = true;
  record.usedAt     = new Date().toISOString();
  record.bookingRef = bookingRef || null;
  await s.setJSON(id, record);
  return record;
}

function bad(reason, message) {
  return { ok: false, reason, message };
}

module.exports = { createInvite, verifyInvite, consumeInvite, DEFAULT_DAYS };
