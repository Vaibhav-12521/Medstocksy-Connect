import { useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { motion } from 'framer-motion';
import {
  Send, Edit2, ChevronLeft, Stethoscope, NotebookPen, FileText,
  Copy, Trash2, Loader2, RefreshCcw,
} from 'lucide-react';
import { useActivePharmacy } from '@/contexts/PharmacyContext';
import { useT } from '@/contexts/LanguageContext';
import { getCustomer, listManualTags, addTag, removeTag, setOptOut, setOptIn } from '@/lib/api/customers';
import {
  listPrescriptions, deletePrescription, renewPrescription,
  type PrescriptionWithMeds, type MedicineWithRefills,
} from '@/lib/api/prescriptions';
import { formatINR, initials, relativeTime, formatDateTime, cn } from '@/lib/utils';
import { Tag } from '@/components/ui/tag';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ComposeDrawer } from '@/components/crm/ComposeDrawer';
import { CustomerFormDialog } from '@/components/crm/CustomerFormDialog';
import { VisitNoteDialog } from '@/components/crm/VisitNoteDialog';
import { PrescriptionDialog } from '@/components/crm/PrescriptionDialog';
import { RefillDialog } from '@/components/crm/RefillDialog';
import { BatchRefillDialog } from '@/components/crm/BatchRefillDialog';
import { CustomerActivityTimeline } from '@/components/crm/CustomerActivityTimeline';

