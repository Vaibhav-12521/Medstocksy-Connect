/**
 * Proactive top-5 reminders popup. Auto-opens once per day on app load when
 * there's at least one reminder due, prompting staff to send right away.
 * Dismissal is per-session-per-day (sessionStorage); the bell is always
 * available afterwards for the same actions.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import {
  BellRing, Loader2, Send, X as XIcon, Clock, BellOff, ChevronRight,
} from 'lucide-react';
import { useActivePharmacy, usePharmacy } from '@/contexts/PharmacyContext';
import { useT } from '@/contexts/LanguageContext';
import {
  listDueReminders, markReminderSent, cancelReminder, type DueReminder,
} from '@/lib/api/reminders';
import { canSendNow, openWhatsAppCompose, logManualSend } from '@/lib/api/messages';
import { cn, initials, renderTemplate } from '@/lib/utils';

const TOP_N = 5;

function dismissKey(): string {
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `medcrm.today_popup_dismissed.${stamp}`;
}

export function TodayRemindersPopup() {
  const { activePharmacyId } = usePharmacy();
  if (!activePharmacyId) return null;
  return <TodayRemindersPopupInner />;
}

function TodayRemindersPopupInner() {
  const t = useT();
  const { pharmacyId } = useActivePharmacy();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [queue, setQueue] = useState<DueReminder[] | null>(null);

  const { data: reminders = [], isLoading } = useQuery<DueReminder[]>({
    queryKey: ['due-reminders', pharmacyId],
    queryFn: () => listDueReminders(pharmacyId, 24),
    enabled: !!pharmacyId,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const { data: canSend } = useQuery({
    queryKey: ['can-send-now', pharmacyId],
    queryFn: () => canSendNow(pharmacyId),
    enabled: !!pharmacyId,
    staleTime: 30_000,
  });

  // Auto-open once per day per session, only if there ARE reminders pending.
  useEffect(() => {
    if (isLoading) return;
    if (reminders.length === 0) return;
    const dismissed = sessionStorage.getItem(dismissKey()) === '1';
    if (dismissed) return;
    setOpen(true);
  }, [isLoading, reminders.length]);

  const close = (markDismissed = true) => {
    if (markDismissed) sessionStorage.setItem(dismissKey(), '1');
    setOpen(false);
    setQueue(null);
  };

  const send = useMutation<void, Error, DueReminder>({
    mutationFn: async (r) => {
      if (!r.template || !r.customer) throw new Error('Reminder missing template or customer.');
      if (!r.customer.whatsapp_opted_in) throw new Error('Customer is opted out of WhatsApp.');

      const variables: Record<string, string> = {};
      Object.entries(r.variables || {}).forEach(([k, v]) => { variables[k] = String(v); });
      const body = renderTemplate(r.template.body, variables);

      const opened = openWhatsAppCompose({ phone: r.customer.phone, body });
      if (!opened) throw new Error('Popup blocked. Allow popups for this site and try again.');

      const { messageId } = await logManualSend({
        pharmacyId,
        customerId: r.customer.id,
        phone: r.customer.phone,
        body,
        templateId: r.template.id,
      });

      await markReminderSent(r.id, messageId);
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['due-reminders', pharmacyId] });
      await qc.invalidateQueries({ queryKey: ['whatsapp-health', pharmacyId] });
      await qc.invalidateQueries({ queryKey: ['dashboard-counts', pharmacyId] });
    },
  });

  const skip = useMutation<void, Error, DueReminder>({
    mutationFn: (r) => cancelReminder(r.id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['due-reminders', pharmacyId] });
      await qc.invalidateQueries({ queryKey: ['dashboard-counts', pharmacyId] });
    },
  });

  // Pre-slice once so render + queue logic agree on the same 5 rows.
  const top = reminders.slice(0, TOP_N);
  const overflow = Math.max(0, reminders.length - TOP_N);

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            onClick={() => close()}
            className="fixed inset-0 z-50 bg-foreground/30 backdrop-blur-[2px]"
          />

          {/* Card */}
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-labelledby="today-popup-title"
            initial={{ opacity: 0, y: 10, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.97 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            className="fixed left-1/2 top-[10vh] z-50 w-[calc(100vw-2rem)] max-w-[460px] -translate-x-1/2 overflow-hidden rounded-2xl border bg-card shadow-modal"
          >
            {/* Header */}
            <div className="relative flex items-start gap-3 border-b bg-gradient-to-br from-primary/10 via-transparent to-transparent px-5 py-4">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
                <BellRing className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <h2 id="today-popup-title" className="text-base font-bold tracking-tight">
                  {t('popup.title')}
                </h2>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {t('popup.subtitle')
                    .replace('{n}', String(top.length))
                    .replace('{extra}', overflow > 0 ? t('popup.plus_more').replace('{n}', String(overflow)) : '')}
                </p>
              </div>
              <button
                type="button"
                onClick={() => close()}
                aria-label={t('popup.close')}
                className="rounded-md p-1 text-muted-foreground hover:bg-muted/40 hover:text-foreground"
              >
                <XIcon className="h-4 w-4" />
              </button>
            </div>

            {/* Body */}
            <div className="max-h-[60vh] overflow-y-auto">
              {top.length === 0 ? (
                <div className="px-5 py-8 text-center text-sm text-muted-foreground">
                  {t('popup.empty')}
                </div>
              ) : (
                <ul className="divide-y">
                  {top.map((r) => (
                    <PopupRow
                      key={r.id}
                      reminder={r}
                      onSend={() => send.mutate(r)}
                      onSkip={() => skip.mutate(r)}
                      sending={send.isPending && send.variables?.id === r.id}
                      skipping={skip.isPending && skip.variables?.id === r.id}
                      canSend={canSend !== false}
                    />
                  ))}
                </ul>
              )}
            </div>

            {/* Queue progress (in-card) */}
            {queue && queue.length > 0 && (
              <div className="border-t bg-primary/5 px-5 py-3">
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-primary">
                  {t('bell.queue_status').replace('{n}', String(queue.length))}
                </div>
                <div className="mb-2 text-xs">
                  {send.isPending
                    ? t('bell.queue_opening').replace('{name}', queue[0]?.customer?.name ?? '—')
                    : t('bell.queue_waiting').replace('{name}', queue[0]?.customer?.name ?? '—')}
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      const remaining = queue.slice(1);
                      const next = remaining[0];
                      if (!next) {
                        setQueue(null);
                      } else {
                        setQueue(remaining);
                        send.mutate(next);
                      }
                    }}
                    disabled={send.isPending}
                    className="flex-1 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-60"
                  >
                    {queue.length === 1 ? t('bell.queue_done') : t('bell.queue_next')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setQueue(null)}
                    disabled={send.isPending}
                    className="rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted/40 disabled:opacity-60"
                  >
                    {t('bell.queue_stop')}
                  </button>
                </div>
              </div>
            )}

            {/* Footer actions — only when no queue is in flight */}
            {!queue && top.length > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-2 border-t bg-muted/30 px-5 py-3">
                <Link
                  to="/reminders"
                  onClick={() => close(false)}
                  className="inline-flex items-center gap-0.5 text-xs font-medium text-primary hover:underline"
                >
                  {t('bell.view_all')} <ChevronRight className="h-3 w-3" />
                </Link>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => close()}
                    className="rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted/40"
                  >
                    {t('popup.dismiss')}
                  </button>
                  {top.length > 1 && canSend !== false && (
                    <button
                      type="button"
                      onClick={() => {
                        const eligible = top.filter((r) => r.customer?.whatsapp_opted_in !== false);
                        const first = eligible[0];
                        if (!first) return;
                        setQueue(eligible);
                        send.mutate(first);
                      }}
                      disabled={send.isPending}
                      className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-60"
                    >
                      {t('bell.start_queue').replace('{n}', String(
                        top.filter((r) => r.customer?.whatsapp_opted_in !== false).length
                      ))}
                    </button>
                  )}
                </div>
              </div>
            )}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

