/**
 * Campaign send helpers — resolve a segment's opted-in customers and finalize
 * a campaign once the messages have been dispatched (via the wa.me/ queue or
 * the openWA bot). Recipient delivery rows are written to
 * crm_campaign_recipients for the per-customer audit.
 */
import { supabase } from '@/lib/supabase';

export interface CampaignRecipient {
  id: string;
  name: string;
  phone: string;
}

/** Resolve the opted-in customers for a segment. Opt-outs are always excluded
 *  (Rule 9). Mirrors the recipient-count logic in CampaignDialog but returns
 *  the actual rows needed to send. */
export async function resolveSegmentCustomers(
  pharmacyId: string,
  segmentKey: string
): Promise<CampaignRecipient[]> {
  if (segmentKey === 'all') {
    const { data, error } = await supabase
      .from('crm_customers')
      .select('id, name, phone')
      .eq('pharmacy_id', pharmacyId)
      .eq('whatsapp_opted_in', true)
      .order('name');
    if (error) throw new Error(error.message);
    return ((data ?? []) as unknown) as CampaignRecipient[];
  }

  // Chronic = manual tag; everything else = derived auto-tag view.
  let ids: string[] = [];
  if (segmentKey === 'chronic') {
    const { data: tags, error } = await supabase
      .from('crm_tags')
      .select('customer_id')
      .eq('pharmacy_id', pharmacyId)
      .eq('tag_key', 'chronic');
    if (error) throw new Error(error.message);
    ids = ((tags ?? []) as unknown as { customer_id: string }[]).map((r) => r.customer_id);
  } else {
    const { data: rows, error } = await supabase
      .from('crm_customer_auto_tags')
      .select('customer_id')
      .eq('pharmacy_id', pharmacyId)
      .eq('tag', segmentKey);
    if (error) throw new Error(error.message);
    ids = ((rows ?? []) as unknown as { customer_id: string }[]).map((r) => r.customer_id);
  }
  if (ids.length === 0) return [];

  const { data, error } = await supabase
    .from('crm_customers')
    .select('id, name, phone')
    .in('id', ids)
    .eq('whatsapp_opted_in', true)
    .order('name');
  if (error) throw new Error(error.message);
  return ((data ?? []) as unknown) as CampaignRecipient[];
}

/** Mark a campaign as actively sending. */
export async function markCampaignSending(campaignId: string, total: number): Promise<void> {
  const { error } = await supabase
    .from('crm_campaigns')
    .update({ status: 'sending', total_recipients: total } as never)
    .eq('id', campaignId);
  if (error) throw new Error(error.message);
}

/** Record one recipient's delivery + (best-effort) link the message. */
export async function recordCampaignRecipient(args: {
  campaignId: string;
  customerId: string;
  messageId?: string | null;
}): Promise<void> {
  const { error } = await supabase
    .from('crm_campaign_recipients')
    .upsert({
      campaign_id: args.campaignId,
      customer_id: args.customerId,
      status: 'sent',
      message_id: args.messageId ?? null,
      sent_at: new Date().toISOString(),
    } as never, { onConflict: 'campaign_id,customer_id' });
  if (error) throw new Error(error.message);
}

/** Finalize a campaign after the queue completes. */
export async function finalizeCampaign(args: {
  campaignId: string;
  sentCount: number;
  totalRecipients: number;
}): Promise<void> {
  const { error } = await supabase
    .from('crm_campaigns')
    .update({
      status: 'sent',
      sent_count: args.sentCount,
      total_recipients: args.totalRecipients,
    } as never)
    .eq('id', args.campaignId);
  if (error) throw new Error(error.message);
}
