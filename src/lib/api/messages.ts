import { supabase } from '@/lib/supabase';

export interface WhatsAppHealth {
  pharmacy_id: string;
  rate_limit_per_hour: number;
  sends_last_hour: number;
  bounce_rate_24h: number | null;
  opt_outs_30d: number;
  total_customers: number;
  send_window_start: string;
  send_window_end: string;
}

export async function getWhatsAppHealth(pharmacyId: string): Promise<WhatsAppHealth | null> {
  const { data, error } = await supabase
    .from('crm_whatsapp_health')
    .select('*')
    .eq('pharmacy_id', pharmacyId)
    .maybeSingle();
  if (error) throw error;
  return (data as WhatsAppHealth | null) ?? null;
}

export async function canSendNow(pharmacyId: string): Promise<boolean> {
  // Cast: hand-typed Database shim doesn't fully model RPC arg types.
  // Replace with `npm run supabase:types` output once the migration is applied.
  const rpc = supabase.rpc as unknown as (
    fn: string,
    args: Record<string, unknown>
  ) => Promise<{ data: unknown; error: { message: string } | null }>;
  const { data, error } = await rpc('crm_can_send_now', { p_pharmacy_id: pharmacyId });
  if (error) throw new Error(error.message);
  return Boolean(data);
}

export interface SendMessagePayload {
  pharmacyId: string;
  customerId: string;
  templateId: string;
  variables: Record<string, string>;
}

/**
 * Client-side send: posts to the Vercel serverless function which:
 *   1. Validates rate limit + opt-in status
 *   2. Renders the template
 *   3. Calls the WhatsApp Business API
 *   4. Inserts crm_messages row with the WABA message ID
 *   5. Logs to crm_send_log for the rate-limit window
 *
 * NOTE: this path requires the official WhatsApp Cloud API to be set up.
 * Use `openWhatsAppCompose` + `logManualSend` for the free click-to-chat flow.
 */
export async function sendMessage(payload: SendMessagePayload): Promise<{ messageId: string }> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Not authenticated');

  const res = await fetch('/api/whatsapp/send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `Send failed: HTTP ${res.status}`);
  }

  return (await res.json()) as { messageId: string };
}

// ─── FREE WhatsApp flow (click-to-chat) ────────────────────────────────────

/** Single named tab — every send across the session reuses this tab instead
 *  of opening a fresh popup. Lets staff hammer Enter on WA Web without tab
 *  spam, and skips the wa.me redirect hop by going to web.whatsapp.com direct.
 */
const WA_TAB_NAME = 'medcrm_wa_tab';

export interface ComposeArgs {
  /** Customer phone — accepts E.164 (+919876543210) or any string with digits. */
  phone: string;
  /** Pre-rendered message text (after variable substitution). */
  body: string;
  /** Optional public image URL — appended to body so WA auto-renders a
   *  link preview (the closest you get to an inline image without the API). */
  imageUrl?: string | null;
}

/**
 * Open WhatsApp with a pre-filled message for one customer. Returns true if
 * the tab opened (or was reused); false only if the browser blocked the popup.
 *
 * Priority order:
 *   1. WhatsApp Desktop / mobile app  (via `whatsapp://send?...`)
 *   2. WhatsApp Web fallback          (via `web.whatsapp.com/send?...`)
 *
 * Detection: we navigate the tab to `whatsapp://` first. If the OS launches
 * the desktop app, the browser tab loses focus (blur event fires within ~1s).
 * If no blur happens within the timeout, the app isn't installed → we
 * navigate the same tab to WhatsApp Web. This pattern is what Slack, Zoom,
 * Discord, etc. use for their "open native app" flows.
 *
 * No new tab is created after the first call within the session: subsequent
 * calls with the same target name navigate the existing tab. So a queue of
 * sends ends up as ONE tab that auto-updates per recipient.
 */
export function openWhatsAppCompose(args: ComposeArgs): boolean {
  const digits = args.phone.replace(/\D/g, '');
  if (!digits) return false;

  const fullText = args.imageUrl ? `${args.body}\n\n${args.imageUrl}` : args.body;
  const text = encodeURIComponent(fullText);

  const appUrl = `whatsapp://send?phone=${digits}&text=${text}`;
  const webUrl = `https://web.whatsapp.com/send?phone=${digits}&text=${text}`;

  const isMobile = typeof navigator !== 'undefined'
    && /(android|iphone|ipad|mobile)/i.test(navigator.userAgent);

  // Mobile: `whatsapp://` is always the right answer — the app is the only
  // reasonable target. No fallback needed (if WA isn't installed on a phone,
  // there's no point in WA Web on that same phone).
  if (isMobile) {
    const win = window.open(appUrl, WA_TAB_NAME, 'noopener');
    return Boolean(win);
  }

  // Desktop: try the native app first, fall back to Web on timeout.
  const win = window.open(appUrl, WA_TAB_NAME, 'noopener');
  if (!win) return false;  // popup blocked

  // If the OS hands focus to WhatsApp Desktop, our window blurs.
  // If after the timeout we never blurred, assume the app isn't installed.
  let appLaunched = false;
  const onBlur = () => { appLaunched = true; };
  window.addEventListener('blur', onBlur, { once: true });

  setTimeout(() => {
    window.removeEventListener('blur', onBlur);
    if (appLaunched) return;
    // App didn't grab focus — fall back to WhatsApp Web in the SAME tab so we
    // don't spawn two windows. `try` guards against cross-origin nav errors
    // some browsers raise after a failed custom-protocol attempt.
    try {
      if (!win.closed) win.location.href = webUrl;
    } catch {
      // Tab is already navigated / dead; open a new fallback tab.
      window.open(webUrl, WA_TAB_NAME, 'noopener');
    }
  }, 1200);

  return true;
}

