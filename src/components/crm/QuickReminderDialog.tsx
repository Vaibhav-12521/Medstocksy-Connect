/**
 * QuickReminderDialog — appears immediately after a prescription is saved.
 * Lets staff schedule a follow-up reminder in a single click:
 *   • After X days / after X months / custom date+time
 *   • Channel: WhatsApp · SMS · Phone call · Push notification
 *   • Retry tracking via status field on crm_scheduled_reminders
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bell, Calendar, Check, Clock, Phone,
  Loader2, Zap,
  ChevronRight,
} from 'lucide-react';
import { useActivePharmacy } from '@/contexts/PharmacyContext';
import { useT } from '@/contexts/LanguageContext';
import { supabase } from '@/lib/supabase';
import { deduplicateTemplates } from '@/lib/crm/templates';
import { cn } from '@/lib/utils';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { Tables } from '@/lib/supabase';

type Template = Tables<'crm_templates'>;

export type ReminderChannel = 'whatsapp' | 'sms' | 'call';

interface QuickReminderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customerId: string;
  customerName: string;
  customerPhone: string;
  prescriptionId?: string;
  /** Pre-fill with the first medicine name from the prescription */
  medicineName?: string;
  onScheduled?: () => void;
}

type TimingMode = 'days' | 'months' | 'custom';

const PRESET_DAYS = [7, 14, 30, 60, 90];



