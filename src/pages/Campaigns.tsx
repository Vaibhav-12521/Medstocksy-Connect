import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus, Send } from 'lucide-react';
import { useActivePharmacy } from '@/contexts/PharmacyContext';
import { useT } from '@/contexts/LanguageContext';
import { supabase, type Tables } from '@/lib/supabase';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { CampaignStatus } from '@/types/database';
import { cn, relativeTime } from '@/lib/utils';
import { CampaignDialog } from '@/components/crm/CampaignDialog';
import { CampaignSendDialog } from '@/components/crm/CampaignSendDialog';
import { getSegment } from '@/lib/crm/segments';

type Campaign = Tables<'crm_campaigns'>;

const statusStyles: Record<CampaignStatus, string> = {
  draft: 'bg-tag-high-bg text-tag-high-fg',
  scheduled: 'bg-tag-new-bg text-tag-new-fg',
  sending: 'bg-tag-new-bg text-tag-new-fg',
  sent: 'bg-tag-repeat-bg text-tag-repeat-fg',
  cancelled: 'bg-tag-inactive-bg text-tag-inactive-fg',
  failed: 'bg-tag-optout-bg text-tag-optout-fg',
};

type CampaignRow = Tables<'crm_campaigns'> & { template?: { name: string } | null };

export default function Campaigns() {
  const t = useT();
  const { pharmacyId } = useActivePharmacy();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Campaign | null>(null);
  const [sending, setSending] = useState<Campaign | null>(null);

  const openNew = () => { setEditing(null); setDialogOpen(true); };
  const openEdit = (c: Campaign) => { setEditing(c); setDialogOpen(true); };

  const { data: campaigns, isLoading } = useQuery<CampaignRow[]>({
    queryKey: ['campaigns', pharmacyId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('crm_campaigns')
        .select('*, template:crm_templates(name)')
        .eq('pharmacy_id', pharmacyId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as CampaignRow[];
    },
  });

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between">
        <div>
          <p className="text-xs text-muted-foreground">{t('nav.section.crm')}</p>
          <h1 className="mt-1 text-3xl font-bold tracking-tight">{t('campaigns.title')}</h1>
        </div>
        <Button onClick={openNew}>
          <Plus className="h-4 w-4" />
          {t('btn.create')}
        </Button>
      </header>

      <div className="space-y-3">
        {isLoading ? (
          Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-28" />)
        ) : (campaigns ?? []).length === 0 ? (
          <Card className="p-12 text-center">
            <h3 className="text-lg font-semibold">{t('campaigns.empty.title')}</h3>
            <p className="mt-2 text-sm text-muted-foreground">{t('campaigns.empty.desc')}</p>
            <Button className="mt-4" onClick={openNew}>
              <Plus className="h-4 w-4" />
              {t('campaigns.empty.cta')}
            </Button>
          </Card>
        ) : (
          (campaigns ?? []).map((c) => {
            const editable = c.status === 'draft' || c.status === 'scheduled';
            return (
              <Card key={c.id} className={cn('overflow-hidden', editable && 'cursor-pointer transition-colors hover:bg-accent/50')}>
                <div className="flex items-center justify-between gap-3 p-5">
                  <button
                    type="button"
                    onClick={() => editable && openEdit(c)}
                    disabled={!editable}
                    className={cn(
                      'min-w-0 flex-1 text-left',
                      !editable && 'cursor-default'
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <span className={cn('rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider', statusStyles[c.status])}>
                        {t(`campaigns.status.${c.status}` as 'campaigns.status.sent')}
                      </span>
                      <span className="text-[11px] text-muted-foreground">
                        {c.scheduled_for ? `${t('campaigns.status.scheduled')} · ${relativeTime(c.scheduled_for)}` : relativeTime(c.created_at)}
                      </span>
                    </div>
                    <h3 className="mt-2 text-lg font-bold">{c.name}</h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {t('campaigns.segment')} <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-bold uppercase', getSegment(c.segment_key).color)}>
                        {t(getSegment(c.segment_key).labelKey)}
                      </span> ·
                      {' '}{t('campaigns.template')} <span className="font-semibold text-foreground">{c.template?.name ?? '—'}</span>
                      {' · '}<span className="font-mono">{c.total_recipients}</span> recipients
                      {c.status === 'sent' && (
                        <span className="ml-2 text-emerald-700">
                          · {c.sent_count}/{c.total_recipients} {t('campaigns.delivered')} · {c.reply_count} {t('campaigns.replies')}
                        </span>
                      )}
                    </p>
                  </button>
                  {editable && (
                    <div className="flex shrink-0 gap-2">
                      <Button variant="outline" size="sm" onClick={() => openEdit(c)}>
                        {t('btn.edit')}
                      </Button>
                      <Button size="sm" onClick={() => setSending(c)}>
                        <Send className="h-3.5 w-3.5" />
                        {t('campaigns.send_now')}
                      </Button>
                    </div>
                  )}
                </div>
              </Card>
            );
          })
        )}
      </div>

      <CampaignDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        campaign={editing}
      />

      <CampaignSendDialog
        open={!!sending}
        onOpenChange={(v) => { if (!v) setSending(null); }}
        campaign={sending}
      />
    </div>
  );
}
