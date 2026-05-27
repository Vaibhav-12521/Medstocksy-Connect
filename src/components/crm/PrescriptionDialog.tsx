import { useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Loader2, Stethoscope, Calendar as CalendarIcon, FileText,
  Pill, NotebookPen, AlertCircle, User as UserIcon, ClipboardPaste,
} from 'lucide-react';
import { useActivePharmacy } from '@/contexts/PharmacyContext';
import { useT } from '@/contexts/LanguageContext';
import {
  createPrescription, updatePrescription,
  type PrescriptionWithMeds, type MedicineInput,
} from '@/lib/api/prescriptions';
import { cn, initials } from '@/lib/utils';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

interface PrescriptionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customerId: string;
  customerName: string;
  customerPhone?: string;
  customerAge?: number | null;
  customerGender?: 'male' | 'female' | 'other' | null;
  /** When provided, opens in edit mode pre-filled. */
  existing?: PrescriptionWithMeds | null;
}

const EMPTY_MED: MedicineInput = {
  medicine_name: '',
  form: '',
  strength: '',
  dosage: '',
  route: '',
  frequency: 'Once daily',
  quantity: null,
  duration_days: 30,
  refill_interval_days: 30,
  instructions: '',
  substitution_allowed: true,
  medicine_notes: '',
};

