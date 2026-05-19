import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { BellRing, Megaphone, Send, TrendingUp, Users, Activity as ActivityIcon, HeartPulse, ClipboardList, AlertTriangle, FileText, Zap, MessageSquare, Smartphone, PhoneCall } from 'lucide-react';
import { useActivePharmacy } from '@/contexts/PharmacyContext';
import { useT } from '@/contexts/LanguageContext';
import { supabase } from '@/lib/supabase';
import { getWhatsAppHealth } from '@/lib/api/messages';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { RateMeter } from '@/components/crm/RateMeter';
import { ComposeDrawer } from '@/components/crm/ComposeDrawer';
import { CustomerPickerDialog } from '@/components/crm/CustomerPickerDialog';
import { cn } from '@/lib/utils';
import type { CustomerWithStats } from '@/lib/api/customers';

/**
 * Compact stat tile: icon chip + label + value + subtitle on a tight rhythm.
 * Optional accent color tints the value (orange/coral) for at-a-glance scanning.
 */
interface StatTileProps {
  label: string;
  value: string | number;
  sub: string;
  icon: typeof BellRing;
  /** Brand semantics — used for the icon chip background and the value tint when valueColor is set. */
  dotColor: string;
  /** Tint the value itself (orange today-reminders + coral chronic) */
  valueColor?: string;
  delay?: number;
}

function StatTile({
  label, value, sub, icon: Icon, dotColor, valueColor, delay = 0, onClick, href,
}: StatTileProps & { onClick?: () => void; href?: string }) {
  const interactive = !!(onClick || href);
  const Wrapper = interactive ? 'button' : 'div';
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.16, delay }}
    >
      <Wrapper
        onClick={onClick}
        type={interactive ? 'button' : undefined}
        className={cn(
          'group flex w-full items-center gap-3 rounded-xl border bg-card p-3.5 text-left card-elev transition-all',
          interactive &&
            'cursor-pointer hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-popover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
        )}
      >
        {/* Icon chip — colored background = quick scan affordance */}
        <span
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ring-1"
          style={{
            backgroundColor: `${dotColor}1A`,  // ~10% alpha
            color: dotColor,
            // ring color matches dot at low alpha
            boxShadow: `inset 0 0 0 1px ${dotColor}33`,
          }}
          aria-hidden
        >
          <Icon className="h-4 w-4" strokeWidth={2.25} />
        </span>

        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
            {label}
          </div>
          <div className="mt-0.5 flex items-baseline gap-2">
            <span
              className={cn('text-2xl font-bold leading-none tabular-nums', !valueColor && 'text-foreground')}
              style={valueColor ? { color: valueColor } : undefined}
            >
              {value ?? '—'}
            </span>
          </div>
          <div className="mt-1 truncate text-[11px] text-muted-foreground">{sub}</div>
        </div>
      </Wrapper>
    </motion.div>
  );
}

// Legacy palette from medcrm-app — kept verbatim so the visual feel matches.
const TILE_COLORS = {
  greenDot: '#1D9E75',
  orangeDot: '#EF9F27',
  purpleDot: '#7F77DD',
  coralDot: '#D85A30',
} as const;

