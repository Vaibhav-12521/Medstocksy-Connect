import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import {
  Search, ArrowDownLeft, ArrowUpRight, CheckCheck, Check, AlertCircle,
  Clock, Inbox, Activity as ActivityIcon, MessageCircle,
} from 'lucide-react';
import { useActivePharmacy } from '@/contexts/PharmacyContext';
import { useT } from '@/contexts/LanguageContext';
import type { TranslationKey } from '@/i18n/translations';
import { supabase } from '@/lib/supabase';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';
import { cn, initials } from '@/lib/utils';
import type { MessageDirection, MessageStatus } from '@/types/database';

interface ActivityRow {
  id: string;
  body: string;
  direction: MessageDirection;
  status: MessageStatus;
  created_at: string;
  customer_id: string | null;
  customer?: { name: string; phone: string } | null;
  template?: { name: string } | null;
}

type Filter = 'all' | 'outbound' | 'inbound' | 'delivered' | 'failed';

const FILTERS: { key: Filter; labelKey: TranslationKey }[] = [
  { key: 'all',       labelKey: 'activity.filter.all' },
  { key: 'outbound',  labelKey: 'activity.filter.outbound' },
  { key: 'inbound',   labelKey: 'activity.filter.inbound' },
  { key: 'delivered', labelKey: 'activity.filter.delivered' },
  { key: 'failed',    labelKey: 'activity.filter.failed' },
];

