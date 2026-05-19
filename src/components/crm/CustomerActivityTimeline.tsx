/**
 * Per-customer activity timeline.
 * Unifies 5 event types (messages, bills, visit notes, prescriptions, refills)
 * into a date-grouped, filterable, richly-detailed feed.
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import {
  MessageCircle, ArrowUpRight, ArrowDownLeft, ShoppingBag, NotebookPen, FileText,
  RefreshCcw, CheckCheck, Check, Clock, AlertCircle, Pill, Stethoscope, Receipt,
  Activity as ActivityIcon, IndianRupee, Inbox, Paperclip,
} from 'lucide-react';
import { useT } from '@/contexts/LanguageContext';
import type { TranslationKey } from '@/i18n/translations';
import { supabase } from '@/lib/supabase';
import { listVisitNotes, type VisitNote } from '@/lib/api/visitNotes';
import {
  listPrescriptions, type PrescriptionWithMeds, type PrescriptionRefill,
} from '@/lib/api/prescriptions';
import { cn, formatINR, formatDateTime } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';
import { Card } from '@/components/ui/card';
import type { MessageStatus } from '@/types/database';

interface MsgEvent {
  id: string; body: string; status: MessageStatus; direction: 'outbound' | 'inbound';
  sent_at: string | null; created_at: string;
  template?: { name: string } | null;
}
interface BillEvent {
  id: string; sale_id: string; bill_amount: number; sold_at: string;
  medicines: unknown;
  attachment_url?: string | null;
}

type Kind = 'msg' | 'bill' | 'note' | 'rx' | 'refill';

type TimelineEvent =
  | { type: 'msg';    at: string; data: MsgEvent }
  | { type: 'bill';   at: string; data: BillEvent }
  | { type: 'note';   at: string; data: VisitNote }
  | { type: 'rx';     at: string; data: PrescriptionWithMeds }
  | { type: 'refill'; at: string; data: PrescriptionRefill & { medicine_name?: string } };

type Filter = 'all' | Kind;

const FILTERS: { key: Filter; labelKey: TranslationKey; icon: typeof MessageCircle }[] = [
  { key: 'all',    labelKey: 'profile.activity.filter.all',    icon: ActivityIcon },
  { key: 'bill',   labelKey: 'profile.activity.filter.bill',   icon: ShoppingBag },
  { key: 'msg',    labelKey: 'profile.activity.filter.msg',    icon: MessageCircle },
  { key: 'rx',     labelKey: 'profile.activity.filter.rx',     icon: FileText },
  { key: 'refill', labelKey: 'profile.activity.filter.refill', icon: RefreshCcw },
  { key: 'note',   labelKey: 'profile.activity.filter.note',   icon: NotebookPen },
];

export function CustomerActivityTimeline({ customerId }: { customerId: string }) {
  const t = useT();
  const [filter, setFilter] = useState<Filter>('all');

  const { data: events = [], isLoading } = useQuery<TimelineEvent[]>({
    queryKey: ['customer-activity', customerId],
    enabled: !!customerId,
    staleTime: 30_000,
    queryFn: async () => {
      // Run all customer-scoped fetches in parallel. Medicines lookup is
      // deferred to a second step so we only fetch the rows we actually need.
      const [msgs, sales, notes, rxs, refills] = await Promise.all([
        supabase
          .from('crm_messages')
          .select('id, body, status, direction, sent_at, created_at, template:crm_templates(name)')
          .eq('customer_id', customerId)
          .order('created_at', { ascending: false })
          .limit(40),
        supabase
          .from('crm_customer_sales')
          .select('id, sale_id, bill_amount, sold_at, medicines, attachment_url')
          .eq('customer_id', customerId)
          .order('sold_at', { ascending: false })
          .limit(40),
        listVisitNotes(customerId),
        listPrescriptions(customerId),
        supabase
          .from('crm_prescription_refills')
          .select('*')
          .eq('customer_id', customerId)
          .order('refilled_at', { ascending: false })
          .limit(40),
      ]);

      // Medicine-name lookup ONLY for the refills we actually have — avoids
      // pulling the entire crm_prescription_medicines table just to map IDs.
      const refillRows = (refills.data ?? []) as unknown as PrescriptionRefill[];
      const medIds = Array.from(new Set(refillRows.map((r) => r.medicine_id)));
      const medMap = new Map<string, string>();
      if (medIds.length > 0) {
        const { data: medRows, error: medErr } = await supabase
          .from('crm_prescription_medicines')
          .select('id, medicine_name')
          .in('id', medIds);
        if (medErr) {
          console.warn('[timeline] medicine name lookup failed:', medErr.message);
        } else {
          ((medRows ?? []) as unknown as { id: string; medicine_name: string }[])
            .forEach((m) => medMap.set(m.id, m.medicine_name));
        }
      }

      const out: TimelineEvent[] = [];
      ((msgs.data ?? []) as unknown as MsgEvent[]).forEach((m) =>
        out.push({ type: 'msg', at: m.created_at, data: m })
      );
      ((sales.data ?? []) as unknown as BillEvent[]).forEach((s) =>
        out.push({ type: 'bill', at: s.sold_at, data: s })
      );
      notes.forEach((n) => out.push({ type: 'note', at: n.created_at, data: n }));
      rxs.forEach((r) => out.push({ type: 'rx', at: r.created_at, data: r }));
      refillRows.forEach((r) =>
        out.push({
          type: 'refill',
          at: r.refilled_at,
          data: { ...r, medicine_name: medMap.get(r.medicine_id) },
        })
      );
      return out.sort((a, b) => b.at.localeCompare(a.at));
    },
  });

  // Counts for each filter — shown as small badges on the chips.
  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: events.length, msg: 0, bill: 0, note: 0, rx: 0, refill: 0 };
    events.forEach((e) => { c[e.type] += 1; });
    return c;
  }, [events]);

  const filtered = filter === 'all' ? events : events.filter((e) => e.type === filter);
  const groups = useMemo(() => groupByDate(filtered), [filtered]);

  return (
    <section>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <ActivityIcon className="h-4 w-4 text-primary" />
          {t('profile.activity')}
          <span className="font-mono text-xs text-muted-foreground">{events.length}</span>
        </h2>
      </div>

      {/* Filter chips */}
      <div className="mb-4 flex flex-wrap gap-1.5">
        {FILTERS.map((f) => {
          const Icon = f.icon;
          const active = filter === f.key;
          const count = counts[f.key];
          return (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
                active
                  ? 'border-foreground bg-foreground text-background'
                  : 'border-border bg-background text-muted-foreground hover:bg-accent hover:text-foreground'
              )}
            >
              <Icon className="h-3 w-3" />
              {t(f.labelKey)}
              <span className={cn(
                'rounded-full px-1.5 py-px text-[10px] font-mono',
                active ? 'bg-background/20 text-background' : 'bg-muted text-muted-foreground'
              )}>
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {isLoading ? (
        <Card className="space-y-3 p-4">
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
        </Card>
      ) : filtered.length === 0 ? (
        <EmptyTimeline filter={filter} onClear={() => setFilter('all')} />
      ) : (
        <div className="space-y-5">
          {groups.map((g) => (
            <DateGroup key={g.key} group={g} />
          ))}
        </div>
      )}
    </section>
  );
}

