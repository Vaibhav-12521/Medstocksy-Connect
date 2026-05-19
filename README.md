# medcrm — Customer Relations for Pharmacies

> **Note on scope:** this is a production-quality scaffold, **not a finished product**. The schema, auth, RLS, layout, and core pages are real. The campaign wizard, reminder rule editor, and a few other interactions are marked TODO and need ~1–2 more weeks of focused work to fully ship. Read the [What's done vs what's left](#whats-done-vs-whats-left) section before deploying.

A WhatsApp-driven CRM that plugs into the existing **Medstocksy Inventory** app at [app.medstocksy.in](https://app.medstocksy.in). Same Supabase project = single sign-on. Customers, segments, campaigns, reminders, templates, activity stream — all built around the PRD in `wire/medstocksy_connect_prd.md` and the rules in `wire/medstocksy_connect_rules.md`.

---

## ⚙️ Stack

| Layer | Choice | Why |
|-------|--------|-----| 
| Frontend | **React 18 + TypeScript + Vite 6** | Fast HMR, code-split routes, strict types |
| Styling | **Tailwind 3 + shadcn/ui** | Matches parent inventory app's design tokens exactly |
| State | **TanStack Query 5** + React Context | Server cache + auth/pharmacy state |
| Routing | **react-router-dom v6** | File-organised routes |
| Forms | react-hook-form + zod | Type-safe validation |
| Animations | **Framer Motion 11** | Drawer transitions, page fade-in, list stagger |
| Backend | **Supabase** (Postgres + Auth + RLS) | Same project as inventory app — SSO via shared `auth.users` |
| Serverless | **Vercel Functions** (`api/`) | WhatsApp send + webhook handlers |
| WhatsApp | **Meta Cloud API v21** | Direct integration (Twilio fallback supported) |

---

## 🚀 Getting started

### 1. Clone the parent's Supabase project credentials

This app **must** share the inventory app's Supabase project so users only sign in once. Copy the same `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` values:

```bash
cp .env.example .env
# Edit .env with your Supabase URL + anon key (same as Medstocksy-inventory)
```

### 2. Apply the database migration

In your Supabase project SQL editor (or via CLI), run:

```bash
supabase db push --include-all   # if using local supabase CLI
# OR copy-paste supabase/migrations/20260507_medcrm.sql into the SQL editor
```

This creates 13 tables under the `crm_` prefix, plus RLS policies, audit triggers, derived views, and 3 seeded message templates. Existing inventory tables are not touched.

### 3. Install + run

```bash
npm install
npm run dev   # http://localhost:5174
```

The first time you log in (with the same Google account as the inventory app), you'll see an Onboarding screen to create your pharmacy record.

### 4. Build for production

```bash
npm run build
npm run preview   # smoke test the bundle locally
```

---

## 📡 WhatsApp Business setup (separate from app deployment)

The most fiddly part of the whole product — give yourself half a day.

### Meta Cloud API path (recommended)

1. Create a **Meta Business Account** at [business.facebook.com](https://business.facebook.com)
2. Add a **WhatsApp Business Platform** product to your app
3. Add a **system user** with `whatsapp_business_messaging` + `whatsapp_business_management` perms
4. Generate a **permanent access token** for that system user
5. Get your **WhatsApp phone number ID** from the API setup screen
6. Submit your message templates (T1, T2, T3 from `crm_templates`) for approval in the Meta dashboard
7. Once approved, set `whatsapp_template_name` on each row in `crm_templates`

### Vercel env vars

Set these as **encrypted** in Vercel project settings:

```
SUPABASE_SERVICE_ROLE_KEY    # from Supabase dashboard → settings → API
WHATSAPP_PHONE_NUMBER_ID
WHATSAPP_ACCESS_TOKEN
WHATSAPP_VERIFY_TOKEN        # any random string — set the same on Meta webhook
```

### Wire the webhook

In Meta dashboard → WhatsApp → Configuration → Webhook:

```
Callback URL:   https://<your-vercel-domain>/api/whatsapp/webhook
Verify token:   <same as WHATSAPP_VERIFY_TOKEN above>
Subscribe to:   messages
```

The webhook handles: delivery receipts, inbound replies, and **automatic opt-out** when a customer replies "STOP" / "UNSUBSCRIBE".

---

## 🔐 Security model

| Layer | Mechanism |
|-------|-----------|
| Auth | Supabase JWT, PKCE flow, persisted in localStorage |
| Multi-tenant isolation | Every table has `pharmacy_id` + RLS policy via `crm_is_member()` |
| RBAC | `admin` / `manager` / `staff` roles via `crm_members` |
| Server-side authorization | `/api/whatsapp/send` validates JWT + membership + rate limit before calling WhatsApp |
| Audit trail | `crm_audit_log` table + trigger on `customers`, `messages`, `campaigns`. 90-day retention. |
| Webhook trust | `WHATSAPP_VERIFY_TOKEN` matched on GET handshake. (TODO: signature validation on POST) |
| Secrets | Service role key only used server-side. Client uses anon key. No `.env` checked in. |
| Headers | `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin` (set in `vercel.json`) |

---

## 📂 Project structure

```
medcrm-v2/
├── api/                          # Vercel serverless functions
│   └── whatsapp/
│       ├── send.ts               # POST — server-validated dispatch
│       └── webhook.ts            # GET (verify) + POST (events)
├── public/                       # static assets (favicon etc.)
├── src/
│   ├── components/
│   │   ├── crm/                  # domain components
│   │   │   ├── ComposeDrawer.tsx # the highest-stakes UI
│   │   │   └── RateMeter.tsx     # ambient WhatsApp rate display
│   │   ├── layout/
│   │   │   ├── AppSidebar.tsx    # matches inventory app pattern
│   │   │   └── Layout.tsx        # responsive shell + mobile drawer
│   │   └── ui/                   # shadcn primitives (button, card, input, …)
│   ├── contexts/
│   │   ├── AuthContext.tsx       # Supabase auth wrapper
│   │   └── PharmacyContext.tsx   # active pharmacy + role
│   ├── hooks/
│   ├── lib/
│   │   ├── api/                  # typed data layer
│   │   │   ├── customers.ts
│   │   │   └── messages.ts
│   │   ├── supabase.ts           # client (single shared instance)
│   │   └── utils.ts              # cn, formatINR, validateIndianPhone, …
│   ├── pages/                    # routes
│   │   ├── Login.tsx
│   │   ├── Onboarding.tsx
│   │   ├── Dashboard.tsx
│   │   ├── Customers.tsx
│   │   ├── CustomerProfile.tsx
│   │   ├── Segments.tsx
│   │   ├── Campaigns.tsx
│   │   ├── Reminders.tsx
│   │   ├── Templates.tsx
│   │   ├── Activity.tsx
│   │   ├── Settings.tsx
│   │   └── NotFound.tsx
│   ├── types/
│   │   └── database.ts           # Supabase types (regen with `npm run supabase:types`)
│   ├── App.tsx
│   ├── main.tsx
│   └── index.css                 # design tokens (matches inventory app)
├── supabase/
│   └── migrations/
│       └── 20260507_medcrm.sql   # 619-line schema + RLS + triggers + views
├── components.json               # shadcn config
├── tailwind.config.ts
├── tsconfig*.json
├── vite.config.ts
├── vercel.json                   # security headers + function timeouts
└── package.json
```

---

## ✅ What's done vs what's left

This is the honest accounting. **Read this before deploying.**

### ✅ Production-ready

- [x] **SQL schema (619 lines)** — 13 tables, RLS policies, audit trigger, rate-limit function, derived views (`crm_customer_stats`, `crm_customer_auto_tags`, `crm_whatsapp_health`)
- [x] **Auth flow** — Google OAuth + email/password, session persistence, route guards
- [x] **Multi-pharmacy support** — pharmacy switcher in sidebar, `useActivePharmacy()` hook
- [x] **RBAC** — admin / manager / staff distinguished via `crm_members.role`
- [x] **Onboarding** — first-time setup creates the pharmacy + owner record
- [x] **Layout** — responsive sidebar (mobile drawer), matches inventory app's design language
- [x] **Customer list** — search, segment chips (6 fixed), tabular layout, derived auto-tags
- [x] **Customer profile** — hero, stat strip, activity timeline (messages + bills), opt-out badge
- [x] **Compose drawer** — template picker, variable rendering, live preview, ambient rate meter, opt-out enforcement, send via `/api/whatsapp/send`
- [x] **Dashboard** — KPIs, upcoming reminders feed, WhatsApp health card
- [x] **Segments page** — 6 fixed segments with live counts from auto-tag view
- [x] **Templates page** — pre-built (3 seeded) + custom listing
- [x] **Campaigns / Reminders / Activity / Settings pages** — read-only versions wired to the schema
- [x] **WhatsApp send endpoint** — JWT verification, membership check, rate-limit, opt-in check, Meta Cloud API call, audit insert
- [x] **WhatsApp webhook** — verification handshake, status updates, inbound message logging, automatic opt-out on "STOP"
- [x] **Audit log + retention** — `crm_audit_trigger` on key tables, 90-day purge function ready for pg_cron

### 🟡 Functional stub — needs ~1–2 weeks more

- [ ] **Campaign wizard** (3-step flow): segment → template → schedule. Page lists campaigns but creation flow is `Plus → TODO`.
- [ ] **Reminder rule editor** — list works, "New rule" / "Edit" is `TODO`.
- [ ] **Add customer / Edit customer dialogs** — `Plus` and `Edit` buttons are wired but open nothing.
- [ ] **Custom template editor** — read works; "+ New" is `TODO`.
- [ ] **User & role management** in Settings — schema supports it, UI not built.
- [ ] **Custom segments** — schema supports `segment_key = 'custom:<filter>'`; builder UI not built.
- [ ] **Bulk-send approval flow** — schema has `approved_at` / `approved_by`; UI not built. Currently any send below 100 recipients goes through.

### ❌ Not started (V2)

- [ ] **Scheduled reminder dispatcher** — needs Supabase cron + a small worker function to query `crm_scheduled_reminders` where `scheduled_for < now()` and trigger sends.
- [ ] **Tests** — no unit/integration tests yet. Highest priority: rate-limiter, opt-out enforcement, RLS isolation.
- [ ] **PWA** — manifest + service worker not configured (parent app has them — easy port).
- [ ] **i18n** — Hindi support promised in PRD §3.4; not started.
- [ ] **Sentry / error monitoring** — env var present, integration not wired.
- [ ] **WhatsApp webhook signature verification** — currently relies on verify token only; should validate `x-hub-signature-256` HMAC.

---

## 🧪 Sanity check after first install

1. `npm install` — should complete without warnings on TypeScript types
2. `npm run typecheck` — should pass with zero errors
3. `npm run dev` — open http://localhost:5174, redirected to /login
4. Sign in with the same Google account as the inventory app — should land on /onboarding (since you have no pharmacy yet)
5. Create a pharmacy — should land on /
6. Dashboard loads with empty KPIs (0 customers etc.) — that's correct
7. Visit /templates — should see the 3 seeded templates (T1, T2, T3)

If any step fails, check `supabase/migrations/20260507_medcrm.sql` actually ran. The `crm_my_pharmacies` view must exist.

---

## 🚦 Deployment to Vercel

```bash
# 1. Connect repo to Vercel project
# 2. Set env vars (Settings → Environment Variables):
#    VITE_SUPABASE_URL
#    VITE_SUPABASE_PUBLISHABLE_KEY
#    VITE_INVENTORY_APP_URL    (https://app.medstocksy.in)
#    SUPABASE_SERVICE_ROLE_KEY (encrypted)
#    WHATSAPP_PHONE_NUMBER_ID
#    WHATSAPP_ACCESS_TOKEN
#    WHATSAPP_VERIFY_TOKEN
# 3. Deploy
```

Vercel auto-detects Vite. The `vercel.json` adds security headers and function timeouts.

After deploying, configure the WhatsApp webhook in Meta dashboard pointing to `https://<your-domain>/api/whatsapp/webhook`.

---

## 📖 Source docs

- **Product spec:** `../wire/medstocksy_connect_prd.md`
- **Design rules:** `../wire/medstocksy_connect_rules.md`
- **Theme spec:** `../wire/medstocksy_connect_theme.md`
- **Wireframes:** `../wire/medcrm/*.svg`

---

## 🛡 License

Proprietary — Medstocksy. Internal use only.

---

Built by Vaibhav Singh · Lucknow, India · Full-Stack Web Developer