export default function Activity() {
  const t = useT();
  const { pharmacyId } = useActivePharmacy();
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');

  const { data, isLoading } = useQuery<ActivityRow[]>({
    queryKey: ['activity', pharmacyId],
    queryFn: async () => {
      const { data: rows, error } = await supabase
        .from('crm_messages')
        .select(`
          id, body, direction, status, created_at, customer_id,
          customer:crm_customers(name, phone),
          template:crm_templates(name)
        `)
        .eq('pharmacy_id', pharmacyId)
        .order('created_at', { ascending: false })
        .limit(100);
      if (error) throw error;
      return (rows ?? []) as unknown as ActivityRow[];
    },
  });

  // Mini-stats — these reflect what's *visible* in the current 100-row window.
  const stats = useMemo(() => {
    const rows = data ?? [];
    return {
      total: rows.length,
      sent: rows.filter((r) => r.status === 'sent' || r.status === 'delivered' || r.status === 'read').length,
      pending: rows.filter((r) => r.status === 'queued' || r.status === 'sending').length,
      failed: rows.filter((r) => r.status === 'failed' || r.status === 'bounced').length,
    };
  }, [data]);

  // Apply filters + search client-side over the same 100-row window.
  const filtered = useMemo(() => {
    let rows = data ?? [];
    if (filter === 'outbound')  rows = rows.filter((r) => r.direction === 'outbound');
    if (filter === 'inbound')   rows = rows.filter((r) => r.direction === 'inbound');
    if (filter === 'delivered') rows = rows.filter((r) => r.status === 'delivered' || r.status === 'read');
    if (filter === 'failed')    rows = rows.filter((r) => r.status === 'failed' || r.status === 'bounced');
    if (search.trim()) {
      const q = search.toLowerCase();
      rows = rows.filter((r) =>
        r.customer?.name?.toLowerCase().includes(q) ||
        r.customer?.phone?.toLowerCase().includes(q) ||
        r.body.toLowerCase().includes(q)
      );
    }
    return rows;
  }, [data, filter, search]);

  // Group by relative date bucket.
  const groups = useMemo(() => groupByDate(filtered), [filtered]);

  return (
    <div className="space-y-6">
      {/* ── Header ── */}
      <header>
        <p className="text-xs text-muted-foreground">{t('nav.section.crm')}</p>
        <h1 className="mt-1 text-3xl font-bold tracking-tight">{t('activity.title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('activity.subtitle')}</p>
      </header>

      {/* ── Compact stat strip (4 tiles) ── */}
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          icon={<ActivityIcon className="h-4 w-4" />}
          label={t('activity.stat.total')}
          value={stats.total}
          tone="primary"
        />
        <StatTile
          icon={<CheckCheck className="h-4 w-4" />}
          label={t('activity.stat.sent')}
          value={stats.sent}
          tone="emerald"
        />
        <StatTile
          icon={<Clock className="h-4 w-4" />}
          label={t('activity.stat.pending')}
          value={stats.pending}
          tone="amber"
        />
        <StatTile
          icon={<AlertCircle className="h-4 w-4" />}
          label={t('activity.stat.failed')}
          value={stats.failed}
          tone="destructive"
        />
      </section>

      {/* ── Filter chips ── */}
      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={cn(
              'rounded-full border px-3 py-1.5 text-sm font-medium transition-colors',
              filter === f.key
                ? 'border-foreground bg-foreground text-background'
                : 'border-border bg-background text-muted-foreground hover:bg-accent hover:text-foreground'
            )}
          >
            {t(f.labelKey)}
          </button>
        ))}
      </div>

      {/* ── Search ── */}
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('activity.search_placeholder')}
          className="pl-10"
        />
      </div>

      {/* ── Timeline ── */}
      {isLoading ? (
        <Card className="space-y-3 p-4">
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
        </Card>
      ) : filtered.length === 0 ? (
        <EmptyState
          query={search}
          activeFilter={filter}
          onClear={() => { setSearch(''); setFilter('all'); }}
        />
      ) : (
        <div className="space-y-6">
          {groups.map((g) => (
            <section key={g.key}>
              <div className="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                <span className="h-px flex-1 bg-border" />
                <span>{g.labelKey ? t(g.labelKey) : g.key}</span>
                <span className="font-mono text-foreground/60">{g.rows.length}</span>
                <span className="h-px flex-1 bg-border" />
              </div>
              <Card className="divide-y">
                {g.rows.map((m, i) => (
                  <ActivityRowItem key={m.id} row={m} delay={i * 0.015} />
                ))}
              </Card>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function StatTile({
  icon, label, value, tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  tone: 'primary' | 'emerald' | 'amber' | 'destructive';
}) {
  const colors =
    tone === 'emerald'     ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 ring-emerald-500/20'
    : tone === 'amber'     ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300 ring-amber-500/20'
    : tone === 'destructive' ? 'bg-destructive/10 text-destructive ring-destructive/20'
    : 'bg-primary/10 text-primary ring-primary/20';
  return (
    <div className="rounded-xl border bg-card p-3.5 transition-colors hover:border-primary/30">
      <div className="flex items-center gap-3">
        <span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ring-1', colors)}>
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
            {label}
          </div>
          <div className="text-2xl font-bold tabular-nums leading-none">{value}</div>
        </div>
      </div>
    </div>
  );
}

function ActivityRowItem({ row, delay }: { row: ActivityRow; delay: number }) {
  const t = useT();
  const isOutbound = row.direction === 'outbound';
  const time = new Date(row.created_at).toLocaleTimeString('en-IN', {
    hour: 'numeric', minute: '2-digit',
  });

  const inner = (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, delay }}
      className="flex items-start gap-3 p-3 transition-colors hover:bg-muted/40"
    >
      {/* Avatar + direction badge */}
      <div className="relative shrink-0">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">
          {row.customer ? initials(row.customer.name) : <MessageCircle className="h-4 w-4" />}
        </div>
        <span className={cn(
          'absolute -bottom-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full ring-2 ring-background',
          isOutbound ? 'bg-primary text-primary-foreground' : 'bg-emerald-500 text-white'
        )}>
          {isOutbound ? <ArrowUpRight className="h-2.5 w-2.5" /> : <ArrowDownLeft className="h-2.5 w-2.5" />}
        </span>
      </div>

      {/* Body */}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="truncate text-sm font-semibold">
            {row.customer?.name ?? t('activity.unknown_customer')}
          </span>
          {row.customer?.phone && (
            <span className="font-mono text-[11px] text-muted-foreground">{row.customer.phone}</span>
          )}
          {row.template?.name && (
            <span className="rounded bg-muted px-1.5 py-px text-[10px] font-mono text-muted-foreground">
              {row.template.name}
            </span>
          )}
        </div>
        <p className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">{row.body}</p>
      </div>

      {/* Status + time */}
      <div className="flex shrink-0 flex-col items-end gap-1">
        <StatusBadge status={row.status} />
        <span className="font-mono text-[10px] text-muted-foreground">{time}</span>
      </div>
    </motion.div>
  );

  if (row.customer_id) {
    return (
      <Link to={`/customers/${row.customer_id}`} className="block focus:outline-none">
        {inner}
      </Link>
    );
  }
  return inner;
}

function StatusBadge({ status }: { status: MessageStatus }) {
  const t = useT();
  const tone =
    status === 'delivered' || status === 'read'   ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
    : status === 'failed' || status === 'bounced' ? 'bg-destructive/10 text-destructive'
    : status === 'sending' || status === 'queued' ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
    : 'bg-sky-500/10 text-sky-700 dark:text-sky-300';
  const Icon =
    status === 'delivered' || status === 'read'   ? CheckCheck
    : status === 'failed' || status === 'bounced' ? AlertCircle
    : status === 'sending' || status === 'queued' ? Clock
    : Check;
  const labelKey: TranslationKey =
    status === 'queued'    ? 'activity.status.queued'
    : status === 'sending' ? 'activity.status.sending'
    : status === 'sent'    ? 'activity.status.sent'
    : status === 'delivered' ? 'activity.status.delivered'
    : status === 'read'    ? 'activity.status.read'
    : status === 'failed'  ? 'activity.status.failed'
    : 'activity.status.bounced';
  return (
    <span className={cn(
      'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider',
      tone
    )}>
      <Icon className="h-2.5 w-2.5" />
      {t(labelKey)}
    </span>
  );
}

function EmptyState({
  query, activeFilter, onClear,
}: {
  query: string; activeFilter: Filter; onClear: () => void;
}) {
  const t = useT();
  const filtered = query.trim().length > 0 || activeFilter !== 'all';
  return (
    <Card className="flex flex-col items-center justify-center gap-3 py-14 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
        <Inbox className="h-5 w-5 text-muted-foreground" />
      </div>
      <div>
        <div className="text-sm font-semibold">
          {filtered ? t('activity.empty_filtered') : t('activity.empty_all')}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {filtered ? t('activity.empty_filtered_hint') : t('activity.empty_all_hint')}
        </p>
      </div>
      {filtered && (
        <button
          type="button"
          onClick={onClear}
          className="text-xs font-medium text-primary hover:underline"
        >
          {t('activity.clear_filters')}
        </button>
      )}
    </Card>
  );
}

// ─── Date grouping ──────────────────────────────────────────────────────────

interface Group {
  key: string;
  labelKey?: TranslationKey;
  rows: ActivityRow[];
}

function groupByDate(rows: ActivityRow[]): Group[] {
  if (rows.length === 0) return [];
  const today = startOfDay(new Date());
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  const sevenDaysAgo = new Date(today); sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  const todayGroup: ActivityRow[] = [];
  const yesterdayGroup: ActivityRow[] = [];
  const thisWeekGroup: ActivityRow[] = [];
  const olderByDate = new Map<string, ActivityRow[]>();

  for (const r of rows) {
    const d = startOfDay(new Date(r.created_at));
    if (d.getTime() === today.getTime()) todayGroup.push(r);
    else if (d.getTime() === yesterday.getTime()) yesterdayGroup.push(r);
    else if (d > sevenDaysAgo) thisWeekGroup.push(r);
    else {
      const k = d.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
      const arr = olderByDate.get(k) ?? [];
      arr.push(r);
      olderByDate.set(k, arr);
    }
  }

  const out: Group[] = [];
  if (todayGroup.length)     out.push({ key: 'today',     labelKey: 'activity.group.today',     rows: todayGroup });
  if (yesterdayGroup.length) out.push({ key: 'yesterday', labelKey: 'activity.group.yesterday', rows: yesterdayGroup });
  if (thisWeekGroup.length)  out.push({ key: 'thisweek',  labelKey: 'activity.group.this_week', rows: thisWeekGroup });
  for (const [k, arr] of olderByDate) out.push({ key: k, rows: arr });
  return out;
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
