# Medstocksy WhatsApp Bot

Headless WhatsApp Web sender using **@open-wa/wa-automate**. Runs as a sibling
to the CRM (Vite + Supabase) and exposes a tiny REST API so the frontend can
dispatch messages without manual click-to-chat.

> ⚠️ **Ban risk warning.** This uses unofficial WhatsApp Web automation. Meta's
> ToS prohibits it. Bans happen — particularly on new numbers, high volume, or
> after spam reports. **Use a dedicated/sacrificial WhatsApp Business number,
> not your main pharmacy line.** Treat this as a stopgap until you finish
> Meta Cloud API verification.

## 1. Install

```bash
cd wa-bot
npm install
cp .env.example .env
```

Edit `.env`:
- `BOT_SECRET` — long random hex (`openssl rand -hex 32`).
- `ALLOWED_ORIGINS` — your Vite dev URL + production origin.
- `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` — optional; enables the
  `/audit` endpoint that writes `crm_messages` + `crm_send_log` rows
  server-side.

## 2. Run

```bash
npm run dev
```

First start: a QR is emitted to the terminal **and** exposed at
`GET /qr`. Open WhatsApp on your phone → Settings → Linked devices →
Link a device → scan the QR.

Subsequent starts auto-log in using the session saved in
`_IGNORE_<SESSION_ID>/`.

## 3. Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/status` | public | `{ ready, hasSession, qrAvailable }` |
| `GET` | `/qr` | public | Returns the current QR data URL while not logged in |
| `POST` | `/send` | Bearer | `{ phone, message, imageUrl? }` — text send (URL becomes preview) |
| `POST` | `/send-image` | Bearer | `{ phone, imageUrl, caption? }` — real image attachment |
| `POST` | `/reset` | Bearer | Kills the session, fresh QR |
| `POST` | `/audit` | Bearer | Optional Supabase write-through after a send |
| `GET` | `/healthz` | public | Uptime probe |

Send the `BOT_SECRET` in `Authorization: Bearer <secret>` for the authed
routes.

### Example

```bash
curl -X POST http://localhost:3001/send \
  -H "Authorization: Bearer $BOT_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"phone":"+919876543210","message":"Hi Ramesh, time to refill your BP medicine!"}'
```

## 4. Wire it into the CRM

In the CRM's environment (`.env.local` next to the Vite app):

```
VITE_WA_BOT_URL=http://localhost:3001
VITE_WA_BOT_SECRET=<same as wa-bot/.env>
```

The CRM's `openWhatsAppCompose` helper detects these env vars and routes
sends through the bot instead of `wa.me/`. Falls back to manual
click-to-chat when the vars are missing or the bot's `/status` returns
`ready: false`.

> Putting the secret in a `VITE_` env var means it's bundled into the
> browser code. That's fine for a single-tenant deployment where you
> control who can access the CRM origin, but **never** ship this setup
> to a multi-tenant production. Use a Vercel serverless proxy with a
> server-side secret instead.

## 5. Production deployment

The bot needs a **persistent Node process** (Vercel/Netlify serverless
won't work — Puppeteer + WA session require a long-lived process).

Cheap options:
- **Railway** (~₹400/mo) — easiest; supports persistent storage.
- **Render** Web Service — free tier exists but sleeps after 15 min idle.
- **Fly.io** — paid plans have persistent volumes.
- **Self-hosted** — any VPS with Node 20+.

You'll also need:
- Chromium installed in the container (Puppeteer downloads its own copy
  but some hosts strip it; check `chromium-revision` in the openWA logs).
- Persistent disk for `_IGNORE_<SESSION_ID>/` (otherwise you re-scan QR
  on every redeploy).

## 6. Volume + safety guidance

Per WhatsApp's anti-spam patterns:
- **New number:** ≤30 messages/day for the first 2 weeks.
- **Established number:** ≤100/day.
- Send only to customers who have you saved (mutual contact).
- Personalize every message (templates already do this via `{name}` etc).
- Watch for spam reports; **pause sending for 24h** at the first sign.

The bot does not enforce these — the CRM does, via `crm_can_send_now()`
and the `crm_pharmacies.rate_limit_per_hour` setting. Keep those
configured sensibly.
