// ── Auth seam — Firebase "Sign in with Google", allowlisted to specific emails ──
// Active ONLY when Firebase is configured (a service account for verifying tokens,
// the public web config for the browser, AND a non-empty email allowlist). When any
// of those is missing the app stays OPEN — local dev is unchanged, exactly like the
// old password gate. On a public host this is what stops anyone but Yossi + Liran
// from using the app (and burning the API keys): every /api and /media request must
// carry a valid Firebase ID token whose verified email is on ALLOWED_EMAILS.
import fs from 'fs';

// Service-account JSON: either inline in FIREBASE_SERVICE_ACCOUNT, or a file path in
// GOOGLE_APPLICATION_CREDENTIALS. Secret — set in the host env, never committed.
function readServiceAccount() {
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

// Public web config the browser needs to run Google sign-in. apiKey + projectId are
// the minimum; authDomain defaults to <projectId>.firebaseapp.com. All non-secret.
export function webConfig() {
  const apiKey = process.env.FIREBASE_API_KEY || '';
  const projectId = process.env.FIREBASE_PROJECT_ID || '';
  if (!apiKey || !projectId) return null;
  return {
    apiKey,
    projectId,
    authDomain: process.env.FIREBASE_AUTH_DOMAIN || `${projectId}.firebaseapp.com`,
    appId: process.env.FIREBASE_APP_ID || undefined,
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || undefined,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || undefined,
  };
}

export function allowedEmails() {
  return (process.env.ALLOWED_EMAILS || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

// Enforce auth only when we can verify tokens (service account) AND tell the browser
// how to sign in (web config) AND know who's allowed (allowlist). Else: open.
export function authEnabled() {
  return !!readServiceAccount() && !!webConfig() && allowedEmails().length > 0;
}

// Lazily import + init firebase-admin so the dependency is only touched when auth is
// actually configured (local dev with no creds never loads it).
let _ready = null;
async function getAdminAuth() {
  if (_ready) return _ready;
  _ready = (async () => {
    const { initializeApp, cert, getApps } = await import('firebase-admin/app');
    const { getAuth } = await import('firebase-admin/auth');
    const app = getApps().length ? getApps()[0] : initializeApp({ credential: cert(readServiceAccount()) });
    return getAuth(app);
  })();
  return _ready;
}

// Express middleware factory. `open` lists paths (relative to the mount point) that
// skip the check — the login screen needs /auth-config and the host needs /health.
// On success attaches req.user = { email, uid }.
export function requireAuth({ open = [] } = {}) {
  return async (req, res, next) => {
    if (!authEnabled()) return next();
    // `open` accepts a bare path ("/health") or a method+path ("GET /showcase"),
    // so a public GET can coexist with a gated POST/DELETE on the same route.
    if (open.includes(req.path) || open.includes(`${req.method} ${req.path}`)) return next();
    const hdr = req.headers.authorization || '';
    if (!hdr.startsWith('Bearer ')) return res.status(401).json({ error: 'Sign in required.' });
    try {
      const auth = await getAdminAuth();
      const decoded = await auth.verifyIdToken(hdr.slice(7));
      const email = (decoded.email || '').toLowerCase();
      if (!decoded.email_verified || !allowedEmails().includes(email)) {
        return res.status(403).json({ error: 'This Google account is not on the allowlist.' });
      }
      req.user = { email, uid: decoded.uid };
      next();
    } catch {
      return res.status(401).json({ error: 'Session expired — please sign in again.' });
    }
  };
}
