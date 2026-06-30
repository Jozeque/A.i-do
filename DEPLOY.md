# Deploy to the web + Google login — runbook

This gets the app live on **Render** behind a **Firebase "Sign in with Google"** gate that only
admits **you + Liran** (so nobody else can use it or burn your API keys).

**Architecture:** Render hosts the Node server · Firebase handles the Google login · (next step)
Firestore holds metadata + Google Drive holds media.

> ⚠️ **Storage caveat — read first.** Today the app still stores projects/images on the server's
> local disk. On Render that disk **resets on every redeploy or sleep.** So this deploy is perfect
> for **getting the login live and testing with Liran**, but **keep doing real work on your local
> app** until the next step wires **Firestore (metadata) + Google Drive (media)** — after that the
> live instance keeps data permanently.

---

## Step 1 — Firebase (the login) — *you, ~10 min*

1. Go to <https://console.firebase.google.com> → **Add project** (or open your existing one).
2. **Authentication** → *Get started* → **Sign-in method** → enable **Google** → Save.
3. **Project settings** (gear ⚙️) → **General** → *Your apps* → **Add app → Web** (`</>`), register it,
   and copy the `firebaseConfig` values:
   - `apiKey`, `projectId`, `authDomain`, `appId` *(these are public — safe to share)*
4. **Project settings** → **Service accounts** → **Generate new private key** → saves a `.json` file.
   *(This is SECRET — it goes into Render only, never into git or chat.)*

Send me the **`firebaseConfig` values** + the **two Gmail addresses**; keep the service-account JSON
for Step 3.

## Step 2 — Push the code to GitHub — *me, on your go*

The login code (`server/auth.js` + frontend) and the recent gem/look fixes aren't committed yet.
On your go I'll commit them and push to `github.com/Jozeque/A.i-do` (`main`). No secrets are pushed —
`.env`, media, and `node_modules` are gitignored.

## Step 3 — Render (the host) — *you, ~10 min, I'll guide*

1. <https://render.com> → sign up with **GitHub** → **New → Blueprint** → pick the **A.i-do** repo.
   Render reads `render.yaml` and creates the web service.
2. Open the service → **Environment** → add these (the repo only declares them; values live here):

   | Key | Value |
   |---|---|
   | `ANTHROPIC_API_KEY` | your Anthropic key *(rotate it first — see below)* |
   | `GEMINI_API_KEY` | your Gemini key *(rotate it first)* |
   | `ALLOWED_EMAILS` | `you@gmail.com,liran@gmail.com` |
   | `FIREBASE_API_KEY` | from `firebaseConfig.apiKey` |
   | `FIREBASE_PROJECT_ID` | from `firebaseConfig.projectId` |
   | `FIREBASE_AUTH_DOMAIN` | from `firebaseConfig.authDomain` *(optional)* |
   | `FIREBASE_APP_ID` | from `firebaseConfig.appId` *(optional)* |

3. The **service-account JSON** (secret) — easiest way on Render is a **Secret File**:
   - Service → **Environment → Secret Files** → add file `firebase.json`, paste the JSON contents.
   - Then add env var `GOOGLE_APPLICATION_CREDENTIALS = /etc/secrets/firebase.json`.
   - *(Alternative: paste the whole JSON, minified to one line, into a `FIREBASE_SERVICE_ACCOUNT` env var.)*
4. Leave `APP_PASSWORD` blank — Firebase login supersedes the old password gate.
5. **Plan:** Free works but sleeps after 15 min idle (slow first load). **Starter ($7/mo)** keeps it
   always-on — recommended for a tool you'll actually use.
6. **Deploy.** Render runs `npm install` then `npm start` and gives you a URL like
   `https://ai-video-studio.onrender.com`.

## Step 4 — Let Firebase trust the live URL — *you, 2 min*

Firebase → **Authentication → Settings → Authorized domains** → **Add domain** → your Render host
(`ai-video-studio.onrender.com`). Without this, the Google popup is blocked on the live site.
(`localhost` is already authorized, which is why local testing works.)

## Step 5 — Test — *together*

Open the Render URL → **Continue with Google**:
- Your Gmail → you're in. Liran's Gmail → he's in.
- Any other account → blocked with "not on the allowlist."

---

## Before you go public: rotate the API keys

The keys in `.env` have sat in plaintext, so treat them as burnable. Generate **new**
Anthropic + Gemini keys, put the new ones in Render (Step 3), and revoke the old ones. Update your
local `.env` to the new keys too.

## What's next (durable data)

② **Firestore** (metadata) + ③ **Google Drive** (media, on your 2 TB) → ④ migrate your local
projects up → then the live instance holds everything permanently and you + Liran share one workspace.
