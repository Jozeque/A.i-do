// ── Lead alerts: every new inquiry is emailed to the studio inbox ─────────────
// The CRM (app.shyow.io, CRM in the sidebar) is where leads get worked; this email is
// the nudge that one just arrived. It goes out through the studio's own Gmail over
// SMTP with an App Password, so there is no mail vendor to sign up for and no DNS to
// verify. Reply-To is the lead, so hitting Reply in Gmail answers them directly, and
// a brief added on the thank-you step lands in the same Gmail thread.
//
// Inert until GMAIL_USER + GMAIL_APP_PASSWORD are set (sign in to the sending account,
// Google Account > Security > 2-Step Verification > App passwords). LEAD_NOTIFY_TO
// overrides the recipient, which defaults to the studio inbox.
import nodemailer from 'nodemailer';

const DEFAULT_TO = 'shyow.studio@gmail.com';
const CRM_URL = process.env.CRM_URL || 'https://app.shyow.io/#crm';

export function leadEmailEnabled() {
  return !!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
}

let _transport = null;
function transport() {
  if (!_transport) {
    _transport = nodemailer.createTransport({
      service: 'gmail',
      // Google shows App Passwords in groups of four; the spaces are cosmetic.
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD.replace(/\s+/g, '') },
    });
  }
  return _transport;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// One stable Message-ID per lead, so the later "brief added" mail threads under the first.
const threadId = (lead) => `<lead-${lead.id}@shyow.io>`;
const subjectFor = (lead) => `New lead: ${lead.name}${lead.company ? ` · ${lead.company}` : ''}${lead.interest ? ` (${lead.interest})` : ''}`;

function details(lead) {
  const campaign = Object.entries(lead.campaign || {}).map(([k, v]) => `${k}=${v}`).join(', ');
  return [
    ['Name', lead.name], ['Company', lead.company], ['Email', lead.email], ['Phone', lead.phone],
    ['Looking for', lead.interest], ['Budget', lead.budget], ['Brief', lead.brief],
    ['Page', lead.page], ['Campaign', campaign], ['Referrer', lead.referrer],
    ['Received', new Date(lead.createdAt).toLocaleString('en-GB', { timeZone: 'Asia/Jerusalem', dateStyle: 'medium', timeStyle: 'short' })],
  ].filter(([, v]) => v);
}

// The whole message minus the transport (exported so it can be checked without sending).
export function buildLeadEmail(lead, { brief = false } = {}) {
  const subject = subjectFor(lead);
  const intro = brief ? `${lead.name} added a brief.` : 'New inquiry from the website.';
  const rows = brief ? [['Brief', lead.brief]] : details(lead);
  const text = [intro, '', ...rows.map(([k, v]) => `${k}: ${v}`), '', `Open in the CRM: ${CRM_URL}`].join('\n');
  const html = `<div style="font-family:-apple-system,'Segoe UI',Arial,sans-serif;font-size:15px;line-height:1.5;color:#1B1610;max-width:560px">
<p style="margin:0 0 16px">${esc(intro)}</p>
<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%">${rows.map(([k, v]) =>
    `<tr><td style="padding:7px 16px 7px 0;color:#6E6357;vertical-align:top;white-space:nowrap">${esc(k)}</td><td style="padding:7px 0;white-space:pre-wrap">${esc(v)}</td></tr>`).join('')}</table>
<p style="margin:22px 0 0"><a href="${esc(CRM_URL)}" style="display:inline-block;background:#1B1610;color:#F6F2EB;text-decoration:none;padding:11px 18px;border-radius:12px">Open in the CRM</a></p>
${lead.email ? `<p style="margin:14px 0 0;color:#9C9187;font-size:13px">Reply to this email to answer ${esc(lead.name)} directly.</p>` : ''}
</div>`;

  const msg = {
    from: { name: 'Shyow Leads', address: process.env.GMAIL_USER || DEFAULT_TO },
    to: process.env.LEAD_NOTIFY_TO || DEFAULT_TO,
    subject: brief ? `Re: ${subject}` : subject,
    text,
    html,
  };
  if (lead.email) msg.replyTo = { name: lead.name, address: lead.email };
  if (brief) { msg.inReplyTo = threadId(lead); msg.references = [threadId(lead)]; }
  else msg.messageId = threadId(lead);
  return msg;
}

export async function notifyNewLead(lead) {
  if (!leadEmailEnabled()) return false;
  await transport().sendMail(buildLeadEmail(lead));
  return true;
}

export async function notifyLeadBrief(lead) {
  if (!leadEmailEnabled() || !lead.brief) return false;
  await transport().sendMail(buildLeadEmail(lead, { brief: true }));
  return true;
}
