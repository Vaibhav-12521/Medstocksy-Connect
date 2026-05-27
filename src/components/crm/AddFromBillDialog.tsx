/**
 * Two-in-one customer creation flow:
 *   • Patient info (name, phone, age, gender)
 *   • Source switch — Bill receipt | Prescription
 *
 * Saves a customer AND the chosen child record (a sale row OR a prescription
 * with medicines) in a single submit. Reuses the family-of-id collision flow,
 * so duplicate phones still resolve to "Add as family of {name}".
 */
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  Loader2, Receipt, FileText, Users, ExternalLink, X as XIcon,
  Calendar as CalendarIcon, IndianRupee, Pill, Stethoscope,
  Paperclip, Upload, File as FileIcon, Image as ImageIcon, Pencil, ClipboardPaste,
} from 'lucide-react';
import { useActivePharmacy } from '@/contexts/PharmacyContext';
import { useT } from '@/contexts/LanguageContext';
import {
  createCustomer, recordSale, DuplicatePhoneError, type Customer,
} from '@/lib/api/customers';
import { createPrescription, type MedicineInput } from '@/lib/api/prescriptions';
import { supabase } from '@/lib/supabase';
import { validateIndianPhone, initials, cn } from '@/lib/utils';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

interface AddFromBillDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (c: Customer) => void;
}

type Source = 'bill' | 'rx';
type Mode = 'upload' | 'manual';
type Gender = 'male' | 'female' | 'other';

