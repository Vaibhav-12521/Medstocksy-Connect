import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Search, Plus, Download, ArrowUpDown, Users, Receipt } from 'lucide-react';
import { motion } from 'framer-motion';
import { useActivePharmacy } from '@/contexts/PharmacyContext';
import { useT } from '@/contexts/LanguageContext';
import type { TranslationKey } from '@/i18n/translations';
import { listCustomers, type CustomerSort } from '@/lib/api/customers';
import { cn, formatINR, initials, relativeTime } from '@/lib/utils';
import { Tag, type TagKey } from '@/components/ui/tag';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { CustomerFormDialog } from '@/components/crm/CustomerFormDialog';
import { AddFromBillDialog } from '@/components/crm/AddFromBillDialog';

type Segment = 'all' | 'new' | 'repeat' | 'inactive' | 'high_value' | 'chronic' | 'optout';
const VALID_SEGMENTS: Segment[] = ['all', 'new', 'repeat', 'inactive', 'high_value', 'chronic', 'optout'];

const segmentChips: { key: Segment; labelKey: TranslationKey }[] = [
  { key: 'all', labelKey: 'customers.tag.all' },
  { key: 'new', labelKey: 'customers.tag.new' },
  { key: 'repeat', labelKey: 'customers.tag.repeat' },
  { key: 'inactive', labelKey: 'customers.tag.inactive' },
  { key: 'high_value', labelKey: 'customers.tag.high_value' },
  { key: 'chronic', labelKey: 'customers.tag.chronic' },
  { key: 'optout', labelKey: 'customers.tag.optout' },
];

