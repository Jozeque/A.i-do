// One-time: get a Google Drive refresh token for the owner account.
//
// Prereq: GOOGLE_OAUTH_CLIENT_ID + GOOGLE_OAUTH_CLIENT_SECRET set (a "Desktop app" OAuth
// client from Google Cloud Console, with the Google Drive API enabled).
//
// Run from the project root:
//   node --env-file=.env scripts/drive-consent.mjs
//
// It prints a URL — open it, approve Drive access for your account, and the script prints
// the line to paste into .env (GOOGLE_OAUTH_REFRESH_TOKEN=...). Then set STORAGE_BACKEND=drive.
import http from 'http';
import { google } from 'googleapis';

const PORT = 53682; // loopback port for the Desktop-client redirect
const id = process.env.GOOGLE_OAUTH_CLIENT_ID;
const secret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
if (!id || !secret) {
  console.error('Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in .env first.');
  process.exit(1);
}

const oauth = new google.auth.OAuth2(id, secret, `http://localhost:${PORT}`);
const url = oauth.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: ['https://www.googleapis.com/auth/drive.file'],
});

console.log('\n1) Open this URL in your browser and approve Drive access:\n\n' + url + '\n');

const server = http.createServer(async (req, res) => {
  const code = new URL(req.url, `http://localhost:${PORT}`).searchParams.get('code');
  if (!code) { res.end('Waiting for Google…'); return; }
  res.end('Done — close this tab and return to the terminal.');
  server.close();
  try {
    const { tokens } = await oauth.getToken(code);
    if (!tokens.refresh_token) {
      console.error('\nNo refresh_token returned. Revoke the app\'s access at https://myaccount.google.com/permissions and run again (it only returns one on first consent).');
      process.exit(1);
    }
    console.log('\n2) Paste this line into your .env:\n');
    console.log('GOOGLE_OAUTH_REFRESH_TOKEN=' + tokens.refresh_token + '\n');
    console.log('Then set  STORAGE_BACKEND=drive  and tell me — I\'ll test + migrate your media.\n');
  } catch (e) {
    console.error('\nToken exchange failed:', e.message);
  }
  process.exit(0);
});
server.listen(PORT, () => {});
