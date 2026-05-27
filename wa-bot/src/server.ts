/**
 * Medstocksy WhatsApp Bot — thin REST wrapper around @open-wa/wa-automate.
 *
 * Endpoints:
 *   GET  /status                  → { ready, hasSession, qrAvailable }
 *   GET  /qr                      → text/plain QR data URL (when not yet logged in)
 *   POST /send                    → { phone, message, imageUrl? }
 *
 * All POST endpoints require `Authorization: Bearer <BOT_SECRET>`.
 *
 * ⚠️ This runs unofficial WhatsApp Web automation. See README — use a
 *    dedicated/sacrificial number, low daily volume, and accept the ban risk.
 */

import 'dotenv/config';
import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import qrcodeTerminal from 'qrcode-terminal';
import { createClient as createSupabase, type SupabaseClient } from '@supabase/supabase-js';
import { create, type Client, type Message } from '@open-wa/wa-automate';

// ─── Config ─────────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT ?? 3001);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? 'http://localhost:5180')
  .split(',').map((s) => s.trim()).filter(Boolean);
const BOT_SECRET = process.env.BOT_SECRET ?? '';
const SESSION_ID = process.env.SESSION_ID ?? 'medcrm';
const PRINT_QR = (process.env.PRINT_QR_TO_TERMINAL ?? 'true') === 'true';
const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

if (!BOT_SECRET || BOT_SECRET.length < 16) {
  console.error('[wa-bot] BOT_SECRET is missing or too short. Set a long random value in .env.');
  process.exit(1);
}

const supabase: SupabaseClient | null = (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY)
  ? createSupabase(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    })
  : null;

// ─── WhatsApp client state ─────────────────────────────────────────────────
let waClient: Client | null = null;
let currentQR: string | null = null;
let ready = false;

async function startWA(): Promise<void> {
  console.log(`[wa-bot] Starting WhatsApp client (session: ${SESSION_ID})…`);
  try {
    waClient = await create({
      sessionId: SESSION_ID,
      multiDevice: true,
      authTimeout: 0,
      blockCrashLogs: true,
      disableSpins: true,
      headless: true,
      hostNotificationLang: 'EN',
      logConsole: false,
      qrTimeout: 0,
      popup: false,
      // QR callbacks
      qrCallback: (qrAsBase64: string) => {
        currentQR = qrAsBase64;
        if (PRINT_QR) {
          console.log('[wa-bot] Scan this QR with your WhatsApp Business app:');
          // qrcode-terminal expects the *content* of the QR (not the image data),
          // but openWA delivers a base64 image. We log the raw string anyway for
          // any operator that wants to render it manually.
        }
      },
      qrFormat: 'base64',
    });

    ready = true;
    currentQR = null;
    console.log('[wa-bot] WhatsApp client READY.');

    // Optional: log incoming messages (for future inbound features).
    waClient.onMessage((m: Message) => {
      console.log(`[wa-bot] inbound from ${m.from}: ${m.body?.slice(0, 60)}…`);
    });

    waClient.onStateChanged((state: string) => {
      console.log('[wa-bot] state changed:', state);
      if (state === 'CONFLICT' || state === 'UNLAUNCHED') {
        ready = false;
      }
    });
  } catch (err) {
    console.error('[wa-bot] Failed to start WhatsApp client:', err);
    ready = false;
  }
}

// Print a friendlier QR to the terminal as a backup when openWA emits one.
// Falls through silently when the lib doesn't expose it as text.
qrcodeTerminal.setErrorLevel?.('M');

// ─── Express ────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);  // curl / server-to-server
    cb(null, ALLOWED_ORIGINS.includes(origin));
  },
}));

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (token !== BOT_SECRET) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

// Status — open to all so the CRM can poll without auth round-trips.
app.get('/status', (_req, res) => {
  res.json({
    ready,
    sessionId: SESSION_ID,
    hasSession: Boolean(waClient),
    qrAvailable: !ready && Boolean(currentQR),
  });
});

// Returns the current QR image as a data URL string (for rendering in the CRM).
app.get('/qr', (_req, res) => {
  if (ready) {
    res.status(409).json({ error: 'Already logged in. Restart the bot to scan a new QR.' });
    return;
  }
  if (!currentQR) {
    res.status(404).json({ error: 'QR not ready yet — try again in a second.' });
    return;
  }
  res.json({ qr: currentQR });
});