/* ─── Recent Prescriptions widget ─────────────────────────────────────────── */
function RecentPrescriptions({
  pharmacyId,
  onNavigate,
}: { pharmacyId: string; onNavigate: (path: string) => void }) {
  interface RxRow {
    id: string;
    prescription_date: string;
    doctor_name: string | null;
    diagnosis: string | null;
    customer: { id: string; name: string } | null;
  }
  const { data: rxs = [], isLoading } = useQuery<RxRow[]>({
    queryKey: ['recent-prescriptions-dash', pharmacyId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('crm_prescriptions')
        .select('id, prescription_date, doctor_name, diagnosis, customer:crm_customers(id, name)')
        .eq('pharmacy_id', pharmacyId)
        .order('created_at', { ascending: false })
        .limit(6);
      if (error) throw error;
      return (data ?? []) as unknown as RxRow[];
    },
  });

  return (
    <Card>
      <div className="flex items-center justify-between border-b px-5 py-4">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <FileText className="h-4 w-4 text-primary" /> Recent Prescriptions
        </h2>
        <button onClick={() => onNavigate('/customers')} className="text-xs text-muted-foreground hover:text-primary">View all →</button>
      </div>
      <div className="divide-y">
        {isLoading ? Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 p-4">
            <Skeleton className="h-9 w-9 rounded-full" />
            <div className="flex-1 space-y-1.5"><Skeleton className="h-4 w-2/3" /><Skeleton className="h-3 w-1/3" /></div>
          </div>
        )) : rxs.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">No prescriptions yet. Use Quick Rx to add one.</div>
        ) : rxs.map(rx => (
          <button key={rx.id} onClick={() => rx.customer && onNavigate(`/customers/${rx.customer.id}`)}
            className="flex w-full items-center gap-3 p-4 text-left transition-colors hover:bg-muted/40">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">
              {rx.customer?.name?.slice(0, 2).toUpperCase() ?? 'Rx'}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold truncate">{rx.customer?.name ?? '—'}</div>
              <div className="text-xs text-muted-foreground truncate">
                {rx.doctor_name ? `Dr. ${rx.doctor_name}` : 'No doctor'} · {rx.diagnosis ?? 'No diagnosis'}
              </div>
            </div>
            <div className="text-right text-xs text-muted-foreground shrink-0">
              {new Date(rx.prescription_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
            </div>
          </button>
        ))}
      </div>
    </Card>
  );
}

/* ─── Failed Reminders widget ──────────────────────────────────────────────── */
function FailedReminders({
  pharmacyId,
  onNavigate,
}: { pharmacyId: string; onNavigate: (path: string) => void }) {
  interface FailedRow {
    id: string;
    scheduled_for: string;
    variables: Record<string, string>;
    customer: { id: string; name: string; phone: string } | null;
    template: { name: string } | null;
  }
  const { data: failed = [], isLoading } = useQuery<FailedRow[]>({
    queryKey: ['failed-reminders-dash', pharmacyId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('crm_scheduled_reminders')
        .select('id, scheduled_for, variables, customer:crm_customers(id, name, phone), template:crm_templates(name)')
        .eq('pharmacy_id', pharmacyId)
        .in('status', ['failed', 'cancelled'])
        .order('scheduled_for', { ascending: false })
        .limit(6);
      if (error) throw error;
      return (data ?? []) as unknown as FailedRow[];
    },
  });

  return (
    <Card>
      <div className="flex items-center justify-between border-b px-5 py-4">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <AlertTriangle className="h-4 w-4 text-red-500" /> Failed Reminders
        </h2>
        <button onClick={() => onNavigate('/reminders')} className="text-xs text-muted-foreground hover:text-primary">Manage →</button>
      </div>
      <div className="divide-y">
        {isLoading ? Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 p-4">
            <Skeleton className="h-9 w-9 rounded-full" />
            <div className="flex-1 space-y-1.5"><Skeleton className="h-4 w-2/3" /><Skeleton className="h-3 w-1/3" /></div>
          </div>
        )) : failed.length === 0 ? (
          <div className="p-8 text-center">
            <div className="flex justify-center mb-2">
              <Zap className="h-6 w-6 text-emerald-500" />
            </div>
            <div className="text-sm font-medium text-emerald-700 dark:text-emerald-400">All reminders delivered!</div>
            <div className="text-xs text-muted-foreground mt-1">No failures to report.</div>
          </div>
        ) : failed.map(r => (
          <button key={r.id} onClick={() => r.customer && onNavigate(`/customers/${r.customer.id}`)}
            className="flex w-full items-center gap-3 p-4 text-left transition-colors hover:bg-muted/40">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-red-100 text-red-600 dark:bg-red-900/30">
              <AlertTriangle className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold truncate">{r.customer?.name ?? '—'}</div>
              <div className="text-xs text-muted-foreground">
                {r.template?.name ?? '—'} · {r.variables?.medicine ?? ''}
              </div>
            </div>
            <div className="text-right text-xs text-muted-foreground shrink-0">
              {new Date(r.scheduled_for).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
            </div>
          </button>
        ))}
      </div>
    </Card>
  );
}

