// ── Meta Conversions API ──────────────────────────────────────────────────────
// The browser pixel loses a meaningful share of Lead events to Safari/ITP and ad
// blockers, and Lead is the only conversion this site optimises for. Sending the
// same event server-side recovers those. The browser and server events carry the
// same event_id, so Meta collapses them into one conversion instead of counting two.
//
// Inert until META_CAPI_ACCESS_TOKEN is set (generate it in Business Settings →
// System users → Conversions API System User → Generate token).
import crypto from 'crypto';

const API_VERSION = 'v21.0';
const PIXEL_ID = process.env.META_PIXEL_ID || '1619487023147325';

const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');

// _fbp / _fbc are first-party cookies the pixel writes; they are the strongest
// match signals available server-side.
function cookie(header, name) {
  const match = String(header || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : '';
}

export async function sendLead(lead, { eventId, fbclid, ip, userAgent, cookieHeader, sourceUrl }) {
  const token = process.env.META_CAPI_ACCESS_TOKEN;
  if (!token) return;

  const user_data = { client_ip_address: ip, client_user_agent: userAgent };
  if (lead.email) user_data.em = [sha256(lead.email.trim().toLowerCase())];
  const fbp = cookie(cookieHeader, '_fbp');
  if (fbp) user_data.fbp = fbp;
  // Meta's fbc format is fb.1.<timestamp>.<fbclid>; the cookie already holds it.
  const fbc = cookie(cookieHeader, '_fbc') || (fbclid ? `fb.1.${Date.now()}.${fbclid}` : '');
  if (fbc) user_data.fbc = fbc;

  const payload = {
    data: [{
      event_name: 'Lead',
      event_time: Math.floor(lead.createdAt / 1000),
      event_id: eventId,
      event_source_url: sourceUrl,
      action_source: 'website',
      user_data,
      custom_data: { interest: lead.interest || '' },
    }],
  };

  const res = await fetch(`https://graph.facebook.com/${API_VERSION}/${PIXEL_ID}/events?access_token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Meta CAPI ${res.status}: ${await res.text()}`);
}
