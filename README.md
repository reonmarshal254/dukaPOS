# DukaPOS Backend

Admin server for the DukaPOS mobile app. Tracks installs and shows a live
dashboard of registered devices and businesses.

## Stack

- **Node.js** + **Express** — API server
- **PostgreSQL** (Aiven cloud) — persistent storage
- **Single-page HTML dashboard** — no framework, no build step

## Setup

```bash
cd backend
npm install
```

Copy `.env.example` (or edit `.env`) and fill in your values:

```
PORT=5000
DB_URL=postgres://...          # Aiven connection string
ALLOWED_ORIGIN=https://...     # leave blank to allow all origins (dev only)
```

## Running

```bash
# Production
npm start

# Development (auto-restart on file change, Node 18+)
npm run dev
```

## API

| Method | Path            | Description                              |
|--------|-----------------|------------------------------------------|
| POST   | /api/register   | Mobile app check-in (upserts device row) |
| GET    | /api/stats      | Aggregate counts for the dashboard       |
| GET    | /api/users      | Paginated list of registered devices     |
| GET    | /               | Admin dashboard HTML                     |

### POST /api/register — request body

```json
{
  "deviceId":     "abc123",
  "businessName": "Mama Grace Shop",
  "ownerName":    "Grace Wanjiku",
  "phone":        "0712345678",
  "location":     "Nairobi, Westlands",
  "deviceName":   "Pixel 7",
  "deviceModel":  "Pixel 7",
  "osName":       "Android",
  "osVersion":    "14",
  "appVersion":   "1.0.0",
  "buildNumber":  "1",
  "platform":     "android",
  "isPhysical":   true
}
```

### GET /api/users — query params

| Param    | Default | Description                    |
|----------|---------|--------------------------------|
| page     | 1       | Page number                    |
| limit    | 50      | Rows per page (max 100)        |
| search   | —       | Free-text search               |
| platform | —       | `android` or `ios`             |

## Wiring the mobile app

In `src/hooks/useDevice.ts`, after the device info is resolved, add a
`fetch` call to `POST /api/register` with the device and business data.
The backend will upsert the row and update `last_seen_at` on every launch.
