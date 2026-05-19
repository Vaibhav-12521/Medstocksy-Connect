import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { X, Send, Calendar } from 'lucide-react';
import { supabase, type Tables } from '@/lib/supabase';
import { useActivePharmacy } from '@/contexts/PharmacyContext';
import { useT } from '@/contexts/LanguageContext';
import { getWhatsAppHealth, openWhatsAppCompose, logManualSend } from '@/lib/api/messages';
import { renderTemplate, cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { RateMeter } from './RateMeter';
import { deduplicateTemplates } from '@/lib/crm/templates';

interface ComposeDrawerProps {
  open: boolean;
  onClose: () => void;
  customer: { id: string; name: string; phone: string; whatsapp_opted_in: boolean };
}

/**
 * Highest-stakes UI in the app. Constraints (rate limit, opt-out, send window)
 * are baked into the layout per theme §5.7 — visible at rest, not on error.
 */
export function ComposeDrawer({ open, onClose, customer }: ComposeDrawerProps) {
  const t = useT();
  const { pharmacyId } = useActivePharmacy();
  const qc = useQueryClient();
  const [templateId, setTemplateId] = useState<string>('');
  const [variables, setVariables] = useState<Record<string, string>>({ name: customer.name });

  type Template = Tables<'crm_templates'>;
  const { data: templates = [] } = useQuery<Template[]>({
    queryKey: ['templates', pharmacyId],
    enabled: open,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('crm_templates')
        .select('*')
        .or(`pharmacy_id.is.null,pharmacy_id.eq.${pharmacyId}`)
        .eq('whatsapp_status', 'approved')
        .order('is_built_in', { ascending: false });
      if (error) throw error;
      return deduplicateTemplates((data ?? []) as unknown as Template[]);
    },
  });

  // Auto-fetch pharmacy info (name + phone)
  const { data: pharmacyInfo } = useQuery({
    queryKey: ['pharmacy-info', pharmacyId],
    enabled: open,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('crm_pharmacies')
        .select('name, phone')
        .eq('id', pharmacyId)
        .single();
      if (error) throw error;
      return data as { name: string; phone: string | null };
    },
  });

  // Auto-fetch latest prescription medicines for this customer
  const { data: latestMedicines } = useQuery({
    queryKey: ['latest-rx-medicines', customer.id],
    enabled: open,
    queryFn: async () => {
      const { data: rxData, error: rxErr } = await supabase
        .from('crm_prescriptions')
        .select('id')
        .eq('pharmacy_id', pharmacyId)
        .eq('customer_id', customer.id)
        .order('prescription_date', { ascending: false })
        .limit(1)
        .single();
      if (rxErr || !rxData) return null;
      const { data: meds, error: medErr } = await supabase
        .from('crm_prescription_medicines')
        .select('medicine_name')
        .eq('prescription_id', rxData.id)
        .order('position');
      if (medErr) return null;
      return (meds ?? []).map((m: { medicine_name: string }) => m.medicine_name);
    },
  });

  // Seed variables whenever pharmacy / prescription data loads
  useEffect(() => {
    if (!open) return;
    setVariables((prev) => ({
      ...prev,
      name: customer.name,
      ...(pharmacyInfo?.name ? { pharmacy_name: pharmacyInfo.name } : {}),
      ...(pharmacyInfo?.phone ? { pharmacy_phone: pharmacyInfo.phone } : {}),
      ...(latestMedicines?.length ? { medicine: latestMedicines.join(', ') } : {}),
    }));
  }, [open, customer.name, pharmacyInfo, latestMedicines]);

  const { data: health } = useQuery({
    queryKey: ['whatsapp-health', pharmacyId],
    enabled: open,
    queryFn: () => getWhatsAppHealth(pharmacyId),
    refetchInterval: 30_000,
  });

  const template = templates.find((t) => t.id === templateId) ?? templates[0];
  const renderedBody = template ? renderTemplate(template.body, variables) : '';
  const fullMessage = (template?.image_url) 
    ? `${renderedBody}\n\n${template.image_url}`
    : renderedBody;

  const sendMut = useMutation({
    mutationFn: async () => {
      if (!template) throw new Error('Pick a template first');
      if (!customer.whatsapp_opted_in) throw new Error('Customer is opted out of WhatsApp.');

      // 1. Open WhatsApp Web (desktop) or the WA app (mobile) in the reused
      //    medcrm tab, with the message + image link pre-filled.
      const opened = openWhatsAppCompose({
        phone: customer.phone,
        body: renderedBody,
        imageUrl: template.image_url,
      });
      if (!opened) throw new Error('Popup blocked. Allow popups for this site and try again.');

      // 2. Audit-log the manual send + bump the rate-limit window.
      await logManualSend({
        pharmacyId,
        customerId: customer.id,
        phone: customer.phone,
        body: fullMessage,
        templateId: template.id,
      });
      return true;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['messages'] });
      qc.invalidateQueries({ queryKey: ['whatsapp-health'] });
      qc.invalidateQueries({ queryKey: ['customer-activity', customer.id] });
      qc.invalidateQueries({ queryKey: ['customer', customer.id] });
      onClose();
    },
  });

  const optedOut = !customer.whatsapp_opted_in;
  const sendsLastHour = health?.sends_last_hour ?? 0;
  const cap = health?.rate_limit_per_hour ?? 10;
  const rateOk = true; // Rate limits don't apply to manual WhatsApp Web sends
  const canSend = !optedOut && !!template && !sendMut.isPending;

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.button
            aria-label="Close"
            onClick={onClose}
            className="fixed inset-0 z-40 bg-foreground/40 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
          />
          <motion.aside
            role="dialog"
            aria-modal="true"
            aria-label="New WhatsApp message"
            className="fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l bg-background shadow-modal sm:w-[560px]"
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
          >
            {/* Header */}
            <div className="flex items-center justify-between border-b px-6 py-4">
              <div>
                <div className="text-base font-semibold">{t('compose.new')}</div>
                <div className="text-xs text-muted-foreground">{t('compose.via')}</div>
              </div>
              <Button variant="ghost" size="icon" onClick={onClose} aria-label={t('btn.cancel')}>
                <X className="h-4 w-4" />
              </Button>
            </div>

            {/* Body */}
            <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
              {/* Recipient */}
              <div>
                <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {t('compose.recipient')}
                </label>
                <div className="flex items-center gap-3 rounded-lg bg-muted/40 p-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-tag-high-bg text-sm font-semibold text-tag-high-fg">
                    {customer.name.split(' ').slice(0, 2).map((s) => s[0]).join('')}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{customer.name}</div>
                    <div className="font-mono text-xs text-muted-foreground">{customer.phone}</div>
                  </div>
                  {optedOut ? (
                    <span className="rounded-full bg-tag-optout-bg px-2 py-0.5 text-xs font-bold uppercase text-tag-optout-fg">{t('compose.opted_out')}</span>
                  ) : (
                    <span className="rounded-full bg-tag-repeat-bg px-2 py-0.5 text-xs font-bold uppercase text-tag-repeat-fg">{t('compose.opted_in')}</span>
                  )}
                </div>
              </div>

              {/* Template */}
              <div>
                <label className="mb-1.5 block text-sm font-medium">{t('compose.template')}</label>
                <select
                  value={templateId || (template?.id ?? '')}
                  onChange={(e) => setTemplateId(e.target.value)}
                  className="h-11 w-full rounded-md border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <option value="">{t('compose.template_pick')}</option>
                  {templates.map((tpl) => (
                    <option key={tpl.id} value={tpl.id}>
                      {tpl.name}
                    </option>
                  ))}
                </select>
                <p className="mt-1.5 text-xs text-muted-foreground">{t('compose.template_hint')}</p>
              </div>

              {/* Variables */}
              {template && template.variables.length > 0 && (
                <div className="grid grid-cols-2 gap-3">
                  {template.variables.map((v) => (
                    <div key={v}>
                      <label className="mb-1.5 block text-xs font-medium capitalize">{v}</label>
                      <Input
                        value={variables[v] ?? ''}
                        onChange={(e) => setVariables((p) => ({ ...p, [v]: e.target.value }))}
                        placeholder={`{${v}}`}
                      />
                    </div>
                  ))}
                </div>
              )}

              {/* Preview */}
              {fullMessage && (
                <div>
                  <label className="mb-1.5 block text-sm font-medium">{t('compose.preview')}</label>
                  <motion.div
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="rounded-2xl border-l-4 border-emerald-400 bg-emerald-50 p-4 text-sm leading-relaxed dark:bg-emerald-950/30"
                  >
                    {template?.image_url && (
                      <img 
                        src={template.image_url} 
                        alt="" 
                        className="mb-3 aspect-video w-full rounded-lg border object-cover" 
                      />
                    )}
                    <div className="whitespace-pre-wrap">{renderedBody}</div>
                  </motion.div>
                </div>
              )}

              {sendMut.isError && (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                  {sendMut.error instanceof Error ? sendMut.error.message : 'Send failed.'}
                </div>
              )}
            </div>

            {/* Sticky safety footer */}
            <div className="space-y-3 border-t bg-muted/40 px-6 py-4">
              <RateMeter
                current={sendsLastHour}
                cap={cap}
                windowOk={true}
                windowStart={health?.send_window_start}
                windowEnd={health?.send_window_end}
              />
              <div className="flex gap-2">
                <Button variant="outline" className="flex-1" disabled={sendMut.isPending}>
                  <Calendar className="h-4 w-4" />
                  {t('btn.schedule')}
                </Button>
                <Button
                  className={cn('flex-1', !canSend && 'opacity-50')}
                  disabled={!canSend}
                  onClick={() => sendMut.mutate()}
                >
                  <Send className="h-4 w-4" />
                  {sendMut.isPending ? t('btn.sending') : t('btn.send_now')}
                </Button>
              </div>
              {optedOut && (
                <p className="text-xs text-destructive">{t('compose.optout_blocked')}</p>
              )}
              {!rateOk && (
                <p className="text-xs text-destructive">{t('compose.rate_blocked')}</p>
              )}
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}
