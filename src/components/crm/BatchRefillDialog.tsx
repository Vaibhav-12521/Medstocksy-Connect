import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, IndianRupee, RefreshCcw, CheckCircle2 } from 'lucide-react';
import { useActivePharmacy } from '@/contexts/PharmacyContext';
import { useT } from '@/contexts/LanguageContext';
import { recordRefill, type PrescriptionWithMeds } from '@/lib/api/prescriptions';
import { cn } from '@/lib/utils';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

interface BatchRefillDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customerId: string;
  prescription: PrescriptionWithMeds | null;
}

export function BatchRefillDialog({
  open, onOpenChange, customerId, prescription,
}: BatchRefillDialogProps) {
  const t = useT();
  const { pharmacyId } = useActivePharmacy();
  const qc = useQueryClient();

  // Track which medicines are selected for refill
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // Optional: common notes/bill for the whole batch
  const [totalBill, setTotalBill] = useState('');
  const [notes, setNotes] = useState('');

  useEffect(() => {
    if (!open || !prescription) return;
    // Default to all medicines selected
    setSelectedIds(new Set(prescription.medicines.map(m => m.id)));
    setTotalBill('');
    setNotes('');
  }, [open, prescription]);

  const toggleMed = (id: string) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
  };

  const save = useMutation<void, Error>({
    mutationFn: async () => {
      if (!prescription || selectedIds.size === 0) return;
      
      const billN = totalBill.trim() ? Number(totalBill) : null;
      if (billN != null && (Number.isNaN(billN) || billN < 0)) {
        throw new Error('Bill amount must be a positive number.');
      }

      const medsToRefill = prescription.medicines.filter(m => selectedIds.has(m.id));
      
      // We record a refill for each item. 
      // If a total bill is provided, we'll associate it with the first item 
      // (or distribute it, but for now let's just record it once to avoid inflating LTV too much).
      // Actually, LTV sums all refill bill_amounts. If we put the full bill on one item, it works for LTV.
      
      await Promise.all(medsToRefill.map((m, i) => 
        recordRefill({
          pharmacyId,
          prescriptionId: prescription.id,
          medicineId: m.id,
          customerId,
          quantityDispensed: m.quantity, // Use default Rx quantity
          billAmount: i === 0 ? billN : null, // Record total bill on the first item
          notes: notes.trim() || null,
        })
      ));
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['prescriptions', customerId] });
      await qc.invalidateQueries({ queryKey: ['customer-activity', customerId] });
      await qc.invalidateQueries({ queryKey: ['customer', customerId] });
      await qc.invalidateQueries({ queryKey: ['customers'] });
      onOpenChange(false);
    },
  });

  if (!prescription) return null;

  const canSubmit = !save.isPending && selectedIds.size > 0;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!save.isPending) onOpenChange(v); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <RefreshCcw className="h-4 w-4 text-primary" />
            Refill Prescription
          </DialogTitle>
          <DialogDescription>
            Select items to refill from this prescription.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Medicine Selection */}
          <div className="max-h-[30vh] overflow-y-auto rounded-xl border bg-card/40 p-1">
            {prescription.medicines.map((m) => (
              <div 
                key={m.id} 
                className={cn(
                  "flex items-center gap-3 rounded-lg p-2.5 transition-colors cursor-pointer hover:bg-accent/50",
                  selectedIds.has(m.id) ? "bg-primary/5" : "opacity-60"
                )}
                onClick={() => toggleMed(m.id)}
              >
                <input 
                  type="checkbox"
                  checked={selectedIds.has(m.id)} 
                  onChange={() => toggleMed(m.id)}
                  onClick={(e) => e.stopPropagation()}
                  className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
                />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium leading-none">{m.medicine_name}</div>
                  <div className="mt-1 text-[10px] text-muted-foreground uppercase tracking-wider">
                    {m.dosage} {m.frequency}
                  </div>
                </div>
                {m.refill_stats.count > 0 && (
                  <div className="flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[9px] font-bold text-emerald-600">
                    <CheckCircle2 className="h-2.5 w-2.5" />
                    {m.refill_stats.count}
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="grid grid-cols-1 gap-3">
            <div>
              <label className="mb-1 block text-sm font-medium">Total Bill Amount (₹)</label>
              <div className="flex h-10 items-stretch overflow-hidden rounded-md border border-input bg-background focus-within:ring-2 focus-within:ring-ring">
                <span className="flex shrink-0 select-none items-center border-r bg-muted/40 px-2 text-muted-foreground">
                  <IndianRupee className="h-3.5 w-3.5" />
                </span>
                <input
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="0.01"
                  value={totalBill}
                  onChange={(e) => setTotalBill(e.target.value)}
                  placeholder="0.00"
                  className="min-w-0 flex-1 bg-transparent px-2 font-mono text-sm focus:outline-none"
                />
              </div>
              <p className="mt-1 text-[10px] text-muted-foreground">
                Leave empty if items were dispensed without charge or bill is separate.
              </p>
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium">
                Internal Notes
                <span className="ml-1 text-xs font-normal text-muted-foreground">({t('common.optional')})</span>
              </label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="e.g. Full prescription dispensed"
                maxLength={500}
                className={cn(
                  'block h-16 w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
                )}
              />
            </div>
          </div>

          {save.isError && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {save.error.message}
            </div>
          )}
        </div>

        <DialogFooter className="mt-2">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={save.isPending}>
            {t('btn.cancel')}
          </Button>
          <Button onClick={() => save.mutate()} disabled={!canSubmit}>
            {save.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            {save.isPending ? 'Processing…' : 'Record Refill'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