export default function CustomerProfile() {
  const t = useT();
  const { id } = useParams<{ id: string }>();
  const { pharmacyId } = useActivePharmacy();
  const qc = useQueryClient();
  const [composeOpen, setComposeOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [rxOpen, setRxOpen] = useState(false);
  const [editingRx, setEditingRx] = useState<PrescriptionWithMeds | null>(null);
  const [batchRefillRx, setBatchRefillRx] = useState<PrescriptionWithMeds | null>(null);
  const [refillMed, setRefillMed] = useState<{ med: MedicineWithRefills; rxId: string } | null>(null);

  const { data: customer, isLoading } = useQuery({
    queryKey: ['customer', id],
    enabled: !!id,
    queryFn: () => getCustomer(id!),
  });

  const { data: manualTags = [] } = useQuery<string[]>({
    queryKey: ['customer-tags', id],
    enabled: !!id,
    queryFn: () => listManualTags(id!),
  });

  const isChronic = manualTags.includes('chronic');

  const toggleChronic = useMutation({
    mutationFn: async () => {
      if (isChronic) await removeTag(id!, 'chronic');
      else await addTag(pharmacyId, id!, 'chronic');
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['customer-tags', id] });
      qc.invalidateQueries({ queryKey: ['customer', id] });
      qc.invalidateQueries({ queryKey: ['customers'] });
      qc.invalidateQueries({ queryKey: ['dashboard-counts'] });
    },
  });

  const { data: prescriptions = [] } = useQuery<PrescriptionWithMeds[]>({
    queryKey: ['prescriptions', id],
    enabled: !!id,
    queryFn: () => listPrescriptions(id!),
  });

  const toggleOptIn = useMutation<void, Error>({
    mutationFn: async () => {
      const c = customer;
      if (!c) throw new Error('Customer not loaded');
      if (c.whatsapp_opted_in) {
        // Opting OUT — compliance per Rule 9 wants a reason on file.
        const reason = window.prompt(t('profile.optout_reason_prompt')) ?? '';
        // Empty/null means user dismissed the prompt → abort.
        if (reason === '' && !window.confirm(t('profile.optout_no_reason_confirm'))) {
          throw new Error('cancelled');
        }
        await setOptOut(c.id, reason || undefined);
      } else {
        // Re-activating — simple confirm.
        if (!window.confirm(t('profile.optin_confirm'))) {
          throw new Error('cancelled');
        }
        await setOptIn(c.id);
      }
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['customer', id] });
      await qc.invalidateQueries({ queryKey: ['customers'] });
    },
  });

  const renew = useMutation({
    mutationFn: (rxId: string) => renewPrescription(rxId),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['prescriptions', id] });
      await qc.invalidateQueries({ queryKey: ['customer-activity', id] });
      await qc.invalidateQueries({ queryKey: ['customer', id] });
    },
  });

  const remove = useMutation({
    mutationFn: (rxId: string) => deletePrescription(rxId),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['prescriptions', id] });
      await qc.invalidateQueries({ queryKey: ['customer-activity', id] });
      await qc.invalidateQueries({ queryKey: ['customer', id] });
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-12 w-72" />
        <Skeleton className="h-32" />
      </div>
    );
  }

  if (!customer) {
    return (
      <div className="rounded-lg border bg-muted/30 p-8 text-center">
        <p className="text-sm text-muted-foreground">Customer not found.</p>
        <Link to="/customers" className="mt-2 inline-block text-sm font-medium text-primary hover:underline">
          ← Back to customers
        </Link>
      </div>
    );
  }

  // Suppress unused warning for pharmacyId; used by ComposeDrawer via context.
  void pharmacyId;

  return (
    <div className="space-y-8">
      {/* Breadcrumb */}
      <Link
        to="/customers"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="h-4 w-4" /> {t('profile.back')}
      </Link>

      {/* Hero */}
      <motion.header
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex flex-wrap items-end justify-between gap-4"
      >
        <div className="flex items-center gap-5">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-tag-high-bg text-xl font-bold text-tag-high-fg">
            {initials(customer.name)}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-3xl font-bold tracking-tight">{customer.name}</h1>
              <button
                type="button"
                onClick={() => toggleOptIn.mutate()}
                disabled={toggleOptIn.isPending}
                title={customer.whatsapp_opted_in
                  ? t('profile.click_to_optout')
                  : t('profile.click_to_optin')}
                aria-label={customer.whatsapp_opted_in
                  ? t('profile.click_to_optout')
                  : t('profile.click_to_optin')}
                className={cn(
                  'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-bold uppercase tracking-wider transition-opacity',
                  'hover:opacity-80 disabled:opacity-60',
                  customer.whatsapp_opted_in
                    ? 'bg-tag-repeat-bg text-tag-repeat-fg'
                    : 'bg-tag-optout-bg text-tag-optout-fg'
                )}
              >
                <span
                  className={cn(
                    'h-1.5 w-1.5 rounded-full',
                    customer.whatsapp_opted_in ? 'bg-tag-repeat-fg' : 'bg-tag-optout-fg'
                  )}
                  aria-hidden
                />
                {toggleOptIn.isPending
                  ? '…'
                  : customer.whatsapp_opted_in
                    ? t('profile.active')
                    : t('profile.opted_out')}
              </button>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
              <span className="font-mono">{customer.phone}</span>
              {customer.age && <span>· {customer.age}{customer.gender ? ` · ${customer.gender}` : ''}</span>}
              <span>· Customer since {formatDateTime(customer.created_at).split('·')[0]}</span>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              {customer.auto_tags.map((tg) => <Tag key={tg} tag={tg} />)}
              {/* Chronic — interactive manual tag chip */}
              <button
                type="button"
                onClick={() => toggleChronic.mutate()}
                disabled={toggleChronic.isPending}
                aria-pressed={isChronic}
                title={isChronic ? t('cust.chronic_remove_hint') : t('cust.chronic_add_hint')}
                className={cn(
                  'inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider transition-all',
                  'hover:opacity-80 disabled:opacity-60',
                  isChronic
                    ? 'bg-tag-chronic-bg text-tag-chronic-fg ring-1 ring-tag-chronic-fg/30'
                    : 'border border-dashed border-muted-foreground/30 text-muted-foreground hover:border-tag-chronic-fg/40 hover:text-tag-chronic-fg'
                )}
              >
                <Stethoscope className="h-3 w-3" />
                {toggleChronic.isPending
                  ? '…'
                  : isChronic ? t('customers.tag.chronic') : t('cust.chronic_add')}
              </button>
            </div>
          </div>
        </div>
        {/* Action buttons: 2-col grid on phones (each fills half-width), inline on sm+. */}
        <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:flex-wrap">
          <Button variant="outline" onClick={() => setEditOpen(true)} className="min-w-0">
            <Edit2 className="h-4 w-4" />
            <span className="truncate">{t('btn.edit')}</span>
          </Button>
          <Button variant="outline" onClick={() => setNoteOpen(true)} className="min-w-0">
            <NotebookPen className="h-4 w-4" />
            <span className="truncate">{t('visit.add_button')}</span>
          </Button>
          <Button variant="outline" onClick={() => { setEditingRx(null); setRxOpen(true); }} className="min-w-0">
            <FileText className="h-4 w-4" />
            <span className="truncate">{t('rx.add_button')}</span>
          </Button>
          <Button onClick={() => setComposeOpen(true)} disabled={!customer.whatsapp_opted_in} className="min-w-0">
            <Send className="h-4 w-4" />
            <span className="truncate">{t('btn.send_message')}</span>
          </Button>
        </div>
      </motion.header>

      {/* Stat strip */}
      <section className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl bg-border md:grid-cols-4">
        <div className="bg-background p-5">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{t('profile.last_visit')}</div>
          <div className="mt-1 text-xl font-bold">
            {customer.stats?.last_visit_at ? relativeTime(customer.stats.last_visit_at) : '—'}
          </div>
          {!customer.stats?.last_visit_at && (
            <div className="mt-1 text-xs text-muted-foreground">{t('profile.no_data')}</div>
          )}
        </div>
        <div className="bg-background p-5">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{t('profile.lifetime_spend')}</div>
          <div className="mt-1 font-mono text-xl font-bold">
            {customer.stats ? formatINR(customer.stats.lifetime_value) : '—'}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {customer.stats?.visit_count ?? 0} {t('profile.visits')}
          </div>
        </div>
        <div className="bg-background p-5">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{t('profile.frequency')}</div>
          <div className="mt-1 text-xl font-bold">
            {customer.stats?.avg_days_between_visits != null
              ? t('profile.every_n_days').replace('{n}', String(customer.stats.avg_days_between_visits))
              : '—'}
          </div>
          {customer.stats?.avg_days_between_visits == null && (
            <div className="mt-1 text-xs text-muted-foreground">{t('profile.need_two_visits')}</div>
          )}
        </div>
        <div className="bg-background p-5">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{t('profile.status')}</div>
          <div className="mt-1 text-xl font-bold">
            {customer.whatsapp_opted_in ? t('profile.reachable') : t('profile.opted_out')}
          </div>
        </div>
      </section>

      {/* Prescriptions */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <FileText className="h-4 w-4 text-primary" />
            {t('rx.section_heading')}
            <span className="font-mono text-xs text-muted-foreground">{prescriptions.length}</span>
          </h2>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => { setEditingRx(null); setRxOpen(true); }}
          >
            <FileText className="h-3.5 w-3.5" />
            {t('rx.add_button')}
          </Button>
        </div>
        {prescriptions.length === 0 ? (
          <div className="rounded-lg border border-dashed bg-muted/30 p-6 text-center text-sm text-muted-foreground">
            {t('rx.empty')}
          </div>
        ) : (
          <ul className="grid gap-2">
            {prescriptions.map((rx) => (
              <li key={rx.id} className="rounded-xl border bg-card p-3 transition-colors hover:border-primary/30">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-mono text-xs text-muted-foreground">
                        {new Date(rx.prescription_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
                      </span>
                      {rx.doctor_name && (
                        <span className="inline-flex items-center gap-1 text-xs">
                          <Stethoscope className="h-3 w-3 text-muted-foreground" />
                          Dr. {rx.doctor_name}
                        </span>
                      )}
                    </div>
                    {rx.diagnosis && (
                      <div className="mt-0.5 text-sm font-semibold">{rx.diagnosis}</div>
                    )}
                    {rx.follow_up_date && (
                      <div className="mt-1 inline-flex items-center gap-1 rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
                        {t('rx.follow_up')}: {new Date(rx.follow_up_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
                      </div>
                    )}
                    {rx.medicines.length > 0 && (
                      <div className="mt-2 space-y-1.5">
                        {rx.medicines.map((m) => (
                          <MedicineLine
                            key={m.id}
                            medicine={m}
                            onRefill={() => setRefillMed({ med: m, rxId: rx.id })}
                          />
                        ))}
                      </div>
                    )}
                    {rx.notes && (
                      <div className="mt-1.5 whitespace-pre-wrap text-xs text-muted-foreground">{rx.notes}</div>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setBatchRefillRx(rx)}
                      className="h-8 gap-1.5 px-3 font-semibold text-primary hover:bg-primary/5"
                    >
                      <RefreshCcw className="h-3.5 w-3.5" />
                      Refill
                    </Button>
                    <div className="h-8 w-px bg-border mx-1" />
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => { setEditingRx(rx); setRxOpen(true); }}
                      aria-label={t('btn.edit')}
                      className="h-8 w-8 p-0"
                    >
                      <Edit2 className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => renew.mutate(rx.id)}
                      disabled={renew.isPending}
                      aria-label={t('rx.renew')}
                      title={t('rx.renew')}
                      className="h-8 w-8 p-0"
                    >
                      {renew.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Copy className="h-3.5 w-3.5" />}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        if (window.confirm(t('rx.confirm_delete'))) remove.mutate(rx.id);
                      }}
                      disabled={remove.isPending}
                      aria-label={t('btn.delete')}
                      className="h-8 w-8 p-0 text-destructive hover:text-destructive"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Customer activity timeline (extracted into its own component) */}
      <CustomerActivityTimeline customerId={customer.id} />

      <ComposeDrawer
        open={composeOpen}
        onClose={() => setComposeOpen(false)}
        customer={{ id: customer.id, name: customer.name, phone: customer.phone, whatsapp_opted_in: customer.whatsapp_opted_in }}
      />

      <CustomerFormDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        mode="edit"
        customer={customer}
        onUpdated={() => qc.invalidateQueries({ queryKey: ['customer', customer.id] })}
      />

      <VisitNoteDialog
        open={noteOpen}
        onOpenChange={setNoteOpen}
        customerId={customer.id}
        customerName={customer.name}
      />

      <PrescriptionDialog
        open={rxOpen}
        onOpenChange={(v) => { setRxOpen(v); if (!v) setEditingRx(null); }}
        customerId={customer.id}
        customerName={customer.name}
        customerPhone={customer.phone}
        customerAge={customer.age}
        customerGender={customer.gender}
        existing={editingRx}
      />

      <RefillDialog
        open={!!refillMed}
        onOpenChange={(v) => { if (!v) setRefillMed(null); }}
        customerId={customer.id}
        prescriptionId={refillMed?.rxId ?? ''}
        medicine={refillMed?.med ?? null}
      />

      <BatchRefillDialog
        open={!!batchRefillRx}
        onOpenChange={(v) => { if (!v) setBatchRefillRx(null); }}
        customerId={customer.id}
        prescription={batchRefillRx}
      />
    </div>
  );
}

// ─── Per-medicine row with refill summary + button ──────────────────────────

function MedicineLine({
  medicine, onRefill,
}: {
  medicine: MedicineWithRefills;
  onRefill: () => void;
}) {
  const t = useT();
  const { count, last_refilled_at, next_due_at } = medicine.refill_stats;
  const nextDue = next_due_at ? new Date(next_due_at) : null;
  const today = new Date();
  const dueDelta = nextDue
    ? Math.round((nextDue.getTime() - today.getTime()) / 86_400_000)
    : null;
  const isOverdue = dueDelta != null && dueDelta < 0;
  const isDueSoon = dueDelta != null && dueDelta >= 0 && dueDelta <= 3;

  return (
    <div className="flex items-start justify-between gap-2 rounded-lg border bg-violet-500/[0.02] px-2.5 py-1.5 dark:bg-violet-950/10">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
          <span className="inline-flex items-center gap-1 font-medium text-violet-700 dark:text-violet-300">
            {medicine.medicine_name}
          </span>
          {medicine.strength && (
            <span className="text-[10px] text-muted-foreground">({medicine.strength})</span>
          )}
          {medicine.dosage && <span className="text-xs text-muted-foreground">{medicine.dosage}</span>}
          <span className="text-xs text-muted-foreground">· {medicine.frequency}</span>
          {medicine.quantity != null && (
            <span className="text-xs text-muted-foreground">· ×{medicine.quantity}</span>
          )}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[10px] text-muted-foreground uppercase tracking-wide">
          {count > 0 ? (
            <span className="font-bold text-emerald-600">
              {t('refill.refilled_n_times').replace('{n}', String(count))}
            </span>
          ) : (
            <span>{t('refill.never')}</span>
          )}
          {last_refilled_at && (
            <span>
              · {t('refill.last_on')} {new Date(last_refilled_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
            </span>
          )}
          {nextDue && (
            <span className={cn(
              'font-bold',
              isOverdue ? 'text-destructive'
              : isDueSoon ? 'text-amber-600'
              : ''
            )}>
              · {isOverdue
                ? t('refill.overdue_by').replace('{n}', String(-(dueDelta ?? 0)))
                : t('refill.next_due').replace('{n}', String(dueDelta ?? 0))}
            </span>
          )}
        </div>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={onRefill}
        className="h-7 w-7 p-0 text-muted-foreground hover:text-primary"
        title="Individual refill"
      >
        <RefreshCcw className="h-3 w-3" />
      </Button>
    </div>
  );
}
