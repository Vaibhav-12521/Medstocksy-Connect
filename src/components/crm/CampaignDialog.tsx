import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, AlertTriangle, Users } from 'lucide-react';
import { useActivePharmacy } from '@/contexts/PharmacyContext';
import { useAuth } from '@/contexts/AuthContext';
import { useT } from '@/contexts/LanguageContext';
import { supabase, type Tables } from '@/lib/supabase';
import { renderTemplate } from '@/lib/utils';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { SEGMENT_OPTIONS } from '@/lib/crm/segments';
import { deduplicateTemplates } from '@/lib/crm/templates';

type Campaign = Tables<'crm_campaigns'>;
type Template = Tables<'crm_templates'>;

interface CampaignDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When provided, dialog opens in edit mode pre-filled */
  campaign?: Campaign | null;
}


export function CampaignDialog({ open, onOpenChange, campaign }: CampaignDialogProps) {
  const t = useT();
  const { user } = useAuth();
  const { pharmacyId } = useActivePharmacy();
  const qc = useQueryClient();
  const isEdit = !!campaign;

  const [name, setName] = useState('');
  const [segmentKey, setSegmentKey] = useState('all');
  const [templateId, setTemplateId] = useState('');
  const [scheduledFor, setScheduledFor] = useState(''); // ISO datetime-local string

  // Templates picker
  const { data: templates = [] } = useQuery<Template[]>({
    queryKey: ['campaign-templates', pharmacyId],
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

  // Recipient count for the selected segment (live updates)
  const { data: recipientCount = 0, isLoading: countLoading } = useQuery<number>({
    queryKey: ['recipient-count', pharmacyId, segmentKey],
    enabled: open,
    queryFn: async (): Promise<number> => {
      // Always exclude opt-outs.
      if (segmentKey === 'all') {
        const { count, error } = await supabase
          .from('crm_customers')
          .select('id', { count: 'exact', head: true })
          .eq('pharmacy_id', pharmacyId)
          .eq('whatsapp_opted_in', true);
        if (error) throw error;
        return count ?? 0;
      }
      if (segmentKey === 'chronic') {
        // chronic = manual tag join with opt-in filter
        const { data: tagRows, error } = await supabase
          .from('crm_tags')
          .select('customer_id')
          .eq('pharmacy_id', pharmacyId)
          .eq('tag_key', 'chronic');
        if (error) throw error;
        const ids = ((tagRows ?? []) as unknown as { customer_id: string }[]).map((r) => r.customer_id);
        if (ids.length === 0) return 0;
        const { count: optedIn, error: e2 } = await supabase
          .from('crm_customers')
          .select('id', { count: 'exact', head: true })
          .in('id', ids)
          .eq('whatsapp_opted_in', true);
        if (e2) throw e2;
        return optedIn ?? 0;
      }
      // Auto-tag segments via the view
      const { data: rows, error } = await supabase
        .from('crm_customer_auto_tags')
        .select('customer_id')
        .eq('pharmacy_id', pharmacyId)
        .eq('tag', segmentKey);
      if (error) throw error;
      const ids = ((rows ?? []) as unknown as { customer_id: string }[]).map((r) => r.customer_id);
      if (ids.length === 0) return 0;
      const { count: optedIn, error: e2 } = await supabase
        .from('crm_customers')
        .select('id', { count: 'exact', head: true })
        .in('id', ids)
        .eq('whatsapp_opted_in', true);
      if (e2) throw e2;
      return optedIn ?? 0;
    },
  });

  // Pharmacy guardrails for bulk-approval threshold
  const { data: pharmacy } = useQuery<{ bulk_approval_threshold: number }>({
    queryKey: ['pharmacy-guardrails', pharmacyId],
    enabled: open,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('crm_pharmacies')
        .select('bulk_approval_threshold')
        .eq('id', pharmacyId)
        .single();
      if (error) throw error;
      return data as unknown as { bulk_approval_threshold: number };
    },
  });

  // Hydrate form
  useEffect(() => {
    if (!open) return;
    if (isEdit && campaign) {
      setName(campaign.name);
      setSegmentKey(campaign.segment_key);
      setTemplateId(campaign.template_id);
      setScheduledFor(campaign.scheduled_for ? campaign.scheduled_for.slice(0, 16) : '');
    } else {
      setName('');
      setSegmentKey('all');
      setTemplateId(templates[0]?.id ?? '');
      setScheduledFor('');
    }
  }, [open, isEdit, campaign, templates]);

  const overThreshold = pharmacy
    ? recipientCount > pharmacy.bulk_approval_threshold
    : false;

  const selectedTemplate = templates.find((tpl) => tpl.id === templateId);
  const samplePreview = selectedTemplate
    ? renderTemplate(selectedTemplate.body, {
        name: 'Priya',
        pharmacy_name: 'Your pharmacy',
        amount: '₹2,150',
        medicine: 'Cough syrup',
        category: 'vitamins',
        discount: '20',
        date: 'May 31',
        pharmacy_phone: '+91 95555 12345',
      })
    : '';

  const save = useMutation<Campaign, Error, { schedule: boolean }>({
    mutationFn: async ({ schedule }) => {
      if (!user) throw new Error('Not authenticated.');
      if (!name.trim()) throw new Error('Campaign name is required.');
      if (!templateId) throw new Error('Pick a message template.');
      if (schedule && !scheduledFor) throw new Error('Pick a date and time to schedule.');

      const payload: Record<string, unknown> = {
        pharmacy_id: pharmacyId,
        created_by: user.id,
        name: name.trim(),
        segment_key: segmentKey,
        template_id: templateId,
        total_recipients: recipientCount,
        status: schedule ? 'scheduled' : 'draft',
      };
      if (schedule) {
        payload['scheduled_for'] = new Date(scheduledFor).toISOString();
      }

      if (isEdit && campaign) {
        const { data, error } = await supabase
          .from('crm_campaigns')
          .update(payload as never)
          .eq('id', campaign.id)
          .select()
          .single();
        if (error) throw new Error(error.message);
        return data as unknown as Campaign;
      }

      const { data, error } = await supabase
        .from('crm_campaigns')
        .insert(payload as never)
        .select()
        .single();
      if (error) throw new Error(error.message);
      return data as unknown as Campaign;
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['campaigns'] });
      onOpenChange(false);
    },
  });

  const remove = useMutation<void, Error>({
    mutationFn: async () => {
      if (!campaign) return;
      const ok = window.confirm(t('campaigns.confirm_delete'));
      if (!ok) throw new Error('cancelled');
      const { error } = await supabase.from('crm_campaigns').delete().eq('id', campaign.id);
      if (error) throw new Error(error.message);
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['campaigns'] });
      onOpenChange(false);
    },
  });

  const canSubmit = !!name.trim() && !!templateId && !save.isPending;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!save.isPending) onOpenChange(v); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? t('campaigns.edit') : t('campaigns.new')}</DialogTitle>
          <DialogDescription>{t('campaigns.new_desc')}</DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(e) => { e.preventDefault(); if (canSubmit) save.mutate({ schedule: false }); }}
          className="space-y-3"
        >
          {/* Row 1: Name + Segment */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-sm font-medium">
                {t('campaigns.name')} <span className="text-destructive">*</span>
              </label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder='e.g. "May vitamin offer"'
                required
                autoFocus
                maxLength={120}
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">{t('campaigns.segment_label')}</label>
              <select
                value={segmentKey}
                onChange={(e) => setSegmentKey(e.target.value)}
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {SEGMENT_OPTIONS.map((opt) => (
                  <option key={opt.key} value={opt.key}>
                    {t(opt.labelKey)}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Recipient count */}
          <div className="flex items-center gap-3 rounded-lg border bg-muted/40 p-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Users className="h-4 w-4" />
            </div>
            <div className="flex-1">
              <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                {t('campaigns.estimated_recipients')}
              </div>
              <div className="font-mono text-2xl font-bold">
                {countLoading ? '…' : recipientCount.toLocaleString()}
              </div>
            </div>
            <div className="text-xs text-muted-foreground">{t('campaigns.estimated_hint')}</div>
          </div>

          {/* Bulk warning */}
          {overThreshold && pharmacy && (
            <div className="flex items-start gap-2 rounded-md bg-yellow-500/10 p-3 text-xs">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-yellow-700" />
              <div className="text-yellow-800 dark:text-yellow-300">
                {t('campaigns.bulk_warning').replace('{n}', String(pharmacy.bulk_approval_threshold))}
              </div>
            </div>
          )}

          {/* Template + Schedule (3-col on desktop) */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto]">
            <div>
              <label className="mb-1 block text-sm font-medium">{t('campaigns.template')}</label>
              <select
                value={templateId}
                onChange={(e) => setTemplateId(e.target.value)}
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="" disabled>—</option>
                {templates.map((tpl) => (
                  <option key={tpl.id} value={tpl.id}>
                    {tpl.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">
                {t('campaigns.schedule_for')}{' '}
                <span className="text-xs font-normal text-muted-foreground">({t('common.optional')})</span>
              </label>
              <Input
                type="datetime-local"
                className="font-mono"
                value={scheduledFor}
                onChange={(e) => setScheduledFor(e.target.value)}
              />
            </div>
          </div>

          {/* Live preview */}
          {samplePreview && (
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {t('compose.preview')}
              </label>
              <div className="rounded-2xl border-l-4 border-emerald-400 bg-emerald-50 p-3 text-sm leading-relaxed dark:bg-emerald-950/30">
                {selectedTemplate?.image_url && (
                  <img 
                    src={selectedTemplate.image_url} 
                    alt="" 
                    className="mb-3 aspect-video w-full rounded-lg border object-cover shadow-sm" 
                  />
                )}
                {samplePreview}
              </div>
            </div>
          )}

          {save.isError && save.error.message !== 'cancelled' && (
            <div className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {save.error?.message ?? t('common.unknown')}
            </div>
          )}

          <p className="text-xs text-muted-foreground">{t('campaigns.draft_only_hint')}</p>

          <DialogFooter className="flex-wrap gap-2 pt-2 sm:flex-nowrap">
            {isEdit && campaign?.status === 'draft' && (
              <Button
                type="button"
                variant="ghost"
                className="text-destructive sm:mr-auto"
                onClick={() => remove.mutate()}
                disabled={save.isPending || remove.isPending}
              >
                {remove.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                {t('btn.delete_draft')}
              </Button>
            )}
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={save.isPending}>
              {t('btn.cancel')}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => save.mutate({ schedule: false })}
              disabled={!canSubmit}
            >
              {save.isPending && save.variables?.schedule === false && <Loader2 className="h-4 w-4 animate-spin" />}
              {t('btn.save_draft')}
            </Button>
            <Button
              type="button"
              onClick={() => save.mutate({ schedule: true })}
              disabled={!canSubmit || !scheduledFor}
            >
              {save.isPending && save.variables?.schedule === true && <Loader2 className="h-4 w-4 animate-spin" />}
              {t('btn.schedule_send')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
