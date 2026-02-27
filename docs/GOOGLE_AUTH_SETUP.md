# Google Sign-In Setup

## 1. Create Google OAuth credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
2. Create a project (or select existing)
3. Click **Create Credentials** → **OAuth client ID**
4. If prompted, configure the OAuth consent screen (External, add your email)
5. Application type: **Web application**
6. Name: e.g. "CryptoSignals Pro"
7. **Authorized redirect URIs** – add:
   - Local: `http://localhost:3000/auth/google/callback`
   - Production: `https://your-app.onrender.com/auth/google/callback`
8. Copy **Client ID** and **Client Secret**

## 2. Set environment variables

**Local (.env):**
```
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
```

**Render:**
- `GOOGLE_CLIENT_ID` – from step 1
- `GOOGLE_CLIENT_SECRET` – from step 1
- `GOOGLE_CALLBACK_URL` – `https://your-app.onrender.com/auth/google/callback`  
  (or leave unset; Render sets `RENDER_EXTERNAL_URL` automatically)

## 3. Restart the app

The "Continue with Google" button appears on login and register when credentials are set.
