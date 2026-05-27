import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, Pill, IndianRupee, RefreshCcw } from 'lucide-react';
import { useActivePharmacy } from '@/contexts/PharmacyContext';
import { useT } from '@/contexts/LanguageContext';
import { recordRefill, type MedicineWithRefills } from '@/lib/api/prescriptions';
import { cn } from '@/lib/utils';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

interface RefillDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customerId: string;
  prescriptionId: string;
  medicine: MedicineWithRefills | null;
}

export function RefillDialog({
  open, onOpenChange, customerId, prescriptionId, medicine,
}: RefillDialogProps) {
  const t = useT();
  const { pharmacyId } = useActivePharmacy();
  const qc = useQueryClient();

  const [qty, setQty] = useState<string>('');
  const [bill, setBill] = useState<string>('');
  const [notes, setNotes] = useState('');

  useEffect(() => {
    if (!open || !medicine) return;
    // Pre-fill quantity with the prescription's default if available.
    setQty(medicine.quantity != null ? String(medicine.quantity) : '');
    setBill('');
    setNotes('');
  }, [open, medicine]);

  const save = useMutation<void, Error>({
    mutationFn: async () => {
      if (!medicine) return;
      const qtyN = qty.trim() ? parseInt(qty, 10) : null;
      if (qtyN != null && (Number.isNaN(qtyN) || qtyN < 1 || qtyN > 999)) {
        throw new Error('Quantity must be 1–999.');
      }
      const billN = bill.trim() ? Number(bill) : null;
      if (billN != null && (Number.isNaN(billN) || billN < 0)) {
        throw new Error('Bill amount must be a positive number.');
      }
      await recordRefill({
        pharmacyId,
        prescriptionId,
        medicineId: medicine.id,
        customerId,
        quantityDispensed: qtyN,
        billAmount: billN,
        notes: notes.trim() || null,
      });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['prescriptions', customerId] });
      await qc.invalidateQueries({ queryKey: ['customer-activity', customerId] });
      await qc.invalidateQueries({ queryKey: ['customer', customerId] });
      await qc.invalidateQueries({ queryKey: ['customers'] });
      onOpenChange(false);
    },
  });

  if (!medicine) return null;

  const nextInterval = medicine.refill_interval_days ?? 0;
  const canSubmit = !save.isPending;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!save.isPending) onOpenChange(v); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <RefreshCcw className="h-4 w-4 text-primary" />
            {t('refill.title')}
          </DialogTitle>
          <DialogDescription>
            {t('refill.subtitle').replace('{medicine}', medicine.medicine_name)}
          </DialogDescription>
        </DialogHeader>

        {/* Medicine summary card */}
        <div className="rounded-xl border bg-card/40 p-3">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Pill className="h-3.5 w-3.5 text-primary" />
            {medicine.medicine_name}
            {medicine.dosage && <span className="text-muted-foreground">· {medicine.dosage}</span>}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
            <span>{medicine.frequency}</span>
            {medicine.refill_stats.count > 0 && (
              <span>· {t('refill.prior_count').replace('{n}', String(medicine.refill_stats.count))}</span>
            )}
            {nextInterval > 0 && (
              <span>· {t('refill.next_in').replace('{n}', String(nextInterval))}</span>
            )}
          </div>
        </div>

        <form
          onSubmit={(e) => { e.preventDefault(); if (canSubmit) save.mutate(); }}
          className="space-y-3"
        >
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-sm font-medium">{t('refill.quantity')}</label>
              <div className="flex h-10 items-stretch overflow-hidden rounded-md border border-input bg-background focus-within:ring-2 focus-within:ring-ring">
                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={999}
                  value={qty}
                  onChange={(e) => setQty(e.target.value)}
                  className="min-w-0 flex-1 bg-transparent px-2 font-mono text-sm focus:outline-none"
                />
                <span className="flex shrink-0 select-none items-center border-l bg-muted/40 px-2.5 text-[11px] text-muted-foreground">
                  {t('rx.unit_pcs')}
                </span>
              </div>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">{t('refill.bill_amount')}</label>
              <div className="flex h-10 items-stretch overflow-hidden rounded-md border border-input bg-background focus-within:ring-2 focus-within:ring-ring">
                <span className="flex shrink-0 select-none items-center border-r bg-muted/40 px-2 text-muted-foreground">
                  <IndianRupee className="h-3.5 w-3.5" />
                </span>
                <input
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="0.01"
                  value={bill}
                  onChange={(e) => setBill(e.target.value)}
                  placeholder="0.00"
                  className="min-w-0 flex-1 bg-transparent px-2 font-mono text-sm focus:outline-none"
                />
              </div>
            </div>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium">
              {t('refill.notes')}
              <span className="ml-1 text-xs font-normal text-muted-foreground">({t('common.optional')})</span>
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={t('refill.notes_placeholder')}
              maxLength={500}
              className={cn(
                'block h-16 w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
              )}
            />
          </div>

          {save.isError && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {save.error.message}
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={save.isPending}>
              {t('btn.cancel')}
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {save.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              {save.isPending ? t('btn.saving') : t('refill.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