// ─── Date group ─────────────────────────────────────────────────────────────

interface Group {
  key: string;
  labelKey?: TranslationKey;
  rows: TimelineEvent[];
}

function DateGroup({ group }: { group: Group }) {
  const t = useT();
  return (
    <div>
      <div className="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        <span>{group.labelKey ? t(group.labelKey) : group.key}</span>
        <span className="font-mono text-foreground/60">{group.rows.length}</span>
        <span className="h-px flex-1 bg-border" />
      </div>
      <Card className="divide-y overflow-hidden">
        {group.rows.map((e, i) => (
          <EventRow key={`${e.type}-${i}-${e.at}`} event={e} delay={i * 0.015} />
        ))}
      </Card>
    </div>
  );
}

// ─── Individual event row ───────────────────────────────────────────────────

function EventRow({ event, delay }: { event: TimelineEvent; delay: number }) {
  const t = useT();
  const time = new Date(event.at).toLocaleTimeString('en-IN', {
    hour: 'numeric', minute: '2-digit',
  });

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.16, delay }}
      className="flex items-start gap-3 p-3 transition-colors hover:bg-muted/30"
    >
      <EventIcon type={event.type} />
      <div className="min-w-0 flex-1">
        {event.type === 'msg'    && <MsgBody    data={event.data} />}
        {event.type === 'bill'   && <BillBody   data={event.data} />}
        {event.type === 'note'   && <NoteBody   data={event.data} />}
        {event.type === 'rx'     && <RxBody     data={event.data} />}
        {event.type === 'refill' && <RefillBody data={event.data} />}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <span className="font-mono text-[10px] text-muted-foreground">{time}</span>
        <span
          className="font-mono text-[9.5px] text-muted-foreground/60"
          title={formatDateTime(event.at)}
        >
          {t(`profile.activity.kind.${event.type}` as TranslationKey)}
        </span>
      </div>
    </motion.div>
  );
}

