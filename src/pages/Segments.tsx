import { useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { useActivePharmacy } from '@/contexts/PharmacyContext';
import { useT } from '@/contexts/LanguageContext';
import { supabase } from '@/lib/supabase';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { SEGMENTS } from '@/lib/crm/segments';

type SegmentKey = 'new' | 'repeat' | 'high_value' | 'inactive' | 'chronic' | 'optout';

const SEGMENT_LIST = Object.values(SEGMENTS).filter(s => s.key !== 'all');

export default function Segments() {
  const t = useT();
  const { pharmacyId } = useActivePharmacy();

  const { data: counts, isLoading } = useQuery<Record<SegmentKey | 'total', number>>({
    queryKey: ['segment-counts', pharmacyId],
    queryFn: async () => {
      const [autoTags, optOuts, totalCustomers] = await Promise.all([
        supabase.from('crm_customer_auto_tags').select('tag').eq('pharmacy_id', pharmacyId),
        supabase.from('crm_customers').select('id', { count: 'exact', head: true }).eq('pharmacy_id', pharmacyId).eq('whatsapp_opted_in', false),
        supabase.from('crm_customers').select('id', { count: 'exact', head: true }).eq('pharmacy_id', pharmacyId),
      ]);
      const counter: Record<SegmentKey | 'total', number> = {
        new: 0, repeat: 0, high_value: 0, inactive: 0, chronic: 0, optout: 0, total: 0,
      };
      for (const row of (autoTags.data ?? []) as { tag: string }[]) {
        if (row.tag in counter) counter[row.tag as SegmentKey] += 1;
      }
      counter.optout = optOuts.count ?? 0;
      counter.total = totalCustomers.count ?? 0;
      return counter;
    },
  });

  return (
    <div className="space-y-6">
      <header>
        <p className="text-xs text-muted-foreground">{t('nav.section.crm')}</p>
        <h1 className="mt-1 text-3xl font-bold tracking-tight">{t('segments.title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('segments.subtitle')}</p>
      </header>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {SEGMENT_LIST.map((s, i) => (
          <motion.div
            key={s.key}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.04 }}
          >
            <Card
              className={
                s.dark
                  ? 'bg-foreground text-background'
                  : s.key === 'optout'
                    ? 'bg-muted/40'
                    : ''
              }
            >
              <div className="p-6">
                <h3 className="text-lg font-bold">{t(s.labelKey)}</h3>
                <p className={
                  s.dark ? 'mt-1 text-sm text-muted-foreground' : 'mt-1 text-sm text-muted-foreground'
                }>
                  {t(s.descKey)}
                </p>
                <div className="mt-6 text-5xl font-bold tracking-tight">
                  {isLoading ? <Skeleton className="h-12 w-20" /> : (counts?.[s.key as SegmentKey] ?? 0)}
                </div>
                <div className={
                  s.dark ? 'mt-1 text-xs text-muted-foreground' : 'mt-1 text-xs text-muted-foreground'
                }>
                  {t('segments.customers')}
                </div>
                <div className="mt-6 border-t pt-4 text-xs font-medium text-primary">
                  {t(s.helpKey)} →
                </div>
              </div>
            </Card>
          </motion.div>
        ))}
      </div>
    </div>
  );
}
