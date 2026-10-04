# DukaPOS Backend — Deployment Guide

## Deploy to Render (free tier, recommended)

### 1. Push the backend to GitHub

```bash
# From the repo root
git add backend/
git commit -m "Add DukaPOS backend"
git push
```

### 2. Create a new Web Service on Render

1. Go to https://dashboard.render.com → **New → Web Service**
2. Connect your GitHub repo
3. Set **Root Directory** to `backend`
4. Render auto-detects `render.yaml` — confirm the settings:
   - Build command: `npm install`
   - Start command: `node server.js`
   - Plan: **Free**

### 3. Add the DB_URL secret

In Render dashboard → your service → **Environment**:

| Key     | Value                                                                 |
|---------|-----------------------------------------------------------------------|
| DB_URL  | `postgres://avnadmin:...@...aivencloud.com:25592/duka-pos?sslmode=require` |

Use the exact connection string from `backend/.env`.
Do NOT put it in `render.yaml` (it's committed to git).

### 4. Get your service URL

After deploy, Render gives you a URL like:
```
https://dukapos-admin.onrender.com
```

### 5. Update the mobile app

In `mobile/eas.json` update both `preview` and `production` env:
```json
"ADMIN_API_URL": "https://dukapos-admin.onrender.com"
```

In `mobile/app.config.js` the fallback is already set:
```js
? 'https://dukapos-admin.onrender.com'
```

---

## Deploy to Railway (alternative)

```bash
npm install -g @railway/cli
railway login
railway init        # link to a new project
railway add         # add a PostgreSQL plugin (or point to Aiven)
railway up          # deploy
railway domain      # get your public URL
```

Set `DB_URL` via `railway variables set DB_URL="postgres://..."`.

---

## Build the APK

Once the backend is live and you have its URL:

```bash
cd mobile

# Install EAS CLI
npm install -g eas-cli

# Login to Expo account (create one free at expo.dev)
eas login

# Link this project to EAS (run once)
eas init

# Build a shareable APK (no Play Store needed)
eas build --platform android --profile preview

# Build production APK
eas build --platform android --profile production
```

EAS emails you a download link when the build finishes (~10 min).
Share the APK directly or upload to Play Store.

---

## Local dev workflow

```bash
# Terminal 1 — backend
cd backend
npm run dev          # starts on http://localhost:5000

# Terminal 2 — mobile (Android emulator)
cd mobile
npx expo start       # uses ADMIN_API_URL=http://10.0.2.2:5000

# Physical device — change .env:
# ADMIN_API_URL=http://192.168.x.x:5000  (your machine's LAN IP)
```

---

## Checklist before first APK build

- [ ] Backend deployed and reachable at `https://dukapos-admin.onrender.com`
- [ ] `mobile/eas.json` ADMIN_API_URL points to deployed backend
- [ ] `eas init` run inside `mobile/` (sets the real EAS project ID)
- [ ] `app.config.js` extra.eas.projectId updated with real ID
- [ ] `updates.url` in `app.config.js` updated with real project ID
- [ ] `notification-icon.png` exists in `mobile/assets/` ✅
- [ ] All TypeScript errors resolved ✅