export default function Customers() {
  const t = useT();
  const navigate = useNavigate();
  const { pharmacyId } = useActivePharmacy();
  const [searchParams, setSearchParams] = useSearchParams();
  const initialSegment = (searchParams.get('segment') as Segment) ?? 'all';
  const [segment, setSegment] = useState<Segment>(
    VALID_SEGMENTS.includes(initialSegment) ? initialSegment : 'all'
  );
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<CustomerSort>('newest');
  const [newOpen, setNewOpen] = useState(false);
  const [billOpen, setBillOpen] = useState(false);

  const SORT_OPTIONS: { value: CustomerSort; labelKey: TranslationKey }[] = useMemo(() => ([
    { value: 'newest',        labelKey: 'customers.sort.newest' },
    { value: 'oldest',        labelKey: 'customers.sort.oldest' },
    { value: 'name',          labelKey: 'customers.sort.name' },
    { value: 'recent_visit',  labelKey: 'customers.sort.recent_visit' },
    { value: 'top_spend',     labelKey: 'customers.sort.top_spend' },
  ]), []);

  // Sync segment ↔ URL so deep links from Dashboard tiles work
  useEffect(() => {
    const params = new URLSearchParams(searchParams);
    if (segment === 'all') params.delete('segment');
    else params.set('segment', segment);
    setSearchParams(params, { replace: true });
  }, [segment, searchParams, setSearchParams]);

  const { data, isLoading } = useQuery({
    queryKey: ['customers', pharmacyId, segment, search, sort],
    queryFn: () =>
      listCustomers({ pharmacyId, segment, search: search || undefined, sort, limit: 50 }),
    enabled: !!pharmacyId,
    // Customer lists rarely change in a 5-min window during normal counter
    // work; mutations (create/edit) already invalidate the key, so this just
    // suppresses needless background refetches.
    staleTime: 5 * 60_000,
  });

  // Build a lookup so family rows can render "Family of {primaryName}".
  const primaryNameById = useMemo(() => {
    const map = new Map<string, string>();
    (data?.rows ?? []).forEach((c) => map.set(c.id, c.name));
    return map;
  }, [data]);

  const exportCsv = () => {
    if (!data?.rows.length) return;
    const header = ['Name', 'Phone', 'Last Visit', 'LTV', 'Visits'];
    const rows = data.rows.map((c) => [
      c.name,
      c.phone,
      c.stats?.last_visit_at ?? '',
      c.stats?.lifetime_value ?? 0,
      c.stats?.visit_count ?? 0,
    ]);
    const csv = [header, ...rows]
      .map((r) => r.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `customers-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs text-muted-foreground">{t('nav.section.crm')}</p>
          <h1 className="mt-1 text-3xl font-bold tracking-tight">{t('customers.title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {data
              ? t('customers.subtitle_template')
                  .replace('{total}', String(data.total))
                  .replace('{showing}', String(data.rows.length))
              : '—'}
          </p>
        </div>
        {/* On phones: 3 buttons share the row, each grows to fill. On
            tablet+: natural sizes. */}
        <div className="grid w-full grid-cols-3 gap-2 sm:flex sm:w-auto">
          <Button variant="outline" onClick={exportCsv} disabled={!data?.rows.length} className="min-w-0">
            <Download className="h-4 w-4" />
            <span className="truncate">{t('btn.export')}</span>
          </Button>
          <Button variant="outline" onClick={() => setBillOpen(true)} className="min-w-0">
            <Receipt className="h-4 w-4" />
            <span className="truncate">{t('add_bill.button')}</span>
          </Button>
          <Button onClick={() => setNewOpen(true)} className="min-w-0">
            <Plus className="h-4 w-4" />
            <span className="truncate">{t('btn.add_customer')}</span>
          </Button>
        </div>
      </header>

      {/* Segment chips */}
      <div className="flex flex-wrap gap-2">
        {segmentChips.map((chip) => (
          <button
            key={chip.key}
            onClick={() => setSegment(chip.key)}
            className={cn(
              'rounded-full border px-3 py-1.5 text-sm font-medium transition-all duration-150',
              segment === chip.key
                ? 'border-foreground bg-foreground text-background'
                : 'border-border bg-background text-muted-foreground hover:bg-accent'
            )}
          >
            {t(chip.labelKey)}
          </button>
        ))}
      </div>

      {/* Search + sort */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('customers.search_placeholder')}
            className="pl-10"
          />
        </div>
        <div className="relative shrink-0">
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as CustomerSort)}
            aria-label={t('customers.sort_by')}
            className="h-10 appearance-none rounded-md border border-input bg-background pl-3 pr-9 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{t(o.labelKey)}</option>
            ))}
          </select>
          <ArrowUpDown
            className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
        </div>
      </div>

      {/* MOBILE: card stack (phones only) */}
      <div className="space-y-2 md:hidden">
        {isLoading ? (
          Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-20" />)
        ) : data?.rows.length === 0 ? (
          <Card className="p-10 text-center text-sm text-muted-foreground">
            {t('customers.empty')}
          </Card>
        ) : (
          data?.rows.map((c, i) => (
            <motion.div
              key={c.id}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.015 }}
            >
              <Link to={`/customers/${c.id}`} className="block">
                <Card className="flex items-start gap-3 p-3 transition-colors hover:border-primary/40 hover:bg-muted/30">
                  <div className={cn(
                    'flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-bold',
                    c.family_of_id
                      ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
                      : 'bg-primary/10 text-primary'
                  )}>
                    {initials(c.name)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="truncate font-semibold">{c.name}</span>
                      {c.family_of_id && (
                        <span className="inline-flex items-center gap-1 rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-300">
                          <Users className="h-2.5 w-2.5" />
                          {t('cust.family_badge').replace(
                            '{name}',
                            primaryNameById.get(c.family_of_id) ?? t('cust.family_unknown')
                          )}
                        </span>
                      )}
                    </div>
                    <div className="font-mono text-[11px] text-muted-foreground">{c.phone}</div>
                    <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
                      <span>{c.stats?.last_visit_at ? relativeTime(c.stats.last_visit_at) : '—'}</span>
                      <span>·</span>
                      <span className="font-mono font-medium text-foreground/80">
                        {c.stats ? formatINR(c.stats.lifetime_value) : '—'}
                      </span>
                      <span>·</span>
                      <span className="font-mono">{c.stats?.visit_count ?? 0} {t('profile.visits')}</span>
                    </div>
                    {(c.auto_tags.length > 0 || !c.whatsapp_opted_in) && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {c.auto_tags.map((t: TagKey) => <Tag key={t} tag={t} />)}
                        {!c.whatsapp_opted_in && <Tag tag="optout" />}
                      </div>
                    )}
                  </div>
                </Card>
              </Link>
            </motion.div>
          ))
        )}
      </div>

      {/* DESKTOP: full table (tablet+) */}
      <Card className="hidden md:block">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/30 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-5 py-3">{t('customers.col.customer')}</th>
                <th className="px-5 py-3">{t('customers.col.phone')}</th>
                <th className="px-5 py-3">{t('customers.col.last_visit')}</th>
                <th className="px-5 py-3">{t('customers.col.ltv')}</th>
                <th className="px-5 py-3">{t('customers.col.visits')}</th>
                <th className="px-5 py-3">{t('customers.col.tags')}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {isLoading ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i}>
                    <td colSpan={6} className="p-3">
                      <Skeleton className="h-9" />
                    </td>
                  </tr>
                ))
              ) : data?.rows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="p-12 text-center text-sm text-muted-foreground">
                    {t('customers.empty')}
                  </td>
                </tr>
              ) : (
                data?.rows.map((c, i) => (
                  <motion.tr
                    key={c.id}
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: i * 0.015 }}
                    className="hover:bg-muted/40"
                  >
                    <td className="px-5 py-3">
                      <Link to={`/customers/${c.id}`} className="flex items-center gap-3">
                        <div className={cn(
                          'flex h-9 w-9 items-center justify-center rounded-full text-xs font-bold',
                          c.family_of_id
                            ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
                            : 'bg-primary/10 text-primary'
                        )}>
                          {initials(c.name)}
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="font-semibold">{c.name}</span>
                            {c.family_of_id && (
                              <span className="inline-flex items-center gap-1 rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-300">
                                <Users className="h-2.5 w-2.5" />
                                {t('cust.family_badge').replace(
                                  '{name}',
                                  primaryNameById.get(c.family_of_id) ?? t('cust.family_unknown')
                                )}
                              </span>
                            )}
                          </div>
                          {c.age != null && (
                            <div className="text-[11px] text-muted-foreground">
                              {c.age}{c.gender ? ` · ${c.gender}` : ''}
                            </div>
                          )}
                        </div>
                      </Link>
                    </td>
                    <td className="px-5 py-3 font-mono text-xs text-muted-foreground">{c.phone}</td>
                    <td className="px-5 py-3">
                      {c.stats?.last_visit_at ? relativeTime(c.stats.last_visit_at) : '—'}
                    </td>
                    <td className="px-5 py-3 font-mono font-medium">
                      {c.stats ? formatINR(c.stats.lifetime_value) : '—'}
                    </td>
                    <td className="px-5 py-3 font-mono">{c.stats?.visit_count ?? 0}</td>
                    <td className="px-5 py-3">
                      <div className="flex flex-wrap gap-1">
                        {c.auto_tags.map((t: TagKey) => (
                          <Tag key={t} tag={t} />
                        ))}
                        {!c.whatsapp_opted_in && <Tag tag="optout" />}
                      </div>
                    </td>
                  </motion.tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <CustomerFormDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        mode="create"
        onCreated={(customer) => navigate(`/customers/${customer.id}`)}
      />

      <AddFromBillDialog
        open={billOpen}
        onOpenChange={setBillOpen}
        onCreated={(customer) => navigate(`/customers/${customer.id}`)}
      />
    </div>
  );
}
