/**
 * Campaign send flow. Resolves the segment's opted-in customers, then dispatches
 * the chosen template to each — automatically via the openWA bot if it's online,
 * otherwise through the manual wa.me/ click-to-chat queue (one at a time).
 * Writes crm_messages + crm_campaign_recipients rows and finalizes the campaign.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Loader2, Megaphone, Send, Bot, Hand, CheckCircle2, AlertCircle, Users,
} from 'lucide-react';
import { useActivePharmacy } from '@/contexts/PharmacyContext';
import { useT } from '@/contexts/LanguageContext';
import { supabase, type Tables } from '@/lib/supabase';
import {
  resolveSegmentCustomers, markCampaignSending, recordCampaignRecipient,
  finalizeCampaign, type CampaignRecipient,
} from '@/lib/api/campaigns';
import {
  isBotConfigured, getBotStatus, sendViaBot, openWhatsAppCompose, logManualSend, canSendNow,
} from '@/lib/api/messages';
import { renderTemplate, cn } from '@/lib/utils';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

type Campaign = Tables<'crm_campaigns'>;
type Template = Tables<'crm_templates'>;

interface CampaignSendDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  campaign: Campaign | null;
}

type Phase = 'idle' | 'sending' | 'done';

const SAMPLE_VARS = {
  pharmacy_name: 'Your pharmacy', amount: '₹2,150', medicine: 'your medicine',
  category: 'vitamins', discount: '20', date: 'soon', pharmacy_phone: '',
};

export function CampaignSendDialog({ open, onOpenChange, campaign }: CampaignSendDialogProps) {
  const t = useT();
  const { pharmacyId } = useActivePharmacy();
  const qc = useQueryClient();

  const [phase, setPhase] = useState<Phase>('idle');
  const [index, setIndex] = useState(0);   // current recipient pointer
  const [sentCount, setSentCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef(false);

  // Resolve template + recipients when the dialog opens.
  const { data: template } = useQuery<Template | null>({
    queryKey: ['campaign-send-template', campaign?.template_id],
    enabled: open && !!campaign,
    queryFn: async () => {
      const { data, error: e } = await supabase
        .from('crm_templates').select('*').eq('id', campaign!.template_id).maybeSingle();
      if (e) throw e;
      return (data as unknown as Template | null) ?? null;
    },
  });

  const { data: recipients = [], isLoading: loadingRecipients } = useQuery<CampaignRecipient[]>({
    queryKey: ['campaign-send-recipients', campaign?.id, campaign?.segment_key],
    enabled: open && !!campaign,
    queryFn: () => resolveSegmentCustomers(pharmacyId, campaign!.segment_key),
  });

  const { data: botStatus } = useQuery({
    queryKey: ['bot-status-campaign'],
    enabled: open && isBotConfigured(),
    queryFn: () => getBotStatus(),
    staleTime: 10_000,
  });
  const botReady = isBotConfigured() && botStatus?.ready === true;

  // Reset transient state when (re)opening.
  useEffect(() => {
    if (!open) return;
    setPhase('idle'); setIndex(0); setSentCount(0); setError(null);
    cancelRef.current = false;
  }, [open, campaign?.id]);

  const renderBody = (r: CampaignRecipient): string =>
    template ? renderTemplate(template.body, { name: r.name, ...SAMPLE_VARS }) : '';

  // ── Send one recipient ──────────────────────────────────────────────────
  const sendOne = async (r: CampaignRecipient): Promise<boolean> => {
    if (!campaign || !template) return false;
    const body = renderBody(r);
    let messageId: string | undefined;
    try {
      if (botReady) {
        const res = await sendViaBot({ phone: r.phone, body, imageUrl: template.image_url });
        messageId = res.messageId;
      } else {
        const opened = openWhatsAppCompose({ phone: r.phone, body, imageUrl: template.image_url });
        if (!opened) throw new Error('Popup blocked.');
      }
      const logged = await logManualSend({
        pharmacyId, customerId: r.id, phone: r.phone, body,
        templateId: template.id, campaignId: campaign.id,
      });
      await recordCampaignRecipient({ campaignId: campaign.id, customerId: r.id, messageId: messageId ?? logged.messageId });
      return true;
    } catch (e) {
      console.error('[campaign send]', e);
      return false;
    }
  };

  // ── Bot mode: auto-fire all with a small delay ─────────────────────────────
  const runBotBatch = async () => {
    if (!campaign) return;
    setPhase('sending'); setError(null); cancelRef.current = false;
    await markCampaignSending(campaign.id, recipients.length).catch(() => {});
    let sent = 0;
    for (let i = 0; i < recipients.length; i++) {
      if (cancelRef.current) break;
      setIndex(i);
      const r = recipients[i];
      if (!r) continue;
      const ok = await sendOne(r);
      if (ok) { sent += 1; setSentCount(sent); }
      // Small human-pacing delay between bot sends (Rule 9 safety).
      await new Promise((res) => setTimeout(res, 1500));
    }
    await finalizeCampaign({ campaignId: campaign.id, sentCount: sent, totalRecipients: recipients.length });
    await qc.invalidateQueries({ queryKey: ['campaigns'] });
    await qc.invalidateQueries({ queryKey: ['whatsapp-health', pharmacyId] });
    setPhase('done');
  };

  // ── Manual mode: queue one at a time ───────────────────────────────────────
  const startManual = async () => {
    if (!campaign) return;
    setPhase('sending'); setError(null);
    await markCampaignSending(campaign.id, recipients.length).catch(() => {});
    const r = recipients[0];
    if (!r) return;
    const ok = await sendOne(r);
    if (ok) setSentCount(1);
    setIndex(0);
  };

  const manualNext = async () => {
    if (!campaign) return;
    const nextIdx = index + 1;
    if (nextIdx >= recipients.length) {
      await finalizeCampaign({ campaignId: campaign.id, sentCount, totalRecipients: recipients.length });
      await qc.invalidateQueries({ queryKey: ['campaigns'] });
      await qc.invalidateQueries({ queryKey: ['whatsapp-health', pharmacyId] });
      setPhase('done');
      return;
    }
    const r = recipients[nextIdx];
    if (!r) return;
    setIndex(nextIdx);
    const ok = await sendOne(r);
    if (ok) setSentCount((c) => c + 1);
  };

  const { data: canSend } = useQuery({
    queryKey: ['can-send-now', pharmacyId],
    queryFn: () => canSendNow(pharmacyId),
    enabled: open,
    staleTime: 30_000,
  });

  const total = recipients.length;
  const current = recipients[index];
  const pct = total > 0 ? Math.round(((phase === 'done' ? total : index) / total) * 100) : 0;
  const blocked = canSend === false;

  const progress = useMemo(() => `${phase === 'done' ? total : index + (phase === 'sending' ? 1 : 0)} / ${total}`, [index, total, phase]);

  if (!campaign) return null;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (phase !== 'sending') onOpenChange(v); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Megaphone className="h-4 w-4 text-primary" />
            {t('csend.title')}
          </DialogTitle>
          <DialogDescription>
            {t('csend.subtitle').replace('{name}', campaign.name)}
          </DialogDescription>
        </DialogHeader>

        {/* Mode + recipient summary */}
        <div className="flex items-center gap-3 rounded-xl border bg-card/40 p-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Users className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-2xl font-bold tabular-nums leading-none">
              {loadingRecipients ? '…' : total}
            </div>
            <div className="text-[11px] text-muted-foreground">{t('csend.recipients')}</div>
          </div>
          <span className={cn(
            'inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-semibold uppercase tracking-wider',
            botReady ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
          )}>
            {botReady ? <><Bot className="h-3 w-3" /> {t('csend.mode_auto')}</> : <><Hand className="h-3 w-3" /> {t('csend.mode_manual')}</>}
          </span>
        </div>

        {blocked && phase === 'idle' && (
          <div className="flex items-start gap-1.5 rounded-md bg-amber-500/10 px-3 py-2 text-[11px] text-amber-800 dark:text-amber-300">
            <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
            <span>{t('bell.cant_send_now')}</span>
          </div>
        )}

        {/* Progress (sending / done) */}
        {phase !== 'idle' && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium">
                {phase === 'done' ? t('csend.complete') : t('csend.in_progress')}
              </span>
              <span className="font-mono text-muted-foreground">{progress}</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
            </div>
            {phase === 'sending' && current && !botReady && (
              <div className="rounded-md border bg-muted/30 p-2 text-xs">
                <div className="font-semibold">{current.name} <span className="font-mono text-muted-foreground">{current.phone}</span></div>
                <p className="mt-1 line-clamp-2 text-muted-foreground">{renderBody(current)}</p>
              </div>
            )}
            {phase === 'done' && (
              <div className="flex items-center gap-1.5 rounded-md bg-emerald-500/10 px-3 py-2 text-xs text-emerald-800 dark:text-emerald-300">
                <CheckCircle2 className="h-3.5 w-3.5" />
                {t('csend.sent_summary').replace('{sent}', String(sentCount)).replace('{total}', String(total))}
              </div>
            )}
          </div>
        )}

        {error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div>
        )}

        <DialogFooter className="flex-wrap gap-2">
          {phase === 'idle' && (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>{t('btn.cancel')}</Button>
              <Button
                onClick={() => (botReady ? runBotBatch() : startManual())}
                disabled={loadingRecipients || total === 0 || blocked || !template}
              >
                <Send className="h-4 w-4" />
                {botReady ? t('csend.send_auto').replace('{n}', String(total)) : t('csend.send_manual')}
              </Button>
            </>
          )}

          {phase === 'sending' && botReady && (
            <Button variant="ghost" onClick={() => { cancelRef.current = true; }} disabled={false}>
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('csend.stop')}
            </Button>
          )}

          {phase === 'sending' && !botReady && (
            <Button onClick={manualNext}>
              {index + 1 >= total ? t('csend.finish') : t('bell.queue_next')}
            </Button>
          )}

          {phase === 'done' && (
            <Button onClick={() => onOpenChange(false)}>{t('csend.close')}</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