// ─── openWA bot bridge ─────────────────────────────────────────────────────

/** Whether the optional `wa-bot` Node service is configured in env. */
export function isBotConfigured(): boolean {
  return Boolean(import.meta.env.VITE_WA_BOT_URL && import.meta.env.VITE_WA_BOT_SECRET);
}

interface BotStatus {
  ready: boolean;
  hasSession: boolean;
  qrAvailable: boolean;
}

/** Probe the bot to see if it's online and has a logged-in WA session. */
export async function getBotStatus(): Promise<BotStatus | null> {
  const url = import.meta.env.VITE_WA_BOT_URL;
  if (!url) return null;
  try {
    const res = await fetch(`${url}/status`, { signal: AbortSignal.timeout(2_500) });
    if (!res.ok) return null;
    return (await res.json()) as BotStatus;
  } catch {
    return null;
  }
}

/** Send via the wa-bot service. Returns the WA message ID on success. */
export async function sendViaBot(args: ComposeArgs): Promise<{ messageId: string }> {
  const url = import.meta.env.VITE_WA_BOT_URL;
  const secret = import.meta.env.VITE_WA_BOT_SECRET;
  if (!url || !secret) throw new Error('Bot not configured (VITE_WA_BOT_URL / VITE_WA_BOT_SECRET missing).');

  const res = await fetch(`${url}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
    body: JSON.stringify({
      phone: args.phone,
      message: args.body,
      imageUrl: args.imageUrl ?? null,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(err.error ?? `Bot send failed: HTTP ${res.status}`);
  }
  return (await res.json()) as { messageId: string };
}

/**
 * Smart router: if the bot is configured AND online (ready=true), send
 * through the bot. Otherwise fall back to the manual click-to-chat flow.
 * Returns `{ via: 'bot' | 'manual' }` so callers can decide whether the
 * staff still needs to hit Send in WhatsApp.
 */
export async function sendOrCompose(
  args: ComposeArgs
): Promise<{ via: 'bot' | 'manual'; messageId?: string }> {
  if (isBotConfigured()) {
    const status = await getBotStatus();
    if (status?.ready) {
      const { messageId } = await sendViaBot(args);
      return { via: 'bot', messageId };
    }
  }
  const opened = openWhatsAppCompose(args);
  if (!opened) throw new Error('Popup blocked. Allow popups for this site and try again.');
  return { via: 'manual' };
}

export interface LogManualSendArgs {
  pharmacyId: string;
  customerId: string;
  phone: string;          // E.164 — stored as `to_phone`
  body: string;
  templateId?: string | null;
  campaignId?: string | null;
}

/**
 * Record a manually-sent WhatsApp message in `crm_messages` so the audit
 * trail + dashboard counters stay accurate. Also bumps `crm_send_log` so the
 * hourly rate-limit window reflects this send.
 *
 * Status is 'sent' (we can't observe delivery / read on the free flow).
 */
export async function logManualSend(args: LogManualSendArgs): Promise<{ messageId: string }> {
  const { data, error } = await supabase
    .from('crm_messages')
    .insert({
      pharmacy_id: args.pharmacyId,
      customer_id: args.customerId,
      template_id: args.templateId ?? null,
      campaign_id: args.campaignId ?? null,
      direction: 'outbound',
      status: 'sent',
      body: args.body,
      to_phone: args.phone,
      sent_at: new Date().toISOString(),
    } as never)
    .select('id')
    .single();
  if (error) throw new Error(error.message);

  const messageId = (data as unknown as { id: string }).id;

  // Best-effort: bump the rate limiter. If this fails we don't fail the send.
  await supabase
    .from('crm_send_log')
    .insert({ pharmacy_id: args.pharmacyId, message_id: messageId } as never)
    .then(({ error: logErr }) => {
      if (logErr) console.warn('[manual send] rate-log insert failed:', logErr.message);
    });

  return { messageId };
}