const EMPTY_RX_MED: MedicineInput = {
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

export function AddFromBillDialog({ open, onOpenChange, onCreated }: AddFromBillDialogProps) {
  const t = useT();
  const navigate = useNavigate();
  const { pharmacyId } = useActivePharmacy();
  const qc = useQueryClient();

  // ── Patient fields ──
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [age, setAge] = useState('');
  const [gender, setGender] = useState<Gender | ''>('');
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [collision, setCollision] = useState<Customer | null>(null);

  // ── Mode switch — upload a scan OR enter manually ──
  const [mode, setMode] = useState<Mode>('upload');

  // ── Source switch — applies to both modes (routes to sale vs prescription) ──
  const [source, setSource] = useState<Source>('bill');

  // ── Bill mode fields ──
  const today = new Date().toISOString().slice(0, 10);
  const [billDate, setBillDate] = useState(today);
  const [billAmount, setBillAmount] = useState('');
  const [billMeds, setBillMeds] = useState<string[]>([]);
  const [medDraft, setMedDraft] = useState('');

  // ── Prescription mode fields ──
  const [doctor, setDoctor] = useState('');
  const [rxDate, setRxDate] = useState(today);
  const [diagnosis, setDiagnosis] = useState('');
  const [rxMedsText, setRxMedsText] = useState('');
  const [rxError, setRxError] = useState<string | null>(null);

  // Parse textarea → MedicineInput[]
  const parsedRxMeds: MedicineInput[] = rxMedsText
    .split('\n').map(l => l.trim()).filter(Boolean)
    .map(name => ({ ...EMPTY_RX_MED, medicine_name: name }));

  // ── Attachment (PDF or image of the bill / prescription) ──
  const [attachment, setAttachment] = useState<{ url: string; name: string; type: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const ALLOWED = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
  const MAX_BYTES = 10 * 1024 * 1024;

  const handleFile = async (file: File) => {
    setUploadError(null);
    if (!ALLOWED.includes(file.type)) {
      setUploadError(t('add_bill.attachment_invalid_type'));
      return;
    }
    if (file.size > MAX_BYTES) {
      setUploadError(t('add_bill.attachment_too_large'));
      return;
    }
    setUploading(true);
    try {
      const ext = (file.name.split('.').pop() ?? 'bin').toLowerCase();
      const path = `${pharmacyId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from('crm-bill-attachments')
        .upload(path, file, { upsert: false, contentType: file.type });
      if (upErr) throw upErr;
      const { data: pub } = supabase.storage.from('crm-bill-attachments').getPublicUrl(path);
      setAttachment({ url: pub.publicUrl, name: file.name, type: file.type });
    } catch (err) {
      console.error('[bill attachment]', err);
      setUploadError(err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const removeAttachment = () => {
    setAttachment(null);
    setUploadError(null);
  };

  useEffect(() => {
    if (!open) return;
    setName(''); setPhone(''); setAge(''); setGender('');
    setPhoneError(null); setCollision(null); setMode('upload'); setSource('bill');
    setBillDate(today); setBillAmount(''); setBillMeds([]); setMedDraft('');
    setDoctor(''); setRxDate(today); setDiagnosis('');
    setRxMedsText(''); setRxError(null);
    setAttachment(null); setUploadError(null); setDragOver(false);
  }, [open, today]);

  // ── Shared submit pipeline ─────────────────────────────────────────────────
  const create = useMutation<Customer, Error, { familyOfId: string | null }>({
    mutationFn: async ({ familyOfId }) => {
      const v = validateIndianPhone(phone);
      if (!v.ok) throw new Error(v.error);
      const ageNum = age.trim() ? Number(age) : undefined;
      if (age.trim() && (Number.isNaN(ageNum) || ageNum! < 0 || ageNum! > 130)) {
        throw new Error('Age must be 0–130.');
      }

      // 1. Customer
      const customer = await createCustomer({
        pharmacy_id: pharmacyId,
        name: name.trim(),
        phone: v.e164,
        family_of_id: familyOfId,
        ...(ageNum != null ? { age: ageNum } : {}),
        ...(gender ? { gender } : {}),
      });

      // 2. Child record — bill OR prescription
      if (source === 'bill') {
        const amt = Number(billAmount) || 0;
        if (mode === 'manual' && (!Number.isFinite(amt) || amt < 0)) {
          throw new Error('Bill amount must be a positive number.');
        }
        await recordSale({
          pharmacyId,
          customerId: customer.id,
          billAmount: amt,
          soldAt: billDate ? new Date(billDate).toISOString() : new Date().toISOString(),
          medicines: billMeds.map((nm) => ({ name: nm })),
          attachmentUrl: attachment?.url ?? null,
        });
      } else {
        // Prescription mode
        if (mode === 'manual' && parsedRxMeds.length === 0) {
          throw new Error('Paste at least one medicine name.');
        }
        await createPrescription({
          pharmacyId,
          customerId: customer.id,
          rx: {
            doctor_name: doctor.trim() || null,
            prescription_date: rxDate || today,
            follow_up_date: null,
            diagnosis: diagnosis.trim() || null,
            notes: null,
            attachment_url: attachment?.url ?? null,
          },
          medicines: parsedRxMeds.length > 0
            ? parsedRxMeds
            : [{ ...EMPTY_RX_MED, medicine_name: t('add_bill.placeholder_medicine') }],
        });
      }

      return customer;
    },
    onSuccess: async (c) => {
      await qc.invalidateQueries({ queryKey: ['customers'] });
      await qc.invalidateQueries({ queryKey: ['dashboard-counts'] });
      await qc.invalidateQueries({ queryKey: ['customer', c.id] });
      onOpenChange(false);
      onCreated?.(c);
    },
    onError: (err) => {
      if (err instanceof DuplicatePhoneError) {
        setCollision(err.existing);
      }
    },
  });

  // ── Bill medicine chip helpers ────────────────────────────────────────────
  const commitBillMed = () => {
    const v = medDraft.trim();
    if (!v) return;
    if (billMeds.includes(v)) { setMedDraft(''); return; }
    if (billMeds.length >= 20) return;
    setBillMeds((arr) => [...arr, v]);
    setMedDraft('');
  };


  // ── Validity guards ───────────────────────────────────────────────────────
  const canSubmit =
    !!name.trim() && !!phone.trim() && !phoneError && !create.isPending && !uploading &&
    (mode === 'upload'
      ? !!attachment
      : source === 'bill'
        ? billAmount.trim() !== ''
        : parsedRxMeds.length > 0);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setRxError(null);
    if (canSubmit && !collision) create.mutate({ familyOfId: null });
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!create.isPending) onOpenChange(v); }}>
      <DialogContent className="flex max-h-[92vh] max-w-3xl flex-col gap-0 overflow-hidden p-0">
        {/* Header */}
        <div className="flex items-start gap-3 border-b bg-gradient-to-br from-primary/8 via-transparent to-transparent px-6 pb-5 pt-6">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Receipt className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <DialogHeader className="space-y-0.5 text-left">
              <DialogTitle className="text-lg">{t('add_bill.title')}</DialogTitle>
              <DialogDescription className="text-xs">{t('add_bill.subtitle')}</DialogDescription>
            </DialogHeader>
          </div>
        </div>

        <form id="add-from-bill-form" onSubmit={handleSubmit} className="flex-1 overflow-y-auto px-6 py-5">
          {/* ── Patient section ── ALWAYS VISIBLE ── */}
          <section className="mb-5 rounded-xl border bg-card/40 p-4">
            <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              <span className="flex h-6 w-6 items-center justify-center rounded-md bg-primary/10 text-primary">
                <Users className="h-3.5 w-3.5" />
              </span>
              {t('add_bill.section_patient')}
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label={t('cust.name')} required>
                <Input value={name} onChange={(e) => setName(e.target.value)} required autoFocus maxLength={120} />
              </Field>
              <Field label={t('cust.phone')} required error={phoneError ?? undefined}>
                <div className="flex">
                  <span className="flex select-none items-center rounded-l-md border border-r-0 bg-muted px-2.5 text-sm font-mono text-muted-foreground">+91</span>
                  <Input
                    type="tel"
                    inputMode="numeric"
                    className="rounded-l-none font-mono"
                    value={phone}
                    onChange={(e) => {
                      setPhone(e.target.value);
                      if (phoneError) setPhoneError(null);
                      if (collision) setCollision(null);
                    }}
                    onBlur={() => {
                      if (!phone.trim()) { setPhoneError(null); return; }
                      const v = validateIndianPhone(phone);
                      setPhoneError(v.ok ? null : v.error);
                    }}
                    maxLength={15}
                    placeholder="98765 43210"
                    required
                  />
                </div>
              </Field>
              <Field label={t('cust.age')}>
                <Input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={130}
                  className="font-mono"
                  value={age}
                  onChange={(e) => setAge(e.target.value)}
                  placeholder="—"
                />
              </Field>
              <Field label={t('cust.gender')}>
                <select
                  value={gender}
                  onChange={(e) => setGender(e.target.value as Gender | '')}
                  className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <option value="">—</option>
                  <option value="male">{t('cust.gender.male')}</option>
                  <option value="female">{t('cust.gender.female')}</option>
                  <option value="other">{t('cust.gender.other')}</option>
                </select>
              </Field>
            </div>
          </section>

          {/* ── Mode switch ── */}
          <div className="mb-5 rounded-xl border bg-card/40 p-3">
            <div role="radiogroup" className="inline-flex w-full rounded-lg border bg-muted/60 p-1">
              <SourceButton
                selected={mode === 'upload'}
                onClick={() => setMode('upload')}
                icon={<Upload className="h-3.5 w-3.5" />}
                label={t('add_bill.mode_upload')}
              />
              <SourceButton
                selected={mode === 'manual'}
                onClick={() => setMode('manual')}
                icon={<Pencil className="h-3.5 w-3.5" />}
                label={t('add_bill.mode_manual')}
              />
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground">
              {mode === 'upload' ? t('add_bill.mode_upload_hint') : t('add_bill.mode_manual_hint')}
            </p>
          </div>

          {/* ── Attachment block ── */}
          {mode === 'upload' && (
            <section className="mb-5 rounded-xl border bg-card/40 p-4">
              <div className="mb-3 flex items-center justify-between gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                <div className="flex items-center gap-2">
                  <span className="flex h-6 w-6 items-center justify-center rounded-md bg-primary/10 text-primary">
                    <Paperclip className="h-3.5 w-3.5" />
                  </span>
                  {t('add_bill.section_attachment')}
                  <span className="text-[10px] font-normal lowercase tracking-normal text-muted-foreground">
                    ({t('common.optional')})
                  </span>
                </div>
                {attachment && (
                  <button
                    type="button"
                    onClick={removeAttachment}
                    className="inline-flex items-center gap-1 rounded text-[11px] font-medium text-destructive hover:underline"
                    disabled={uploading}
                  >
                    <XIcon className="h-3 w-3" />
                    {t('add_bill.attachment_remove')}
                  </button>
                )}
              </div>

              {!attachment ? (
                <div
                  onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={(e) => {
                    e.preventDefault(); setDragOver(false);
                    const f = e.dataTransfer.files?.[0];
                    if (f) handleFile(f);
                  }}
                  className={cn(
                    'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-6 text-center transition-colors',
                    dragOver
                      ? 'border-primary bg-primary/5'
                      : 'border-border bg-background hover:border-primary/40 hover:bg-muted/30',
                    uploading && 'pointer-events-none opacity-60'
                  )}
                  onClick={() => fileRef.current?.click()}
                >
                  <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
                    {uploading ? <Loader2 className="h-5 w-5 animate-spin" /> : <Upload className="h-5 w-5" />}
                  </div>
                  <div className="text-sm font-medium">
                    {uploading ? t('add_bill.attachment_uploading') : t('add_bill.attachment_dropzone')}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {t('add_bill.attachment_hint')}
                  </div>
                </div>
              ) : (
                <AttachmentPreview attachment={attachment} />
              )}

              <input
                ref={fileRef}
                type="file"
                hidden
                accept={ALLOWED.join(',')}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleFile(f);
                }}
              />

              {uploadError && (
                <p className="mt-2 text-xs text-destructive">{uploadError}</p>
              )}
            </section>
          )}

          {/* ── Source switch + Details ── */}
          {(mode === 'manual' || attachment) && (
            <div className="rounded-xl border bg-card/40 p-4">
              <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {t('add_bill.section_source')}
              </div>
              <div role="radiogroup" className="inline-flex w-full rounded-lg border bg-muted/60 p-1">
                <SourceButton
                  selected={source === 'bill'}
                  onClick={() => setSource('bill')}
                  icon={<Receipt className="h-3.5 w-3.5" />}
                  label={t('add_bill.source_bill')}
                />
                <SourceButton
                  selected={source === 'rx'}
                  onClick={() => setSource('rx')}
                  icon={<FileText className="h-3.5 w-3.5" />}
                  label={t('add_bill.source_rx')}
                />
              </div>

              {/* Bill details */}
              {source === 'bill' && (
                <div className="mt-4 space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <Field label={t('add_bill.bill_amount')} required={mode === 'manual'} icon={<IndianRupee className="h-3.5 w-3.5 text-muted-foreground" />}>
                      <div className="flex h-10 items-stretch overflow-hidden rounded-md border border-input bg-background focus-within:ring-2 focus-within:ring-ring">
                        <span className="flex shrink-0 select-none items-center border-r bg-muted/40 px-2 text-muted-foreground">
                          <IndianRupee className="h-3.5 w-3.5" />
                        </span>
                        <input
                          type="number"
                          inputMode="decimal"
                          min={0}
                          step="0.01"
                          value={billAmount}
                          onChange={(e) => setBillAmount(e.target.value)}
                          placeholder="0.00"
                          required={mode === 'manual'}
                          className="min-w-0 flex-1 bg-transparent px-2 font-mono text-sm focus:outline-none"
                        />
                      </div>
                    </Field>
                    <Field label={t('add_bill.bill_date')} icon={<CalendarIcon className="h-3.5 w-3.5 text-muted-foreground" />}>
                      <Input
                        type="date"
                        className="font-mono"
                        value={billDate}
                        onChange={(e) => setBillDate(e.target.value)}
                        max={today}
                      />
                    </Field>
                  </div>
                  <Field
                    label={t('add_bill.bill_medicines')}
                    hint={t('add_bill.bill_medicines_hint')}
                    icon={<Pill className="h-3.5 w-3.5 text-muted-foreground" />}
                  >
                    <div className="flex min-h-10 flex-wrap items-center gap-1.5 rounded-md border border-input bg-background px-2 py-1.5 focus-within:ring-2 focus-within:ring-ring">
                      {billMeds.map((m) => (
                        <span key={m} className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                          {m}
                          <button
                            type="button"
                            onClick={() => setBillMeds((arr) => arr.filter((x) => x !== m))}
                            className="rounded hover:bg-primary/20"
                            aria-label={`Remove ${m}`}
                          >
                            <XIcon className="h-3 w-3" />
                          </button>
                        </span>
                      ))}
                      <Input
                        value={medDraft}
                        onChange={(e) => setMedDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ',') {
                            e.preventDefault(); commitBillMed();
                          } else if (e.key === 'Backspace' && !medDraft && billMeds.length) {
                            setBillMeds((arr) => arr.slice(0, -1));
                          }
                        }}
                        onBlur={commitBillMed}
                        placeholder={billMeds.length ? '' : t('add_bill.bill_med_placeholder')}
                        disabled={billMeds.length >= 20}
                        className="h-7 min-w-[8rem] flex-1 border-0 bg-transparent p-0 text-sm shadow-none focus-visible:ring-0"
                      />
                    </div>
                  </Field>
                </div>
              )}

              {/* Prescription details */}
              {source === 'rx' && (
                <div className="mt-4 space-y-3">
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1.4fr_1fr]">
                    <Field label={t('rx.doctor')} icon={<Stethoscope className="h-3.5 w-3.5 text-muted-foreground" />}>
                      <Input
                        value={doctor}
                        onChange={(e) => setDoctor(e.target.value)}
                        placeholder={t('rx.doctor_placeholder')}
                        maxLength={120}
                      />
                    </Field>
                    <Field label={t('rx.date')} icon={<CalendarIcon className="h-3.5 w-3.5 text-muted-foreground" />}>
                      <Input
                        type="date"
                        className="font-mono"
                        value={rxDate}
                        onChange={(e) => setRxDate(e.target.value)}
                        max={today}
                      />
                    </Field>
                  </div>
                  <Field label={t('rx.diagnosis')}>
                    <Input
                      value={diagnosis}
                      onChange={(e) => setDiagnosis(e.target.value)}
                      placeholder={t('rx.diagnosis_placeholder')}
                      maxLength={240}
                    />
                  </Field>

                  <div className="rounded-lg border bg-background p-3 space-y-2">
                    <div className="mb-2 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      <span className="flex items-center gap-1.5"><Pill className="h-3 w-3" />{t('rx.medicines')} {mode === 'manual' && <span className="text-destructive">*</span>}</span>
                      {parsedRxMeds.length > 0 && (
                        <span className="rounded-full bg-primary/10 px-2 py-0.5 font-mono text-[10px] text-primary">{parsedRxMeds.length}</span>
                      )}
                    </div>
                    <textarea
                      value={rxMedsText}
                      onChange={e => setRxMedsText(e.target.value)}
                      placeholder={`Paste prescription here — one medicine per line:\n\nCrocin 500mg\nAzithromycin 250mg\nPan-D`}
                      rows={4}
                      className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm font-mono leading-relaxed placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                    {parsedRxMeds.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 pt-1">
                        {parsedRxMeds.map((m, i) => (
                          <span key={i} className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                            <ClipboardPaste className="h-3 w-3 opacity-60" />
                            {m.medicine_name}
                          </span>
                        ))}
                      </div>
                    )}
                    {rxError && <p className="mt-1 text-[11px] text-destructive">{rxError}</p>}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── Collision panel ── */}
          {collision && (
            <div className="mt-4 rounded-xl border-2 border-primary/40 bg-primary/5 p-4">
              <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-primary">
                <Users className="h-4 w-4" />
                {t('cust.phone_in_use')}
              </div>
              <div className="flex items-center gap-3 rounded-lg bg-background p-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">
                  {initials(collision.name)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold">{collision.name}</div>
                  <div className="font-mono text-[11px] text-muted-foreground">{collision.phone}</div>
                </div>
              </div>
              <p className="mt-3 text-xs text-muted-foreground">
                {t('cust.family_explain').replace('{name}', collision.name)}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    onOpenChange(false);
                    navigate(`/customers/${collision.id}`);
                  }}
                >
                  <ExternalLink className="h-4 w-4" />
                  {t('cust.open_existing')}
                </Button>
                <Button
                  type="button"
                  onClick={() => create.mutate({ familyOfId: collision.id })}
                  disabled={create.isPending || !name.trim()}
                >
                  {create.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                  <Users className="h-4 w-4" />
                  {t('cust.add_as_family').replace('{name}', collision.name)}
                </Button>
              </div>
            </div>
          )}

          {create.isError && !(create.error instanceof DuplicatePhoneError) && (
            <div className="mt-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {create.error?.message ?? t('common.unknown')}
            </div>
          )}
        </form>

        <DialogFooter className="border-t bg-muted/30 px-6 py-3">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={create.isPending}>
            {t('btn.cancel')}
          </Button>
          {!collision && (
            <Button type="submit" form="add-from-bill-form" disabled={!canSubmit}>
              {create.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              {create.isPending ? t('btn.creating') : t('add_bill.save')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function Field({
  label, required, hint, error, icon, children,
}: {
  label: string; required?: boolean; hint?: string; error?: string;
  icon?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <div>
      <label className="mb-1 flex items-center gap-1.5 text-sm font-medium">
        {icon}
        {label}
        {required && <span className="text-destructive">*</span>}
      </label>
      {children}
      {error
        ? <p className="mt-1 text-xs text-destructive">{error}</p>
        : hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/** Inline preview for the uploaded bill / prescription. Images render via
 *  <img>; PDFs use a native <embed> (first page rendering in most browsers). */
function AttachmentPreview({
  attachment,
}: { attachment: { url: string; name: string; type: string } }) {
  const t = useT();
  const isImage = attachment.type.startsWith('image/');
  const isPdf = attachment.type === 'application/pdf';
  return (
    <div className="overflow-hidden rounded-lg border bg-background">
      <div className="flex items-center gap-2 border-b bg-muted/30 px-3 py-2 text-xs">
        {isPdf
          ? <FileIcon className="h-3.5 w-3.5 text-destructive" />
          : <ImageIcon className="h-3.5 w-3.5 text-emerald-600" />}
        <span className="truncate font-medium">{attachment.name}</span>
        <a
          href={attachment.url}
          target="_blank"
          rel="noopener noreferrer"
          className="ml-auto inline-flex items-center gap-1 text-primary hover:underline"
        >
          <ExternalLink className="h-3 w-3" />
          {t('add_bill.attachment_open')}
        </a>
      </div>
      <div className="flex items-center justify-center bg-muted/20 p-2">
        {isImage && (
          <img
            src={attachment.url}
            alt={attachment.name}
            className="max-h-64 max-w-full rounded object-contain"
          />
        )}
        {isPdf && (
          <embed
            src={attachment.url}
            type="application/pdf"
            className="h-64 w-full rounded"
          />
        )}
        {!isImage && !isPdf && (
          <div className="py-6 text-xs text-muted-foreground">{t('add_bill.attachment_no_preview')}</div>
        )}
      </div>
    </div>
  );
}

function SourceButton({
  selected, onClick, icon, label,
}: {
  selected: boolean; onClick: () => void; icon: React.ReactNode; label: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onClick}
      className={cn(
        'inline-flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-semibold transition-all',
        selected
          ? 'bg-primary text-primary-foreground shadow-md shadow-primary/30 ring-1 ring-primary/40'
          : 'text-muted-foreground hover:bg-background/60 hover:text-foreground'
      )}
    >
      {icon}
      {label}
    </button>
  );
}