// ─── Row ───────────────────────────────────────────────────────────────────

function PopupRow({
  reminder, onSend, onSkip, sending, skipping, canSend,
}: {
  reminder: DueReminder;
  onSend: () => void;
  onSkip: () => void;
  sending: boolean;
  skipping: boolean;
  canSend: boolean;
}) {
  const t = useT();
  const optedOut = reminder.customer?.whatsapp_opted_in === false;
  const overdue = new Date(reminder.scheduled_for) < new Date();
  const time = new Date(reminder.scheduled_for).toLocaleString('en-IN', {
    hour: 'numeric', minute: '2-digit', day: 'numeric', month: 'short',
  });

  return (
    <li className="px-5 py-3">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">
          {reminder.customer ? initials(reminder.customer.name) : '?'}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <Link
              to={`/customers/${reminder.customer?.id}`}
              className="truncate text-sm font-semibold hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {reminder.customer?.name ?? t('bell.unknown_customer')}
            </Link>
            <span className={cn(
              'inline-flex items-center gap-1 rounded-md px-1.5 py-px text-[10px] font-mono',
              overdue ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground'
            )}>
              <Clock className="h-2.5 w-2.5" />
              {time}
            </span>
          </div>
          <p
            lang={reminder.template?.language ?? 'en'}
            className={cn(
              'mt-0.5 line-clamp-2 text-[12px] text-muted-foreground',
              reminder.template?.language === 'hi' && 'font-["Noto_Sans_Devanagari",Inter,system-ui]'
            )}
          >
            {reminder.template ? renderTemplate(reminder.template.body, reminder.variables || {}) : ''}
          </p>

          {optedOut && (
            <div className="mt-1.5 inline-flex items-center gap-1 rounded-md bg-destructive/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-destructive">
              <BellOff className="h-2.5 w-2.5" />
              {t('bell.opted_out')}
            </div>
          )}

          <div className="mt-2 flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={onSend}
              disabled={sending || skipping || optedOut || !canSend}
              className="inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-[11px] font-semibold text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {sending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
              {sending ? t('bell.sending') : t('bell.send')}
            </button>
            <button
              type="button"
              onClick={onSkip}
              disabled={sending || skipping}
              className="inline-flex items-center gap-1 rounded-md border border-input bg-background px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-muted/40 disabled:opacity-50"
            >
              {skipping ? <Loader2 className="h-3 w-3 animate-spin" /> : <XIcon className="h-3 w-3" />}
              {skipping ? '…' : t('bell.skip')}
            </button>
          </div>
        </div>
      </div>
    </li>
  );
}