export default function Dashboard() {
  const t = useT();
  const { pharmacyId, pharmacyName } = useActivePharmacy();
  const navigate = useNavigate();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [composeFor, setComposeFor] = useState<CustomerWithStats | null>(null);

  const { data: health } = useQuery({
    queryKey: ['whatsapp-health', pharmacyId],
    queryFn: () => getWhatsAppHealth(pharmacyId),
    enabled: !!pharmacyId,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const { data: counts } = useQuery({
    queryKey: ['dashboard-counts', pharmacyId],
    enabled: !!pharmacyId,
    staleTime: 60_000,
    queryFn: async () => {
      const now = new Date();
      const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
      const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const next7Days = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

      const [
        customers, customersThisWeek,
        todayPending, todaySent,
        visitsMonth,
        chronic,
        upcoming,
      ] = await Promise.all([
        // 1. Total customers
        supabase.from('crm_customers').select('id', { count: 'exact', head: true })
          .eq('pharmacy_id', pharmacyId),
        // 2. New customers this week (for "+X this week" subtitle)
        supabase.from('crm_customers').select('id', { count: 'exact', head: true })
          .eq('pharmacy_id', pharmacyId).gte('created_at', sevenDaysAgo),
        // 3a. Today's reminders — pending
        supabase.from('crm_scheduled_reminders').select('id', { count: 'exact', head: true })
          .eq('pharmacy_id', pharmacyId).eq('status', 'pending')
          .gte('scheduled_for', startOfToday).lt('scheduled_for', endOfToday),
        // 3b. Today's reminders — sent
        supabase.from('crm_scheduled_reminders').select('id', { count: 'exact', head: true })
          .eq('pharmacy_id', pharmacyId).eq('status', 'sent')
          .gte('sent_at', startOfToday).lt('sent_at', endOfToday),
        // 4. Visits this month (sales count, each sale = a visit)
        supabase.from('crm_customer_sales').select('id', { count: 'exact', head: true })
          .eq('pharmacy_id', pharmacyId).gte('sold_at', startOfMonth),
        // 5. Chronic patients (manual tag)
        supabase.from('crm_tags').select('id', { count: 'exact', head: true })
          .eq('pharmacy_id', pharmacyId).eq('tag_key', 'chronic'),
        // 6. Upcoming reminders next 7 days (still used by the right rail counter)
        supabase.from('crm_scheduled_reminders').select('id', { count: 'exact', head: true })
          .eq('pharmacy_id', pharmacyId).eq('status', 'pending')
          .lte('scheduled_for', next7Days),
      ]);

      const total = customers.count ?? 0;
      const chronicCount = chronic.count ?? 0;
      return {
        totalCustomers: total,
        thisWeek: customersThisWeek.count ?? 0,
        todayPending: todayPending.count ?? 0,
        todaySent: todaySent.count ?? 0,
        todayTotal: (todayPending.count ?? 0) + (todaySent.count ?? 0),
        visitsMonth: visitsMonth.count ?? 0,
        chronicCount,
        chronicPercent: total > 0 ? Math.round((chronicCount / total) * 100) : 0,
        upcomingReminders: upcoming.count ?? 0,
      };
    },
  });

  interface UpcomingRow {
    id: string;
    scheduled_for: string;
    status: string;
    customer: { id: string; name: string; phone: string };
    template: { name: string };
  }

  const { data: upcoming, isLoading: loadingReminders } = useQuery<UpcomingRow[]>({
    queryKey: ['upcoming-reminders', pharmacyId],
    enabled: !!pharmacyId,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('crm_scheduled_reminders')
        .select(`
          id, scheduled_for, status, variables,
          customer:crm_customers!inner(id, name, phone),
          template:crm_templates!inner(name)
        `)
        .eq('pharmacy_id', pharmacyId)
        .eq('status', 'pending')
        .order('scheduled_for')
        .limit(8);
      if (error) throw error;
      return (data ?? []) as unknown as UpcomingRow[];
    },
  });

  const greeting = pharmacyName;
  const hour = new Date().getHours();
  const greetingPrefix = hour < 12 ? t('dash.greeting_morning') : hour < 17 ? t('dash.greeting_afternoon') : t('dash.greeting_evening');
  const subtitleText = counts
    ? t('dash.subtitle_template')
        .replace('{count}', String(counts.totalCustomers))
        .replace('{reminders}', String(counts.upcomingReminders))
    : '—';

  return (
    <div className="space-y-8">
      {/* Header */}
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs text-muted-foreground">
            {new Intl.DateTimeFormat('en-IN', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date())}
          </p>
          <h1 className="mt-1 text-3xl font-bold tracking-tight">{greetingPrefix}, {greeting}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{subtitleText}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="lg" onClick={() => setPickerOpen(true)}>
            <Send className="h-4 w-4" />
            {t('btn.new_message')}
          </Button>
          <Button variant="outline" size="lg" onClick={() => navigate('/campaigns')}>
            <Megaphone className="h-4 w-4" />
            {t('btn.new_campaign')}
          </Button>
          <Button size="lg" onClick={() => navigate('/rx')} className="gap-2 bg-primary">
            <ClipboardList className="h-4 w-4" />
            Quick Rx
          </Button>
        </div>
      </header>

      {/* Stat tiles — compact icon-led layout, palette from legacy medcrm-app */}
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label={t('dash.kpi.customers')}
          value={counts?.totalCustomers != null ? counts.totalCustomers.toLocaleString() : '—'}
          sub={`+${counts?.thisWeek ?? 0} ${t('dash.this_week')}`}
          icon={Users}
          dotColor={TILE_COLORS.greenDot}
          onClick={() => navigate('/customers')}
          delay={0}
        />
        <StatTile
          label={t('dash.kpi.today_reminders')}
          value={counts?.todayTotal ?? '—'}
          sub={`${counts?.todaySent ?? 0} ${t('dash.sent')} · ${counts?.todayPending ?? 0} ${t('dash.pending')}`}
          icon={BellRing}
          dotColor={TILE_COLORS.orangeDot}
          valueColor={TILE_COLORS.orangeDot}
          onClick={() => navigate('/reminders')}
          delay={0.04}
        />
        <StatTile
          label={t('dash.kpi.visits_month')}
          value={counts?.visitsMonth != null ? counts.visitsMonth.toLocaleString() : '—'}
          sub={t('dash.total_visits')}
          icon={ActivityIcon}
          dotColor={TILE_COLORS.purpleDot}
          onClick={() => navigate('/activity')}
          delay={0.08}
        />
        <StatTile
          label={t('dash.kpi.chronic')}
          value={counts?.chronicCount ?? '—'}
          sub={`${counts?.chronicPercent ?? 0}% ${t('dash.of_total')}`}
          icon={HeartPulse}
          dotColor={TILE_COLORS.coralDot}
          valueColor={TILE_COLORS.coralDot}
          onClick={() => navigate('/customers?segment=chronic')}
          delay={0.12}
        />
      </section>

      {/* Two-col: upcoming + health */}
      <div className="grid gap-4 lg:grid-cols-[1.5fr_1fr]">
        <Card>
          <div className="flex items-center justify-between border-b px-5 py-4">
            <h2 className="text-base font-semibold">{t('dash.upcoming.title')}</h2>
            <Button variant="ghost" size="sm" onClick={() => navigate('/reminders')}>
              {t('btn.view_all')} →
            </Button>
          </div>
          <div className="divide-y">
            {loadingReminders ? (
              Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex items-center gap-4 p-4">
                  <Skeleton className="h-10 w-10 rounded-full" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-2/3" />
                    <Skeleton className="h-3 w-1/3" />
                  </div>
                </div>
              ))
            ) : upcoming && upcoming.length > 0 ? (
              upcoming.map((row) => (
                <button
                  key={row.id}
                  onClick={() => navigate(`/customers/${row.customer.id}`)}
                  className="flex w-full items-center gap-4 p-4 text-left transition-colors hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none"
                >
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted">
                    {row.variables?.channel === 'whatsapp' ? <MessageSquare className="h-4 w-4 text-emerald-600" />
                      : row.variables?.channel === 'sms' ? <Smartphone className="h-4 w-4 text-blue-600" />
                      : row.variables?.channel === 'call' ? <PhoneCall className="h-4 w-4 text-amber-600" />
                      : <BellRing className="h-4 w-4 text-muted-foreground" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold">{row.customer.name}</div>
                    <div className="text-xs text-muted-foreground truncate">
                      {row.variables?.medicine || 'Reminder'} · {row.template.name}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-xs font-semibold">
                      {new Date(row.scheduled_for).toLocaleString('en-IN', {
                        day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
                      })}
                    </div>
                    <div className="text-[11px] text-muted-foreground">{row.template.name}</div>
                  </div>
                </button>
              ))
            ) : (
              <div className="p-8 text-center text-sm text-muted-foreground">{t('dash.upcoming.empty')}</div>
            )}
          </div>
        </Card>

        <Card className="p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-base font-semibold">{t('dash.health.title')}</h2>
            <span className="text-[11px] text-muted-foreground">{t('dash.health.live')}</span>
          </div>
          {health ? (
            <div className="space-y-5">
              <RateMeter
                current={health.sends_last_hour}
                cap={health.rate_limit_per_hour}
                windowStart={health.send_window_start}
                windowEnd={health.send_window_end}
              />
              <div className="space-y-2 border-t pt-4">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">{t('dash.health.bounce')}</span>
                  <span className={
                    (health.bounce_rate_24h ?? 0) > 5 ? 'font-semibold text-destructive' : 'font-semibold text-emerald-700'
                  }>
                    {health.bounce_rate_24h != null ? `${health.bounce_rate_24h.toFixed(1)}%` : '—'}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">{t('dash.health.opt_outs')}</span>
                  <span className="font-semibold text-emerald-700">
                    {health.total_customers > 0
                      ? `${((health.opt_outs_30d / health.total_customers) * 100).toFixed(1)}%`
                      : '—'}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-2 border-t pt-4 text-xs text-muted-foreground">
                <TrendingUp className="h-3.5 w-3.5" />
                {t('dash.health.window')} {health.send_window_start.slice(0, 5)} – {health.send_window_end.slice(0, 5)} IST
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-2 w-full" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          )}
        </Card>
      </div>

      {/* Bottom row: recent prescriptions + failed reminders */}
      <div className="grid gap-4 lg:grid-cols-2">
        {/* Recent Prescriptions */}
        <RecentPrescriptions pharmacyId={pharmacyId} onNavigate={navigate} />
        {/* Failed Reminders */}
        <FailedReminders pharmacyId={pharmacyId} onNavigate={navigate} />
      </div>

      {/* "New message" flow: pick a customer → open compose drawer */}
      <CustomerPickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onPick={(c) => {
          setPickerOpen(false);
          setComposeFor(c);
        }}
      />
      {composeFor && (
        <ComposeDrawer
          open={!!composeFor}
          onClose={() => setComposeFor(null)}
          customer={{
            id: composeFor.id,
            name: composeFor.name,
            phone: composeFor.phone,
            whatsapp_opted_in: composeFor.whatsapp_opted_in,
          }}
        />
      )}
    </div>
  );
}
