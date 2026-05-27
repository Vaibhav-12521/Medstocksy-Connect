/**
 * PrescriptionWorkflow — streamlined 3-step POS flow
 * Step 1: Select/create customer
 * Step 2: Upload bill or enter manually → OCR extract → editable fields
 * Step 3: Set reminder
 */
import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, Camera, Check, ChevronRight, Clock, FileText,
  Image as ImageIcon, Loader2, Pencil, Pill, Receipt, Search,
  Stethoscope, Upload, User, Users, X as XIcon, Bell, ClipboardPaste, Plus,
} from 'lucide-react';
import { useActivePharmacy } from '@/contexts/PharmacyContext';
import { supabase } from '@/lib/supabase';
import { createCustomer, DuplicatePhoneError, type Customer } from '@/lib/api/customers';
import { createPrescription, type MedicineInput } from '@/lib/api/prescriptions';
import { validateIndianPhone, cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';
import { QuickReminderDialog } from '@/components/crm/QuickReminderDialog';

/* ─── types ──────────────────────────────────────────────────────────────── */
type Step = 1 | 2 | 3;
type Mode = 'upload' | 'manual';

const EMPTY_MED: MedicineInput = {
  medicine_name: '', form: '', strength: '', dosage: '', route: '',
  frequency: 'Once daily', quantity: null, duration_days: 30,
  refill_interval_days: 30, instructions: '', substitution_allowed: true, medicine_notes: '',
};

/* ─── helpers ─────────────────────────────────────────────────────────────── */
function StepDot({ n, current, done }: { n: number; current: Step; done: boolean }) {
  const active = n === current;
  return (
    <div className={cn(
      'flex h-8 w-8 items-center justify-center rounded-full text-sm font-bold border-2 transition-all',
      done ? 'border-emerald-500 bg-emerald-500 text-white'
        : active ? 'border-primary bg-primary text-primary-foreground'
        : 'border-border bg-background text-muted-foreground'
    )}>
      {done ? <Check className="h-4 w-4" /> : n}
    </div>
  );
}

function StepBar({ step }: { step: Step }) {
  const labels = ['Customer', 'Prescription', 'Reminder'];
  return (
    <div className="flex items-center gap-0 mb-6">
      {labels.map((label, i) => {
        const n = (i + 1) as Step;
        const done = n < step;
        return (
          <div key={n} className="flex items-center gap-0 flex-1 last:flex-none">
            <div className="flex flex-col items-center gap-1">
              <StepDot n={n} current={step} done={done} />
              <span className={cn('text-[10px] font-semibold uppercase tracking-wider', n === step ? 'text-primary' : 'text-muted-foreground')}>{label}</span>
            </div>
            {i < labels.length - 1 && (
              <div className={cn('h-0.5 flex-1 mx-2 mb-4 rounded-full transition-all', done ? 'bg-emerald-500' : 'bg-border')} />
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ─── Step 1: Customer picker ─────────────────────────────────────────────── */
function CustomerStep({ onSelected }: { onSelected: (c: Customer) => void }) {
  const { pharmacyId } = useActivePharmacy();
  const [search, setSearch] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [age, setAge] = useState('');
  const [creating, setCreating] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);
  const [phoneErr, setPhoneErr] = useState<string | null>(null);

  const { data: results = [], isFetching } = useQuery<Customer[]>({
    queryKey: ['rx-workflow-search', pharmacyId, search],
    enabled: search.trim().length > 1,
    queryFn: async () => {
      const q = search.trim();
      const { data } = await supabase
        .from('crm_customers')
        .select('*')
        .eq('pharmacy_id', pharmacyId)
        .or(`name.ilike.%${q}%,phone.ilike.%${q}%`)
        .limit(8);
      return ((data ?? []) as unknown) as Customer[];
    },
    staleTime: 5000,
  });

  const qc = useQueryClient();
  const doCreate = async () => {
    setCreateErr(null);
    const v = validateIndianPhone(phone);
    if (!v.ok) { setPhoneErr(v.error); return; }
    if (!name.trim()) { setCreateErr('Name is required.'); return; }
    setCreating(true);
    try {
      const c = await createCustomer({
        pharmacy_id: pharmacyId, name: name.trim(), phone: v.e164,
        ...(age.trim() ? { age: Number(age) } : {}),
      });
      await qc.invalidateQueries({ queryKey: ['customers'] });
      onSelected(c);
    } catch (err) {
      if (err instanceof DuplicatePhoneError) setCreateErr(`Phone already exists: ${err.existing.name}`);
      else setCreateErr(err instanceof Error ? err.message : 'Failed');
    } finally { setCreating(false); }
  };

  return (
    <div className="space-y-4">
      <div>
        <label className="mb-1 block text-sm font-medium">Search existing customer</label>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-9" placeholder="Name or phone…" value={search} onChange={e => setSearch(e.target.value)} autoFocus />
        </div>
        {search.trim().length > 1 && (
          <div className="mt-1 rounded-xl border bg-background shadow-lg overflow-hidden">
            {isFetching && <div className="p-3 text-xs text-muted-foreground">Searching…</div>}
            {!isFetching && results.length === 0 && <div className="p-3 text-xs text-muted-foreground">No results</div>}
            {results.map(c => (
              <button key={c.id} onClick={() => onSelected(c)}
                className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/50 transition-colors border-b last:border-0">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">
                  {c.name.slice(0, 2).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-semibold text-sm truncate">{c.name}</div>
                  <div className="text-xs text-muted-foreground font-mono">{c.phone}</div>
                </div>
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="relative flex items-center gap-3">
        <div className="flex-1 border-t" /><span className="text-xs text-muted-foreground">or create new</span><div className="flex-1 border-t" />
      </div>

      <div className="rounded-xl border bg-card/40 p-4 space-y-3">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          <User className="h-3.5 w-3.5" /> New patient
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-sm font-medium">Name *</label>
            <Input value={name} onChange={e => setName(e.target.value)} placeholder="Patient name" maxLength={120} />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Phone *</label>
            <div className="flex">
              <span className="flex select-none items-center rounded-l-md border border-r-0 bg-muted px-2.5 text-sm font-mono text-muted-foreground">+91</span>
              <Input type="tel" inputMode="numeric" className="rounded-l-none font-mono"
                value={phone} onChange={e => { setPhone(e.target.value); setPhoneErr(null); }}
                onBlur={() => { if (phone.trim()) { const v = validateIndianPhone(phone); setPhoneErr(v.ok ? null : v.error); } }}
                maxLength={15} placeholder="98765 43210" />
            </div>
            {phoneErr && <p className="mt-1 text-xs text-destructive">{phoneErr}</p>}
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Age</label>
            <Input type="number" inputMode="numeric" min={0} max={130} value={age} onChange={e => setAge(e.target.value)} placeholder="—" />
          </div>
        </div>
        {createErr && <p className="text-xs text-destructive">{createErr}</p>}
        <Button onClick={doCreate} disabled={creating || !name.trim() || !phone.trim()} className="w-full sm:w-auto">
          {creating ? <><Loader2 className="h-4 w-4 animate-spin" /> Creating…</> : <><Users className="h-4 w-4" /> Create & continue</>}
        </Button>
      </div>
    </div>
  );
}

/* ─── Step 2: Prescription entry ──────────────────────────────────────────── */
const ALLOWED = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
const MAX_BYTES = 10 * 1024 * 1024;

function PrescriptionStep({
  customer, pharmacyId, onSaved,
}: { customer: Customer; pharmacyId: string; onSaved: (prescriptionId: string, firstMed: string) => void }) {
  const qc = useQueryClient();
  const today = new Date().toISOString().slice(0, 10);
  const [mode, setMode] = useState<Mode>('upload');
  const [uploading, setUploading] = useState(false);
  const [uploadErr, setUploadErr] = useState<string | null>(null);
  const [attachment, setAttachment] = useState<{ url: string; name: string; type: string } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);

  // Rx fields
  const [doctor, setDoctor] = useState('');
  const [rxDate, setRxDate] = useState(today);
  const [diagnosis, setDiagnosis] = useState('');
  const [totalCost, setTotalCost] = useState('');
  const [medsText, setMedsText] = useState('');
  const [rxErr, setRxErr] = useState<string | null>(null);

  // Convert textarea lines → MedicineInput array
  const parsedMeds: MedicineInput[] = medsText
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(name => ({ ...EMPTY_MED, medicine_name: name }));

  const handleFile = async (file: File) => {
    setUploadErr(null);
    if (!ALLOWED.includes(file.type)) { setUploadErr('Only PDF, JPG, PNG, WEBP allowed.'); return; }
    if (file.size > MAX_BYTES) { setUploadErr('File over 10 MB limit.'); return; }
    setUploading(true);
    try {
      const ext = (file.name.split('.').pop() ?? 'bin').toLowerCase();
      const path = `${pharmacyId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      const { error: upErr } = await supabase.storage.from('crm-bill-attachments')
        .upload(path, file, { upsert: false, contentType: file.type });
      if (upErr) throw upErr;
      const { data: pub } = supabase.storage.from('crm-bill-attachments').getPublicUrl(path);
      setAttachment({ url: pub.publicUrl, name: file.name, type: file.type });
      setMode('manual'); // show fields after upload
    } catch (err) {
      setUploadErr(err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };



  const save = useMutation<string, Error>({
    mutationFn: async () => {
      if (parsedMeds.length === 0) throw new Error('Paste at least one medicine name.');
      const rx = await createPrescription({
        pharmacyId,
        customerId: customer.id,
        rx: {
          doctor_name: doctor.trim() || null,
          prescription_date: rxDate,
          follow_up_date: null,
          diagnosis: diagnosis.trim() || null,
          notes: null,
          attachment_url: attachment?.url ?? null,
          total_cost: totalCost ? parseFloat(totalCost) : null,
        },
        medicines: parsedMeds.length > 0 ? parsedMeds : [{ ...EMPTY_MED, medicine_name: '(see attached)' }],
      });
      return rx.id;
    },
    onSuccess: async (rxId) => {
      await qc.invalidateQueries({ queryKey: ['prescriptions', customer.id] });
      await qc.invalidateQueries({ queryKey: ['customer-activity', customer.id] });
      await qc.invalidateQueries({ queryKey: ['customers'] });
      await qc.invalidateQueries({ queryKey: ['dashboard-counts'] });
      onSaved(rxId, parsedMeds[0]?.medicine_name ?? '');
    },
    onError: (err) => setRxErr(err.message),
  });

  return (
    <div className="space-y-4">
      {/* Customer summary */}
      <div className="flex items-center gap-3 rounded-xl border bg-card/50 p-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-sm font-bold text-primary">
          {customer.name.slice(0, 2).toUpperCase()}
        </div>
        <div>
          <div className="font-semibold">{customer.name}</div>
          <div className="text-xs font-mono text-muted-foreground">{customer.phone}</div>
        </div>
        <Check className="ml-auto h-4 w-4 text-emerald-500" />
      </div>

      {/* Mode switch */}
      <div role="radiogroup" className="inline-flex w-full rounded-lg border bg-muted/60 p-1">
        {([['upload', <Upload className="h-3.5 w-3.5" />, 'Upload scan'], ['manual', <Pencil className="h-3.5 w-3.5" />, 'Enter manually']] as const).map(([m, icon, label]) => (
          <button key={m} type="button" role="radio" aria-checked={mode === m}
            onClick={() => setMode(m as Mode)}
            className={cn('inline-flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-semibold transition-all',
              mode === m ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:bg-background/60')}>
            {icon}{label}
          </button>
        ))}
      </div>

      {/* Upload zone */}
      {mode === 'upload' && !attachment && (
        <div
          onDragOver={e => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={e => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files?.[0]; if (f) handleFile(f); }}
          onClick={() => fileRef.current?.click()}
          className={cn('flex cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed p-8 text-center transition-colors',
            dragOver ? 'border-primary bg-primary/5' : 'border-border bg-background hover:border-primary/40',
            uploading && 'pointer-events-none opacity-60')}>
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-primary">
            {uploading ? <Loader2 className="h-6 w-6 animate-spin" /> : <Upload className="h-6 w-6" />}
          </div>
          <div>
            <div className="font-medium">{uploading ? 'Uploading…' : 'Drop bill or prescription here'}</div>
            <div className="text-xs text-muted-foreground mt-1">PDF, JPG, PNG, WEBP · up to 10 MB</div>
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={e => { e.stopPropagation(); fileRef.current?.click(); }}>
              <ImageIcon className="h-3.5 w-3.5" /> Browse files
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={e => { e.stopPropagation(); cameraRef.current?.click(); }}>
              <Camera className="h-3.5 w-3.5" /> Camera
            </Button>
          </div>
        </div>
      )}

      <input ref={fileRef} type="file" hidden accept={ALLOWED.join(',')} onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
      <input ref={cameraRef} type="file" hidden accept="image/*" capture="environment" onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
      {uploadErr && <p className="text-xs text-destructive">{uploadErr}</p>}

      {/* Attached preview */}
      {attachment && (
        <div className="space-y-3">
          <div className="flex items-center gap-3 rounded-xl border bg-card/50 p-3">
            <FileText className="h-5 w-5 text-primary shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium truncate">{attachment.name}</div>
              <div className="text-xs text-emerald-600">Uploaded ✓</div>
            </div>
            <button onClick={() => { setAttachment(null); setMode('upload'); }}
              className="rounded p-1 text-muted-foreground hover:text-destructive hover:bg-destructive/10">
              <XIcon className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {/* Prescription fields — show in manual mode or after upload */}
      {(mode === 'manual' || attachment) && (
        <div className="rounded-xl border bg-card/40 p-4 space-y-4">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            <Receipt className="h-3.5 w-3.5 text-primary" /> Prescription details
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 flex items-center gap-1.5 text-sm font-medium">
                <Stethoscope className="h-3.5 w-3.5 text-muted-foreground" /> Doctor
              </label>
              <Input value={doctor} onChange={e => setDoctor(e.target.value)} placeholder="Dr. Sharma" maxLength={120} />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">Prescription date</label>
              <Input type="date" className="font-mono" value={rxDate} onChange={e => setRxDate(e.target.value)} max={today} />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Diagnosis</label>
            <Input value={diagnosis} onChange={e => setDiagnosis(e.target.value)} placeholder="e.g. Hypertension" maxLength={240} />
          </div>

          {/* Medicines — paste zone */}
          <div className="rounded-lg border bg-background p-3 space-y-2">
            <div className="flex items-center justify-between text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              <span className="flex items-center gap-1.5"><Pill className="h-3.5 w-3.5" /> Medicines *</span>
              {parsedMeds.length > 0 && (
                <span className="rounded-full bg-primary/10 px-2 py-0.5 font-mono text-primary">{parsedMeds.length}</span>
              )}
            </div>
            <textarea
              value={medsText}
              onChange={e => setMedsText(e.target.value)}
              placeholder={`Paste prescription here — one medicine per line:\n\nCrocin 500mg\nAzithromycin 250mg\nPan-D`}
              rows={5}
              className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm font-mono leading-relaxed placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-ring"
            />
            {parsedMeds.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {parsedMeds.map((m, i) => (
                  <span key={i} className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                    <ClipboardPaste className="h-3 w-3 opacity-60" />
                    {m.medicine_name}
                  </span>
                ))}
              </div>
            )}
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Total Cost of Prescription (₹)</label>
            <Input type="number" min="0" step="0.01" value={totalCost} onChange={e => setTotalCost(e.target.value)} placeholder="0.00" />
          </div>
        </div>
      )}

      {rxErr && <p className="text-xs text-destructive">{rxErr}</p>}

      <Button onClick={() => save.mutate()} disabled={save.isPending || (mode === 'upload' && !attachment && parsedMeds.length === 0)} className="w-full" size="lg">
        {save.isPending ? <><Loader2 className="h-4 w-4 animate-spin" /> Saving…</> : <><Check className="h-4 w-4" /> Save prescription</>}
      </Button>
    </div>
  );
}

/* ─── Main page ───────────────────────────────────────────────────────────── */
export default function PrescriptionWorkflow() {
  const navigate = useNavigate();
  const { pharmacyId } = useActivePharmacy();
  const [step, setStep] = useState<Step>(1);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [prescriptionId, setPrescriptionId] = useState('');
  const [firstMed, setFirstMed] = useState('');
  const [reminderOpen, setReminderOpen] = useState(false);
  const [done, setDone] = useState(false);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Quick Prescription</h1>
          <p className="text-sm text-muted-foreground">Customer → Prescription → Reminder</p>
        </div>
      </header>

      <Card className="p-6">
        <StepBar step={step} />

        {done ? (
          <div className="flex flex-col items-center justify-center py-10 gap-4">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600">
              <Check className="h-8 w-8" />
            </div>
            <div className="text-center">
              <div className="text-xl font-bold">All done!</div>
              <div className="text-sm text-muted-foreground mt-1">Prescription saved{customer && ` for ${customer.name}`}</div>
            </div>
            <div className="flex gap-3 flex-wrap justify-center">
              {customer && (
                <Button variant="outline" onClick={() => navigate(`/customers/${customer.id}`)}>
                  <User className="h-4 w-4" /> View profile
                </Button>
              )}
              <Button onClick={() => { setStep(1); setCustomer(null); setPrescriptionId(''); setFirstMed(''); setDone(false); }}>
                <Plus className="h-4 w-4" /> New prescription
              </Button>
            </div>
          </div>
        ) : (
          <>
            {step === 1 && (
              <CustomerStep onSelected={c => { setCustomer(c); setStep(2); }} />
            )}
            {step === 2 && customer && (
              <PrescriptionStep
                customer={customer}
                pharmacyId={pharmacyId}
                onSaved={(rxId, med) => {
                  setPrescriptionId(rxId);
                  setFirstMed(med);
                  setStep(3);
                  setReminderOpen(true);
                }}
              />
            )}
            {step === 3 && !reminderOpen && (
              <div className="flex flex-col items-center gap-4 py-8">
                <div className="flex h-14 w-14 items-center justify-center rounded-full bg-amber-500/10 text-amber-600">
                  <Bell className="h-7 w-7" />
                </div>
                <div className="text-center">
                  <div className="font-semibold text-lg">Prescription saved!</div>
                  <div className="text-sm text-muted-foreground mt-1">Set a reminder to follow up?</div>
                </div>
                <div className="flex gap-3">
                  <Button variant="outline" onClick={() => setDone(true)}>Skip</Button>
                  <Button onClick={() => setReminderOpen(true)}>
                    <Clock className="h-4 w-4" /> Set reminder
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </Card>

      {customer && step >= 3 && (
        <QuickReminderDialog
          open={reminderOpen}
          onOpenChange={setReminderOpen}
          customerId={customer.id}
          customerName={customer.name}
          customerPhone={customer.phone}
          prescriptionId={prescriptionId}
          medicineName={firstMed}
          onScheduled={() => setDone(true)}
        />
      )}
    </div>
  );
}
