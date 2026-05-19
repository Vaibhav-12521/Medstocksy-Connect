/**
 * Reminders bell API — list reminders due now/today, mark them sent or
 * cancelled. The actual WhatsApp send still goes through
 * `sendMessage()` in `messages.ts` (which respects rate limits + opt-out).
 */
import { supabase } from '@/lib/supabase';

export interface DueReminder {
  id: string;
  scheduled_for: string;
  status: string;
  variables: Record<string, string>;
  template_id: string;
  customer_id: string;
  customer: {
    id: string;
    name: string;
    phone: string;
    whatsapp_opted_in: boolean;
  } | null;
  template: {
    id: string;
    name: string;
    body: string;
    language: 'en' | 'hi';
  } | null;
}

/** List pending reminders whose scheduled_for is at most `withinHours` away
 *  (default: end of today). Includes joins to customer + template. */
export async function listDueReminders(
  pharmacyId: string,
  withinHours = 24
): Promise<DueReminder[]> {
  const cutoff = new Date(Date.now() + withinHours * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('crm_scheduled_reminders')
    .select(`
      id, scheduled_for, status, variables, template_id, customer_id,
      customer:crm_customers!inner(id, name, phone, whatsapp_opted_in),
      template:crm_templates!inner(id, name, body, language)
    `)
    .eq('pharmacy_id', pharmacyId)
    .eq('status', 'pending')
    .lte('scheduled_for', cutoff)
    .order('scheduled_for', { ascending: true })
    .limit(50);
  if (error) throw new Error(error.message);
  return ((data ?? []) as unknown) as DueReminder[];
}

/** Mark a reminder as sent after the WhatsApp call succeeds. */
export async function markReminderSent(reminderId: string, messageId?: string): Promise<void> {
  const { error } = await supabase
    .from('crm_scheduled_reminders')
    .update({
      status: 'sent',
      message_id: messageId ?? null,
      sent_at: new Date().toISOString(),
    } as never)
    .eq('id', reminderId);
  if (error) throw new Error(error.message);
}

/** Skip a pending reminder — sets status to cancelled. */
export async function cancelReminder(reminderId: string): Promise<void> {
  const { error } = await supabase
    .from('crm_scheduled_reminders')
    .update({ status: 'cancelled' } as never)
    .eq('id', reminderId);
  if (error) throw new Error(error.message);
}
