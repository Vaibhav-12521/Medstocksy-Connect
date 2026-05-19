/**
 * Fixed-position reminders bell + dropdown panel.
 * Surfaces today's pending WhatsApp reminders with one-click Send / Skip,
 * while respecting the rate-limit + send-window + opt-out safety gates.
 */
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Bell, Loader2, Send, X as XIcon, AlertCircle, Clock, ChevronRight, BellOff,
} from 'lucide-react';
import { useActivePharmacy, usePharmacy } from '@/contexts/PharmacyContext';
import { useT } from '@/contexts/LanguageContext';
import {
  listDueReminders, markReminderSent, cancelReminder, type DueReminder,
} from '@/lib/api/reminders';
import { canSendNow, openWhatsAppCompose, logManualSend } from '@/lib/api/messages';
import { cn, initials, renderTemplate } from '@/lib/utils';

export function RemindersBell() {
  const { activePharmacyId } = usePharmacy();
  // Don't render anything until a pharmacy is active — the bell would have
  // nothing to query against and we don't want a flicker on every route.
  if (!activePharmacyId) return null;
  return <RemindersBellInner />;
}

function RemindersBellInner() {
  const t = useT();
  const { pharmacyId } = useActivePharmacy();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [queue, setQueue] = useState<DueReminder[] | null>(null);  // null = no batch in progress
  const panelRef = useRef<HTMLDivElement>(null);

  // Close on outside click + escape
  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleEsc);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleEsc);
    };
  }, [open]);

  const { data: reminders = [], isLoading } = useQuery<DueReminder[]>({
    queryKey: ['due-reminders', pharmacyId],
    queryFn: () => listDueReminders(pharmacyId, 24),
    enabled: !!pharmacyId,
    // Refresh every 60s so the bell catches reminders that became due while
    // the user is on another tab. Same cadence as the WhatsApp-health check.
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const { data: canSend } = useQuery({
    queryKey: ['can-send-now', pharmacyId],
    queryFn: () => canSendNow(pharmacyId),
    enabled: !!pharmacyId,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const send = useMutation<void, Error, DueReminder>({
    mutationFn: async (r) => {
      if (!r.template || !r.customer) throw new Error('Reminder missing template or customer.');
      if (!r.customer.whatsapp_opted_in) throw new Error('Customer is opted out of WhatsApp.');

      // 1. Render the body locally with variables.
      const variables: Record<string, string> = {};
      Object.entries(r.variables || {}).forEach(([k, v]) => { variables[k] = String(v); });
      const body = renderTemplate(r.template.body, variables);

      // 2. Open WhatsApp in the persistent tab (reused across the batch).
      const opened = openWhatsAppCompose({ phone: r.customer.phone, body });
      if (!opened) throw new Error('Popup blocked. Allow popups for this site and try again.');

      // 3. Audit-log the manual send + bump the rate counter.
      const { messageId } = await logManualSend({
        pharmacyId,
        customerId: r.customer.id,
        phone: r.customer.phone,
        body,
        templateId: r.template.id,
      });

      // 4. Mark the reminder as sent (optimistic — assumes staff hit Send in WA).
      await markReminderSent(r.id, messageId);
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['due-reminders', pharmacyId] });
      await qc.invalidateQueries({ queryKey: ['whatsapp-health', pharmacyId] });
      await qc.invalidateQueries({ queryKey: ['dashboard-counts', pharmacyId] });
    },
  });

  const skip = useMutation<void, Error, DueReminder>({
    mutationFn: async (r) => cancelReminder(r.id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['due-reminders', pharmacyId] });
      await qc.invalidateQueries({ queryKey: ['dashboard-counts', pharmacyId] });
    },
  });

  const count = reminders.length;
  const hasOverdue = reminders.some((r) => new Date(r.scheduled_for) < new Date());

  return (
    <div className="fixed right-4 top-4 z-30 md:right-6 md:top-6">
      <button
        type="button"
        aria-label={t('bell.aria_label')}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'relative flex h-10 w-10 items-center justify-center rounded-full border bg-card shadow-md transition-all',
          'hover:border-primary/40 hover:shadow-popover',
          open && 'border-primary/50 ring-2 ring-primary/20'
        )}
      >
        <Bell className={cn('h-4 w-4', count > 0 ? 'text-primary' : 'text-muted-foreground')} />
        {count > 0 && (
          <span
            className={cn(
              'absolute -right-0.5 -top-0.5 flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[10px] font-bold text-primary-foreground ring-2 ring-background',
              hasOverdue ? 'bg-destructive animate-pulse' : 'bg-primary'
            )}
          >
            {count > 99 ? '99+' : count}
          </span>
        )}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            ref={panelRef}
            initial={{ opacity: 0, y: -8, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.97 }}
            transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1] }}
            className="absolute right-0 top-12 w-[calc(100vw-2rem)] max-w-[400px] overflow-hidden rounded-xl border bg-card shadow-modal"
          >
            {/* Header */}
            <div className="flex items-center justify-between border-b bg-gradient-to-br from-primary/8 via-transparent to-transparent px-4 py-3">
              <div>
                <div className="flex items-center gap-1.5 text-sm font-semibold">
                  <Bell className="h-3.5 w-3.5 text-primary" />
                  {t('bell.heading')}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  {count === 0
                    ? t('bell.subtitle_empty')
                    : t('bell.subtitle_count').replace('{n}', String(count))}
                </div>
              </div>
              <Link
                to="/reminders"
                onClick={() => setOpen(false)}
                className="inline-flex items-center gap-0.5 text-xs font-medium text-primary hover:underline"
              >
                {t('bell.view_all')}
                <ChevronRight className="h-3 w-3" />
              </Link>
            </div>

            {/* Rate-limit / window banner */}
            {canSend === false && count > 0 && (
              <div className="flex items-start gap-1.5 border-b bg-amber-500/10 px-4 py-2 text-[11px] text-amber-800 dark:text-amber-300">
                <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
                <span>{t('bell.cant_send_now')}</span>
              </div>
            )}

            {/* Body */}
            <div className="max-h-[60vh] overflow-y-auto">
              {isLoading ? (
                <div className="space-y-2 p-3">
                  {[1, 2, 3].map((i) => (
                    <div key={i} className="h-16 animate-pulse rounded-md bg-muted/40" />
                  ))}
                </div>
              ) : reminders.length === 0 ? (
                <EmptyState />
              ) : (
                <ul className="divide-y">
                  {reminders.map((r) => (
                    <ReminderRow
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

            {/* Footer — start-queue button */}
            {reminders.length > 1 && canSend !== false && !queue && (
              <div className="border-t bg-muted/30 px-4 py-2">
                <button
                  type="button"
                  onClick={() => {
                    const eligible = reminders.filter((r) => r.customer?.whatsapp_opted_in !== false);
                    if (eligible.length === 0) return;
                    // First send fires immediately on the user's gesture (popup
                    // blockers allow it). After this, the same WhatsApp tab gets
                    // navigated on each subsequent click — no fresh popup needed.
                    setQueue(eligible);
                    send.mutate(eligible[0]);
                  }}
                  disabled={send.isPending}
                  className="w-full rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-60"
                >
                  {t('bell.start_queue').replace('{n}', String(
                    reminders.filter((r) => r.customer?.whatsapp_opted_in !== false).length
                  ))}
                </button>
              </div>
            )}

            {/* Queue progress panel — shown while a batch is in flight */}
            {queue && (
              <QueueProgress
                queue={queue}
                onNext={() => {
                  const remaining = queue.slice(1);
                  if (remaining.length === 0) {
                    setQueue(null);
                  } else {
                    setQueue(remaining);
                    send.mutate(remaining[0]);
                  }
                }}
                onStop={() => setQueue(null)}
                sending={send.isPending}
              />
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function ReminderRow({
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

  // Render the template body locally for the preview line.
  const preview = reminder.template
    ? renderTemplate(reminder.template.body, reminder.variables || {})
    : '';

  return (
    <li className="px-4 py-3">
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
            <span
              className={cn(
                'inline-flex items-center gap-1 rounded-md px-1.5 py-px text-[10px] font-mono',
                overdue ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground'
              )}
            >
              <Clock className="h-2.5 w-2.5" />
              {time}
            </span>
            {reminder.template?.name && (
              <span className="rounded bg-muted px-1.5 py-px text-[10px] font-mono text-muted-foreground">
                {reminder.template.name}
              </span>
            )}
          </div>
          <p
            lang={reminder.template?.language ?? 'en'}
            className={cn(
              'mt-1 line-clamp-2 text-[12px] text-muted-foreground',
              reminder.template?.language === 'hi' && 'font-["Noto_Sans_Devanagari",Inter,system-ui]'
            )}
          >
            {preview}
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
              title={
                optedOut ? t('bell.tooltip_optout')
                : !canSend ? t('bell.tooltip_rate_limited')
                : ''
              }
              className={cn(
                'inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-[11px] font-semibold text-primary-foreground transition-opacity',
                'hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50'
              )}
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

function QueueProgress({
  queue, onNext, onStop, sending,
}: {
  queue: DueReminder[];
  onNext: () => void;
  onStop: () => void;
  sending: boolean;
}) {
  const t = useT();
  const current = queue[0];
  const total = queue.length;
  if (!current) return null;
  return (
    <div className="border-t bg-primary/5 px-4 py-3">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-primary">
        {t('bell.queue_status').replace('{n}', String(total))}
      </div>
      <div className="mb-2 text-xs text-foreground/90">
        {sending
          ? t('bell.queue_opening').replace('{name}', current.customer?.name ?? '—')
          : t('bell.queue_waiting').replace('{name}', current.customer?.name ?? '—')}
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onNext}
          disabled={sending}
          className="flex-1 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-60"
        >
          {total === 1 ? t('bell.queue_done') : t('bell.queue_next')}
        </button>
        <button
          type="button"
          onClick={onStop}
          disabled={sending}
          className="rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted/40 disabled:opacity-60"
        >
          {t('bell.queue_stop')}
        </button>
      </div>
    </div>
  );
}

function EmptyState() {
  const t = useT();
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-4 py-10 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
        <Bell className="h-5 w-5 text-muted-foreground" />
      </div>
      <div className="text-sm font-semibold">{t('bell.empty_title')}</div>
      <p className="max-w-xs text-[11px] text-muted-foreground">{t('bell.empty_hint')}</p>
    </div>
  );
}