function EventIcon({ type }: { type: Kind }) {
  const colorMap: Record<Kind, string> = {
    msg:    'bg-sky-500/10 text-sky-700 dark:text-sky-300 ring-sky-500/20',
    bill:   'bg-primary/10 text-primary ring-primary/20',
    note:   'bg-amber-500/10 text-amber-700 dark:text-amber-300 ring-amber-500/20',
    rx:     'bg-violet-500/10 text-violet-700 dark:text-violet-300 ring-violet-500/20',
    refill: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 ring-emerald-500/20',
  };
  const IconMap = {
    msg: MessageCircle, bill: ShoppingBag, note: NotebookPen,
    rx: FileText, refill: RefreshCcw,
  };
  const I = IconMap[type];
  return (
    <span className={cn(
      'flex h-9 w-9 shrink-0 items-center justify-center rounded-full ring-1',
      colorMap[type]
    )}>
      <I className="h-4 w-4" />
    </span>
  );
}

// ─── Per-event-type bodies ─────────────────────────────────────────────────

function MsgBody({ data }: { data: MsgEvent }) {
  const t = useT();
  const isOutbound = data.direction === 'outbound';
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="inline-flex items-center gap-1 font-semibold">
          {isOutbound
            ? <><ArrowUpRight className="h-3 w-3 text-primary" /> {t('profile.message_sent')}</>
            : <><ArrowDownLeft className="h-3 w-3 text-emerald-600" /> {t('profile.message_received')}</>}
        </span>
        {data.template?.name && (
          <span className="rounded bg-muted px-1.5 py-px font-mono text-[10px] text-muted-foreground">
            {data.template.name}
          </span>
        )}
        <MsgStatusBadge status={data.status} />
      </div>
      <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{data.body}</p>
    </>
  );
}

function MsgStatusBadge({ status }: { status: MessageStatus }) {
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
  const labelKey: TranslationKey = `activity.status.${status}` as TranslationKey;
  return (
    <span className={cn(
      'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider',
      tone
    )}>
      <Icon className="h-2.5 w-2.5" />
      {t(labelKey)}
    </span>
  );
}

function BillBody({ data }: { data: BillEvent }) {
  const t = useT();
  const meds = Array.isArray(data.medicines)
    ? (data.medicines as { name?: string; qty?: number }[])
    : [];
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 text-sm font-semibold">
        <Receipt className="h-3.5 w-3.5 text-primary" />
        {t('profile.bill')}
        <span className="inline-flex items-center font-mono text-primary">
          <IndianRupee className="h-3 w-3" />
          {formatINR(data.bill_amount).replace('₹', '')}
        </span>
        <span className="font-mono text-[10px] text-muted-foreground">
          #{data.sale_id.slice(0, 8)}
        </span>
        {data.attachment_url && <AttachmentLink url={data.attachment_url} />}
      </div>
      {meds.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {meds.slice(0, 6).map((m, i) => (
            <span
              key={i}
              className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary"
            >
              <Pill className="h-2.5 w-2.5" />
              {m.name ?? '—'}
              {m.qty && <span className="opacity-60">×{m.qty}</span>}
            </span>
          ))}
          {meds.length > 6 && (
            <span className="text-[11px] text-muted-foreground">+{meds.length - 6}</span>
          )}
        </div>
      )}
    </>
  );
}

function NoteBody({ data }: { data: VisitNote }) {
  const t = useT();
  return (
    <>
      <div className="flex items-center gap-1.5 text-sm font-semibold">
        <NotebookPen className="h-3.5 w-3.5 text-amber-600" />
        {t('visit.timeline_label')}
      </div>
      <p className="mt-0.5 whitespace-pre-wrap text-sm text-foreground/90">{data.note}</p>
      {data.medicines.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {data.medicines.map((m) => (
            <span
              key={m}
              className="inline-flex items-center gap-1 rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300"
            >
              <Pill className="h-2.5 w-2.5" />
              {m}
            </span>
          ))}
        </div>
      )}
    </>
  );
}

