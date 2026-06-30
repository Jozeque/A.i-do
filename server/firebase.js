// ── Shared Firebase Admin app ───────────────────────────────────────────────
// One initialised firebase-admin app, reused by the Firestore data backend (and
// available to the auth gate). Credentials come from the SAME service-account key
// that powers the login — inline JSON in FIREBASE_SERVICE_ACCOUNT, or a file path in
// GOOGLE_APPLICATION_CREDENTIALS. Lazy: nothing loads until first use, so a local
// run with no credentials never touches firebase-admin.
import fs from 'fs';

export function readServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (raw && raw.trim().startsWith('{')) {
    try { return JSON.parse(raw); } catch { return null; }
  }
  const p = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (p && fs.existsSync(p)) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
  }
  return null;
}

let _appPromise = null;
export function getAdminApp() {
  if (_appPromise) return _appPromise;
  _appPromise = (async () => {
    const { initializeApp, cert, getApps, applicationDefault } = await import('firebase-admin/app');
    if (getApps().length) return getApps()[0]; // reuse an app the auth gate already made
    const sa = readServiceAccount();
    return initializeApp({ credential: sa ? cert(sa) : applicationDefault() });
  })();
  return _appPromise;
}
