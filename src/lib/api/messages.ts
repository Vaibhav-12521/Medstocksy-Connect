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
 * No new tab is created after the first call within the session: subsequent
 * calls with the same target name navigate the existing tab. So a queue of
 * sends ends up as ONE tab that auto-updates per recipient.
 */
export function openWhatsAppCompose(args: ComposeArgs): boolean {
  const digits = args.phone.replace(/\D/g, '');
  if (!digits) return false;

  const fullText = args.imageUrl ? `${args.body}\n\n${args.imageUrl}` : args.body;
  const text = encodeURIComponent(fullText);

  const isMobile = typeof navigator !== 'undefined'
    && /(android|iphone|ipad|mobile)/i.test(navigator.userAgent);

  // Mobile → deep link straight into the WA app. Desktop → web.whatsapp.com
  // directly (skips the wa.me redirect, and our tab name reuse works here).
  const url = isMobile
    ? `whatsapp://send?phone=${digits}&text=${text}`
    : `https://web.whatsapp.com/send?phone=${digits}&text=${text}`;

  const win = window.open(url, WA_TAB_NAME, 'noopener');
  return Boolean(win);
}

export interface LogManualSendArgs {
  pharmacyId: string;
  customerId: string;
  phone: string;          // E.164 — stored as `to_phone`
  body: string;
  templateId?: string | null;
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
