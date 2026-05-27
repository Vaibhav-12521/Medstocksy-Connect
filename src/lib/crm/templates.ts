import { TemplateKind } from '@/types/database';
import { TranslationKey } from '@/i18n/translations';

export interface TemplateMetadata {
  label: string;
  key: TranslationKey;
  color: string;
}

export const TEMPLATE_KINDS: Record<TemplateKind, TemplateMetadata> = {
  thank_you: {
    label: 'T1',
    key: 'templates.kind.thank_you',
    color: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
  },
  refill_reminder: {
    label: 'T2',
    key: 'templates.kind.refill_reminder',
    color: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300',
  },
  offer: {
    label: 'T3',
    key: 'templates.kind.offer',
    color: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300',
  },
  win_back: {
    label: 'T4',
    key: 'templates.kind.win_back',
    color: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
  },
  out_of_stock: {
    label: 'T5',
    key: 'templates.kind.out_of_stock',
    color: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
  },
  custom: {
    label: 'C',
    key: 'templates.kind.custom',
    color: 'bg-muted text-muted-foreground',
  },
};

export const VARIABLE_CHIPS = [
  'name',
  'pharmacy_name',
  'medicine',
  'amount',
  'pharmacy_phone',
  'discount',
  'category',
  'date',
] as const;

/**
 * Deduplicate templates by pharmacy_id, name, and language.
 * Picks the most recently created one if duplicates exist.
 */
export function deduplicateTemplates<T extends { pharmacy_id: string | null; name: string; language: string; created_at: string }>(templates: T[]): T[] {
  return templates.reduce((acc: T[], t) => {
    const key = `${t.pharmacy_id ?? 'global'}:${t.name}:${t.language}`;
    const existingIdx = acc.findIndex(item => `${item.pharmacy_id ?? 'global'}:${item.name}:${item.language}` === key);
    if (existingIdx === -1) {
      acc.push(t);
    } else if (new Date(t.created_at) > new Date(acc[existingIdx]!.created_at)) {
      acc[existingIdx] = t;
    }
    return acc;
  }, []);
}
