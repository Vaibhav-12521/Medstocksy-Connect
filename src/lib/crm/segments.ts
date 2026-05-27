import { TranslationKey } from '@/i18n/translations';

export interface SegmentMetadata {
  key: string;
  labelKey: TranslationKey;
  descKey: TranslationKey;
  helpKey: TranslationKey;
  color: string;
  dark?: boolean;
}

/** Guaranteed-present "all customers" segment. Exported so lookups always
 *  have a non-undefined fallback (Record<string,…> access is optional under
 *  strict mode). */
export const ALL_SEGMENT: SegmentMetadata = {
  key: 'all',
  labelKey: 'campaigns.seg.all',
  descKey: 'campaigns.seg.all', // fallback
  helpKey: 'campaigns.seg.all', // fallback
  color: 'bg-muted text-muted-foreground',
};

export const SEGMENTS: Record<string, SegmentMetadata> = {
  all: ALL_SEGMENT,
  new: {
    key: 'new',
    labelKey: 'segments.new.label',
    descKey: 'segments.new.desc',
    helpKey: 'segments.new.help',
    color: 'bg-tag-new-bg text-tag-new-fg',
  },
  repeat: {
    key: 'repeat',
    labelKey: 'segments.repeat.label',
    descKey: 'segments.repeat.desc',
    helpKey: 'segments.repeat.help',
    color: 'bg-tag-repeat-bg text-tag-repeat-fg',
  },
  high_value: {
    key: 'high_value',
    labelKey: 'segments.high.label',
    descKey: 'segments.high.desc',
    helpKey: 'segments.high.help',
    color: 'bg-tag-high-bg text-tag-high-fg',
    dark: true,
  },
  inactive: {
    key: 'inactive',
    labelKey: 'segments.inactive.label',
    descKey: 'segments.inactive.desc',
    helpKey: 'segments.inactive.help',
    color: 'bg-tag-inactive-bg text-tag-inactive-fg',
  },
  chronic: {
    key: 'chronic',
    labelKey: 'segments.chronic.label',
    descKey: 'segments.chronic.desc',
    helpKey: 'segments.chronic.help',
    color: 'bg-tag-chronic-bg text-tag-chronic-fg',
  },
  optout: {
    key: 'optout',
    labelKey: 'segments.optout.label',
    descKey: 'segments.optout.desc',
    helpKey: 'segments.optout.help',
    color: 'bg-tag-optout-bg text-tag-optout-fg',
  },
};

export const SEGMENT_OPTIONS = Object.values(SEGMENTS).filter(s => s.key !== 'optout');

/** Always returns a valid segment — falls back to "all" for unknown keys. */
export function getSegment(key: string | null | undefined): SegmentMetadata {
  return (key ? SEGMENTS[key] : undefined) ?? ALL_SEGMENT;
}