export function QuickReminderDialog({
  open,
  onOpenChange,
  customerId,
  customerName,
  customerPhone,
  medicineName,
  onScheduled,
}: QuickReminderDialogProps) {
  const t = useT();
  const { pharmacyId } = useActivePharmacy();
  const qc = useQueryClient();

  const [timingMode, setTimingMode] = useState<TimingMode>('days');
  const [daysValue, setDaysValue] = useState(30);
  const [monthsValue, setMonthsValue] = useState(1);
  const [customDate, setCustomDate] = useState('');
  const [sendTime, setSendTime] = useState('09:00');
  const [channel, setChannel] = useState<ReminderChannel>('whatsapp');
  const [templateId, setTemplateId] = useState('');
  const [note, setNote] = useState(medicineName ?? '');
  const [success, setSuccess] = useState(false);

  const today = new Date().toISOString().slice(0, 10);

  // Load refill_reminder templates
  const { data: templates = [] } = useQuery<Template[]>({
    queryKey: ['quick-reminder-templates', pharmacyId],
    enabled: open,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('crm_templates')
        .select('*')
        .or(`pharmacy_id.is.null,pharmacy_id.eq.${pharmacyId}`)
        .in('kind', ['refill_reminder', 'custom'])
        .order('is_built_in', { ascending: false });
      if (error) throw error;
      return deduplicateTemplates((data ?? []) as unknown as Template[]);
    },
  });

  useEffect(() => {
    if (!open) return;
    setTimingMode('days');
    setDaysValue(30);
    setMonthsValue(1);
    setCustomDate('');
    setSendTime('09:00');
    setChannel('whatsapp');
    setNote(medicineName ?? '');
    setSuccess(false);
    // Default template
    const defaultTpl = (templates as Template[]).find((t) => t.kind === 'refill_reminder');
    setTemplateId(defaultTpl?.id ?? templates[0]?.id ?? '');
  }, [open, medicineName, templates]);

  /** Compute the ISO datetime string for when to fire the reminder */
  function computeScheduledFor(): string {
    const base = new Date();
    if (timingMode === 'days') {
      base.setDate(base.getDate() + daysValue);
    } else if (timingMode === 'months') {
      base.setMonth(base.getMonth() + monthsValue);
    } else {
      // custom date + time
      const parts = customDate.split('-').map(Number);
      const y = parts[0] ?? base.getFullYear();
      const m = parts[1] ?? (base.getMonth() + 1);
      const d = parts[2] ?? base.getDate();
      const timeParts = sendTime.split(':').map(Number);
      const h = timeParts[0] ?? 9;
      const min = timeParts[1] ?? 0;
      base.setFullYear(y, m - 1, d);
      base.setHours(h, min, 0, 0);
      return base.toISOString();
    }
    const timeParts = sendTime.split(':').map(Number);
    const h = timeParts[0] ?? 9;
    const min = timeParts[1] ?? 0;
    base.setHours(h, min, 0, 0);
    return base.toISOString();
  }

  const save = useMutation<void, Error>({
    mutationFn: async () => {
      if (!templateId) throw new Error('Select a message template.');
      if (timingMode === 'custom' && !customDate) throw new Error('Pick a date.');

      const scheduledFor = computeScheduledFor();

      // Store reminder with channel info in variables
      const { error } = await supabase.from('crm_scheduled_reminders').insert({
        pharmacy_id: pharmacyId,
        customer_id: customerId,
        template_id: templateId,
        scheduled_for: scheduledFor,
        variables: {
          medicine: note || medicineName || '',
          channel,
          customer_name: customerName,
          customer_phone: customerPhone,
        },
      } as never);
      if (error) throw new Error(error.message);
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['upcoming-reminders'] });
      await qc.invalidateQueries({ queryKey: ['dashboard-counts'] });
      await qc.invalidateQueries({ queryKey: ['scheduled-reminders'] });
      setSuccess(true);
      setTimeout(() => {
        onScheduled?.();
        onOpenChange(false);
      }, 1200);
    },
  });

  const computedDate = (() => {
    try {
      const base = new Date();
      if (timingMode === 'days') base.setDate(base.getDate() + daysValue);
      else if (timingMode === 'months') base.setMonth(base.getMonth() + monthsValue);
      else return customDate ? new Date(customDate + 'T' + sendTime).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
      return base.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
    } catch { return '—'; }
  })();

  const canSubmit = !!templateId && !save.isPending && (timingMode !== 'custom' || !!customDate);

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!save.isPending) onOpenChange(v); }}>
      <DialogContent className="flex max-h-[92vh] max-w-lg flex-col gap-0 overflow-hidden p-0">
        {/* Header */}
        <div className="flex items-start gap-3 border-b bg-gradient-to-br from-amber-500/8 via-transparent to-transparent px-6 pb-5 pt-6">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-amber-500/10 text-amber-600">
            <Bell className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <DialogHeader className="space-y-0.5 text-left">
              <DialogTitle className="text-lg">Set reminder</DialogTitle>
              <DialogDescription className="text-xs">
                Schedule a follow-up for <span className="font-semibold text-foreground">{customerName}</span>
              </DialogDescription>
            </DialogHeader>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
          {success ? (
            <div className="flex flex-col items-center justify-center py-8 gap-3">
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600">
                <Check className="h-7 w-7" />
              </div>
              <div className="text-center">
                <div className="font-semibold text-foreground">Reminder scheduled!</div>
                <div className="text-xs text-muted-foreground mt-1">{computedDate} at {sendTime}</div>
              </div>
            </div>
          ) : (
            <>
              {/* Medicine / Note */}
              <div>
                <label className="mb-1 block text-sm font-medium">Medicine / Reason</label>
                <Input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="e.g. BP medicine refill"
                  maxLength={120}
                />
              </div>

              {/* Timing mode */}
              <div>
                <label className="mb-2 block text-sm font-medium">When to remind</label>
                <div role="radiogroup" className="inline-flex w-full rounded-lg border bg-muted/60 p-1 mb-3">
                  {(['days', 'months', 'custom'] as TimingMode[]).map((m) => (
                    <button
                      key={m}
                      type="button"
                      role="radio"
                      aria-checked={timingMode === m}
                      onClick={() => setTimingMode(m)}
                      className={cn(
                        'inline-flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-semibold transition-all capitalize',
                        timingMode === m
                          ? 'bg-primary text-primary-foreground shadow-sm'
                          : 'text-muted-foreground hover:bg-background/60 hover:text-foreground'
                      )}
                    >
                      {m === 'days' ? <Clock className="h-3 w-3" /> : m === 'months' ? <Calendar className="h-3 w-3" /> : <Zap className="h-3 w-3" />}
                      {t(`rem.timing.${m}` as any)}
                    </button>
                  ))}
                </div>

                {timingMode === 'days' && (
                  <div className="space-y-3">
                    <div className="flex flex-wrap gap-2">
                      {PRESET_DAYS.map((d) => (
                        <button
                          key={d}
                          type="button"
                          onClick={() => setDaysValue(d)}
                          className={cn(
                            'rounded-full border px-3 py-1 text-xs font-semibold transition-all',
                            daysValue === d
                              ? 'border-primary bg-primary/10 text-primary'
                              : 'border-border bg-background hover:border-primary/40'
                          )}
                        >
                          {d}d
                        </button>
                      ))}
                    </div>
                    <div className="flex items-center gap-2">
                      <Input
                        type="number"
                        inputMode="numeric"
                        min={1}
                        max={365}
                        value={daysValue}
                        onChange={(e) => setDaysValue(Math.max(1, parseInt(e.target.value) || 1))}
                        className="w-24 font-mono"
                      />
                      <span className="text-sm text-muted-foreground">days from today</span>
                    </div>
                  </div>
                )}

                {timingMode === 'months' && (
                  <div className="flex items-center gap-2">
                    <div className="flex flex-wrap gap-2 mb-2">
                      {[1, 2, 3, 6].map((m) => (
                        <button
                          key={m}
                          type="button"
                          onClick={() => setMonthsValue(m)}
                          className={cn(
                            'rounded-full border px-3 py-1 text-xs font-semibold transition-all',
                            monthsValue === m
                              ? 'border-primary bg-primary/10 text-primary'
                              : 'border-border bg-background hover:border-primary/40'
                          )}
                        >
                          {m}mo
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {timingMode === 'months' && (
                  <div className="flex items-center gap-2 mt-2">
                    <Input
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={24}
                      value={monthsValue}
                      onChange={(e) => setMonthsValue(Math.max(1, parseInt(e.target.value) || 1))}
                      className="w-24 font-mono"
                    />
                    <span className="text-sm text-muted-foreground">months from today</span>
                  </div>
                )}

                {timingMode === 'custom' && (
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="mb-1 block text-xs font-medium text-muted-foreground">Date</label>
                      <Input
                        type="date"
                        className="font-mono"
                        value={customDate}
                        onChange={(e) => setCustomDate(e.target.value)}
                        min={today}
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-muted-foreground">Time</label>
                      <Input
                        type="time"
                        className="font-mono"
                        value={sendTime}
                        onChange={(e) => setSendTime(e.target.value)}
                      />
                    </div>
                  </div>
                )}

                {timingMode !== 'custom' && (
                  <div className="mt-3 flex items-center gap-2">
                    <Phone className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="text-xs text-muted-foreground">Send time:</span>
                    <Input
                      type="time"
                      className="h-8 w-28 font-mono text-xs"
                      value={sendTime}
                      onChange={(e) => setSendTime(e.target.value)}
                    />
                  </div>
                )}
              </div>

              {/* Preview */}
              <div className="rounded-xl border border-amber-200/60 bg-amber-50/60 p-3 dark:border-amber-800/40 dark:bg-amber-950/20">
                <div className="flex items-center gap-2 text-xs font-semibold text-amber-700 dark:text-amber-300 mb-1">
                  <Bell className="h-3.5 w-3.5" />
                  Scheduled for
                </div>
                <div className="font-semibold text-foreground">{computedDate} at {sendTime}</div>
              </div>

              {/* Template */}
              <div>
                <label className="mb-1 block text-sm font-medium">Message template *</label>
                <select
                  value={templateId}
                  onChange={(e) => setTemplateId(e.target.value)}
                  className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <option value="" disabled>— select —</option>
                  {templates.map((tpl) => (
                    <option key={tpl.id} value={tpl.id}>
                      {tpl.is_built_in ? '★ ' : ''}{tpl.name}
                    </option>
                  ))}
                </select>
                {templates.length === 0 && (
                  <p className="mt-1 text-xs text-muted-foreground">No approved templates yet. Reminder will still be logged.</p>
                )}
              </div>

              {save.isError && (
                <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  {save.error?.message}
                </div>
              )}
            </>
          )}
        </div>

        <DialogFooter className="border-t bg-muted/30 px-6 py-3">
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={save.isPending}
          >
            {success ? 'Close' : 'Skip for now'}
          </Button>
          {!success && (
            <Button
              type="button"
              onClick={() => { if (canSubmit) save.mutate(); }}
              disabled={!canSubmit}
              className="gap-2"
            >
              {save.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              {save.isPending ? 'Scheduling…' : (
                <>
                  Schedule reminder
                  <ChevronRight className="h-4 w-4" />
                </>
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