export function PrescriptionDialog({
  open, onOpenChange, customerId, customerName, customerPhone, customerAge, customerGender, existing,
}: PrescriptionDialogProps) {
  const t = useT();
  const { pharmacyId } = useActivePharmacy();
  const qc = useQueryClient();
  const isEdit = !!existing;

  const today = new Date().toISOString().slice(0, 10);

  const [doctor, setDoctor] = useState('');
  const [date, setDate] = useState(today);
  const [followUp, setFollowUp] = useState('');
  const [diagnosis, setDiagnosis] = useState('');
  const [notes, setNotes] = useState('');
  const [totalCost, setTotalCost] = useState('');
  const [medsText, setMedsText] = useState('');

  // Convert textarea lines → MedicineInput[]
  const parsedMeds: MedicineInput[] = medsText
    .split('\n').map(l => l.trim()).filter(Boolean)
    .map(name => ({ ...EMPTY_MED, medicine_name: name }));

  useEffect(() => {
    if (!open) return;
    if (isEdit && existing) {
      setDoctor(existing.doctor_name ?? '');
      setDate(existing.prescription_date.slice(0, 10));
      setFollowUp(existing.follow_up_date?.slice(0, 10) ?? '');
      setDiagnosis(existing.diagnosis ?? '');
      setNotes(existing.notes ?? '');
      setTotalCost(existing.total_cost?.toString() ?? '');
      // Pre-populate textarea with existing medicine names (one per line)
      setMedsText(existing.medicines.map(m => m.medicine_name).join('\n'));
    } else {
      setDoctor('');
      setDate(today);
      setFollowUp('');
      setDiagnosis('');
      setNotes('');
      setTotalCost('');
      setMedsText('');
    }
  }, [open, isEdit, existing, today]);



  const followUpInvalid = !!followUp && followUp < date;

  const save = useMutation<void, Error>({
    mutationFn: async () => {
      if (parsedMeds.length === 0) throw new Error('Paste at least one medicine name.');
      const rx = {
        doctor_name: doctor.trim() || null,
        prescription_date: date,
        follow_up_date: followUp || null,
        diagnosis: diagnosis.trim() || null,
        notes: notes.trim() || null,
        total_cost: totalCost ? parseFloat(totalCost) : null,
      };
      if (isEdit && existing) {
        await updatePrescription({ id: existing.id, rx, medicines: parsedMeds });
      } else {
        await createPrescription({ pharmacyId, customerId, rx, medicines: parsedMeds });
      }
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['prescriptions', customerId] });
      await qc.invalidateQueries({ queryKey: ['customer-activity', customerId] });
      // Refreshes the hero stat strip — the unified crm_customer_stats view
      // counts prescriptions toward visit_count and last_visit_at.
      await qc.invalidateQueries({ queryKey: ['customer', customerId] });
      await qc.invalidateQueries({ queryKey: ['customers'] });
      onOpenChange(false);
    },
  });

  const canSubmit = !save.isPending && parsedMeds.length > 0 && !followUpInvalid;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (canSubmit) save.mutate();
  };

  const subtitleText = (isEdit ? t('rx.subtitle_edit') : t('rx.subtitle_new')).replace('{name}', customerName);

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!save.isPending) onOpenChange(v); }}>
      <DialogContent className="flex max-h-[92vh] max-w-3xl flex-col gap-0 overflow-hidden p-0">
        {/* ── Header strip ── */}
        <div className="flex items-start gap-3 border-b bg-gradient-to-br from-primary/8 via-transparent to-transparent px-6 pb-5 pt-6">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <FileText className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <DialogHeader className="space-y-0.5 text-left">
              <DialogTitle className="text-lg">
                {isEdit ? t('rx.title_edit') : t('rx.title_new')}
              </DialogTitle>
              <DialogDescription className="text-xs">
                {subtitleText}
              </DialogDescription>
            </DialogHeader>
          </div>
        </div>

        {/* ── Scrollable body ── */}
        <form id="rx-form" onSubmit={handleSubmit} className="flex-1 overflow-y-auto px-6 py-5">
          {/* Patient summary card */}
          <PatientCard
            name={customerName}
            phone={customerPhone}
            age={customerAge}
            gender={customerGender}
          />

          <div className="mt-5 space-y-5">
            {/* Section 1 — Consultation */}
            <Section icon={<Stethoscope className="h-4 w-4" />} title={t('rx.section_consultation')}>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1.4fr_1fr_1fr]">
                <Field label={t('rx.doctor')} optional>
                  <Input
                    value={doctor}
                    onChange={(e) => setDoctor(e.target.value)}
                    placeholder={t('rx.doctor_placeholder')}
                    maxLength={120}
                  />
                </Field>
                <Field
                  label={t('rx.date')}
                  required
                  icon={<CalendarIcon className="h-3.5 w-3.5 text-muted-foreground" />}
                >
                  <Input
                    type="date"
                    className="font-mono"
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                    max={today}
                    required
                  />
                </Field>
                <Field
                  label={t('rx.follow_up')}
                  optional
                  icon={<CalendarIcon className="h-3.5 w-3.5 text-muted-foreground" />}
                  error={followUpInvalid ? t('rx.follow_up_invalid') : undefined}
                >
                  <Input
                    type="date"
                    className={cn('font-mono', followUpInvalid && 'border-destructive/60 focus-visible:ring-destructive/40')}
                    value={followUp}
                    onChange={(e) => setFollowUp(e.target.value)}
                    min={date}
                  />
                </Field>
              </div>

              <Field label={t('rx.diagnosis')} optional className="mt-3">
                <Input
                  value={diagnosis}
                  onChange={(e) => setDiagnosis(e.target.value)}
                  placeholder={t('rx.diagnosis_placeholder')}
                  maxLength={240}
                />
              </Field>

              <Field label="Total Cost of Prescription (₹)" optional className="mt-3">
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={totalCost}
                  onChange={(e) => setTotalCost(e.target.value)}
                  placeholder="0.00"
                />
              </Field>
            </Section>

            {/* Section 2 — Medicines */}
            <Section
              icon={<Pill className="h-4 w-4" />}
              title={t('rx.medicines')}
              required
            >
              <div className="space-y-2">
                <textarea
                  value={medsText}
                  onChange={e => setMedsText(e.target.value)}
                  placeholder={`Paste prescription here — one medicine per line:\n\nCrocin 500mg\nAzithromycin 250mg\nPan-D`}
                  rows={5}
                  className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm font-mono leading-relaxed placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-ring"
                />
                {parsedMeds.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {parsedMeds.map((m, i) => (
                      <span key={i} className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                        <ClipboardPaste className="h-3 w-3 opacity-60" />
                        {m.medicine_name}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <p className="mt-3 flex items-start gap-1.5 rounded-md bg-amber-500/10 px-3 py-2 text-[11px] text-amber-800 dark:text-amber-300">
                <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
                <span>{isEdit ? t('rx.edit_note') : t('rx.auto_reminder_note')}</span>
              </p>
            </Section>

            {/* Section 3 — Notes */}
            <Section icon={<NotebookPen className="h-4 w-4" />} title={t('rx.notes')} optional>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder={t('rx.notes_placeholder')}
                maxLength={1024}
                className={cn(
                  'block h-20 w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm leading-relaxed',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
                )}
              />
              <div className="mt-1 flex justify-end font-mono text-[10px] text-muted-foreground">
                {notes.length} / 1024
              </div>
            </Section>

            {save.isError && (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {save.error.message}
              </div>
            )}
          </div>
        </form>

        {/* ── Sticky footer ── */}
        <DialogFooter className="border-t bg-muted/30 px-6 py-3">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={save.isPending}>
            {t('btn.cancel')}
          </Button>
          <Button type="submit" form="rx-form" disabled={!canSubmit}>
            {save.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            {save.isPending
              ? t('btn.saving')
              : (isEdit ? t('rx.save_edit') : t('rx.save_new'))}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Patient summary ─────────────────────────────────────────────────────────

function PatientCard({
  name, phone, age, gender,
}: {
  name: string; phone?: string; age?: number | null; gender?: 'male' | 'female' | 'other' | null;
}) {
  const t = useT();
  return (
    <div className="flex items-center gap-3 rounded-xl border bg-card/50 p-3">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-primary/15 to-primary/5 text-sm font-bold text-primary ring-1 ring-primary/20">
        {initials(name)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-sm font-semibold">
          <UserIcon className="h-3 w-3 text-muted-foreground" />
          {name}
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
          {phone && <span className="font-mono">{phone}</span>}
          {age != null && <span>· {age} {t('rx.years')}</span>}
          {gender && <span className="capitalize">· {gender}</span>}
        </div>
      </div>
    </div>
  );
}

// ─── Layout primitives ──────────────────────────────────────────────────────

function Section({
  icon, title, required, optional, actions, children,
}: {
  icon: ReactNode; title: string; required?: boolean; optional?: boolean;
  actions?: ReactNode; children: ReactNode;
}) {
  const t = useT();
  return (
    <section className="rounded-xl border bg-card/40 p-4">
      <header className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-primary/10 text-primary">
            {icon}
          </span>
          {title}
          {required && <span className="text-destructive">*</span>}
          {optional && (
            <span className="text-[10px] font-normal lowercase tracking-normal text-muted-foreground">
              ({t('common.optional')})
            </span>
          )}
        </div>
        {actions}
      </header>
      {children}
    </section>
  );
}

function Field({
  label, required, optional, hint, error, icon, className, children,
}: {
  label: string; required?: boolean; optional?: boolean; hint?: string; error?: string;
  icon?: ReactNode; className?: string; children: ReactNode;
}) {
  const t = useT();
  return (
    <div className={className}>
      <label className="mb-1 flex items-center gap-1.5 text-sm font-medium">
        {icon}
        {label}
        {required && <span className="text-destructive">*</span>}
        {optional && (
          <span className="text-xs font-normal text-muted-foreground">({t('common.optional')})</span>
        )}
      </label>
      {children}
      {error
        ? <p className="mt-1 text-xs text-destructive">{error}</p>
        : hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