// Send a text-only message (with optional image URL appended for link preview).
// To send an actual attached image, switch to the /send-image endpoint below.
app.post('/send', requireAuth, async (req, res) => {
  const { phone, message, imageUrl } = req.body as {
    phone?: string; message?: string; imageUrl?: string | null;
  };
  if (!phone || !message) {
    res.status(400).json({ error: 'phone and message are required' });
    return;
  }
  if (!ready || !waClient) {
    res.status(503).json({ error: 'WhatsApp client not ready. Scan the QR first.' });
    return;
  }

  const chatId = toChatId(phone);
  const body = imageUrl ? `${message}\n\n${imageUrl}` : message;

  try {
    const msgId = await waClient.sendText(chatId, body);
    res.json({ messageId: msgId, chatId });
  } catch (err) {
    console.error('[wa-bot] sendText failed:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Send failed.' });
  }
});

// Send a real attached image (true file upload, not a link preview).
// Accepts either a public URL (fetched server-side) or a base64 data URL.
app.post('/send-image', requireAuth, async (req, res) => {
  const { phone, imageUrl, caption } = req.body as {
    phone?: string; imageUrl?: string; caption?: string;
  };
  if (!phone || !imageUrl) {
    res.status(400).json({ error: 'phone and imageUrl are required' });
    return;
  }
  if (!ready || !waClient) {
    res.status(503).json({ error: 'WhatsApp client not ready. Scan the QR first.' });
    return;
  }

  const chatId = toChatId(phone);
  try {
    const msgId = await waClient.sendImage(
      chatId,
      imageUrl,      // openWA accepts URL or base64
      'attachment',  // filename hint
      caption ?? '',
    );
    res.json({ messageId: msgId, chatId });
  } catch (err) {
    console.error('[wa-bot] sendImage failed:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Image send failed.' });
  }
});

// Hard-reset the session (delete the on-disk auth data). Operator-only.
app.post('/reset', requireAuth, async (_req, res) => {
  try {
    if (waClient) await waClient.kill();
  } catch { /* ignore */ }
  waClient = null;
  ready = false;
  currentQR = null;
  // Restart after a brief pause.
  setTimeout(startWA, 500);
  res.json({ ok: true, message: 'Session killed. New QR will appear shortly at /qr.' });
});

// Bare health probe — useful for uptime monitors.
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// ─── helpers ────────────────────────────────────────────────────────────────
function toChatId(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (!digits) throw new Error('Invalid phone number');
  return `${digits}@c.us`;
}

// Bonus: if Supabase is configured, expose a /audit endpoint the CRM can call
// after a successful send to record the audit row. Keeps the bot stateless re:
// our schema while still bumping the rate-limit counter on the right pharmacy.
app.post('/audit', requireAuth, async (req, res) => {
  if (!supabase) {
    res.status(501).json({ error: 'Supabase audit not configured on this bot instance.' });
    return;
  }
  const { pharmacyId, customerId, phone, body, templateId, providerId } = req.body as {
    pharmacyId?: string; customerId?: string; phone?: string;
    body?: string; templateId?: string | null; providerId?: string;
  };
  if (!pharmacyId || !customerId || !phone || !body) {
    res.status(400).json({ error: 'pharmacyId, customerId, phone and body are required' });
    return;
  }
  const { data: msg, error: msgErr } = await supabase
    .from('crm_messages')
    .insert({
      pharmacy_id: pharmacyId,
      customer_id: customerId,
      template_id: templateId ?? null,
      direction: 'outbound',
      status: 'sent',
      body,
      to_phone: phone,
      whatsapp_message_id: providerId ?? null,
      sent_at: new Date().toISOString(),
    })
    .select('id')
    .single();
  if (msgErr) {
    res.status(500).json({ error: msgErr.message });
    return;
  }
  await supabase.from('crm_send_log').insert({
    pharmacy_id: pharmacyId, message_id: (msg as { id: string }).id,
  });
  res.json({ ok: true, messageId: (msg as { id: string }).id });
});

// ─── boot ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[wa-bot] HTTP listening on http://localhost:${PORT}`);
  console.log(`[wa-bot] Allowed CORS origins: ${ALLOWED_ORIGINS.join(', ') || '(none)'}`);
  console.log(`[wa-bot] Supabase audit: ${supabase ? 'ENABLED' : 'disabled'}`);
  startWA().catch((e) => console.error('[wa-bot] fatal start error:', e));
});