function RxBody({ data }: { data: PrescriptionWithMeds }) {
  const t = useT();
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="inline-flex items-center gap-1 font-semibold">
          <FileText className="h-3.5 w-3.5 text-violet-600" />
          {t('rx.timeline_label')}
        </span>
        {data.doctor_name && (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <Stethoscope className="h-3 w-3" />
            Dr. {data.doctor_name}
          </span>
        )}
        {data.follow_up_date && (
          <span className="inline-flex items-center rounded-md bg-amber-500/10 px-1.5 py-px text-[10px] font-medium text-amber-700 dark:text-amber-300">
            {t('rx.follow_up')}: {new Date(data.follow_up_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
          </span>
        )}
        {data.attachment_url && <AttachmentLink url={data.attachment_url} />}
      </div>
      {data.diagnosis && (
        <div className="mt-0.5 text-xs text-muted-foreground">{data.diagnosis}</div>
      )}
      {data.medicines.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {data.medicines.map((m) => (
            <span
              key={m.id}
              className="inline-flex items-center gap-1 rounded-md bg-violet-500/10 px-1.5 py-0.5 text-[11px] font-medium text-violet-700 dark:text-violet-300"
            >
              <Pill className="h-2.5 w-2.5" />
              {m.medicine_name}
              {m.strength && <span className="opacity-60">· {m.strength}</span>}
              {m.dosage && <span className="opacity-60">· {m.dosage}</span>}
            </span>
          ))}
        </div>
      )}
    </>
  );
}

function RefillBody({ data }: { data: PrescriptionRefill & { medicine_name?: string } }) {
  const t = useT();
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="inline-flex items-center gap-1 font-semibold">
          <RefreshCcw className="h-3.5 w-3.5 text-emerald-600" />
          {t('profile.activity.refill_label')}
        </span>
        {data.medicine_name && (
          <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
            <Pill className="h-2.5 w-2.5" />
            {data.medicine_name}
          </span>
        )}
        {data.quantity_dispensed != null && (
          <span className="text-xs text-muted-foreground">×{data.quantity_dispensed}</span>
        )}
        {data.bill_amount != null && (
          <span className="inline-flex items-center font-mono text-xs text-primary">
            <IndianRupee className="h-3 w-3" />
            {formatINR(data.bill_amount).replace('₹', '')}
          </span>
        )}
      </div>
      {data.notes && (
        <p className="mt-0.5 line-clamp-2 text-xs italic text-muted-foreground">{data.notes}</p>
      )}
    </>
  );
}

function AttachmentLink({ url }: { url: string }) {
  const t = useT();
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="inline-flex items-center gap-1 rounded-md bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-sky-700 hover:bg-sky-500/20 dark:text-sky-300"
      title={url}
    >
      <Paperclip className="h-2.5 w-2.5" />
      {t('add_bill.attachment_view')}
    </a>
  );
}

function EmptyTimeline({ filter, onClear }: { filter: Filter; onClear: () => void }) {
  const t = useT();
  const isFiltered = filter !== 'all';
  return (
    <Card className="flex flex-col items-center justify-center gap-3 py-12 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
        <Inbox className="h-5 w-5 text-muted-foreground" />
      </div>
      <div>
        <div className="text-sm font-semibold">
          {isFiltered ? t('profile.activity.empty_filtered') : t('profile.no_activity')}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {isFiltered ? t('profile.activity.empty_filtered_hint') : t('profile.activity.empty_all_hint')}
        </p>
      </div>
      {isFiltered && (
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

// ─── Helpers ───────────────────────────────────────────────────────────────

function groupByDate(rows: TimelineEvent[]): Group[] {
  if (rows.length === 0) return [];
  const today = startOfDay(new Date());
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  const sevenDaysAgo = new Date(today); sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  const buckets: { today: TimelineEvent[]; yesterday: TimelineEvent[]; week: TimelineEvent[] } = {
    today: [], yesterday: [], week: [],
  };
  const older = new Map<string, TimelineEvent[]>();

  for (const r of rows) {
    const d = startOfDay(new Date(r.at));
    if (d.getTime() === today.getTime()) buckets.today.push(r);
    else if (d.getTime() === yesterday.getTime()) buckets.yesterday.push(r);
    else if (d > sevenDaysAgo) buckets.week.push(r);
    else {
      const k = d.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
      const arr = older.get(k) ?? [];
      arr.push(r);
      older.set(k, arr);
    }
  }

  const out: Group[] = [];
  if (buckets.today.length)     out.push({ key: 'today',     labelKey: 'activity.group.today',     rows: buckets.today });
  if (buckets.yesterday.length) out.push({ key: 'yesterday', labelKey: 'activity.group.yesterday', rows: buckets.yesterday });
  if (buckets.week.length)      out.push({ key: 'thisweek',  labelKey: 'activity.group.this_week', rows: buckets.week });
  for (const [k, arr] of older) out.push({ key: k, rows: arr });
  return out;
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
