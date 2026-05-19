import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import type { MemberRole } from '@/types/database';
import { useAuth } from './AuthContext';
import { storage } from '@/lib/utils';

interface PharmacyMembership {
  pharmacyId: string;
  pharmacyName: string;
  role: MemberRole;
  logoUrl: string | null;
}

interface PharmacyContextValue {
  loading: boolean;
  error: Error | null;
  memberships: PharmacyMembership[];
  activePharmacyId: string | null;
  activeRole: MemberRole | null;
  setActivePharmacy: (id: string) => void;
  /** True ONLY when the query succeeded and returned no memberships. */
  needsPharmacy: boolean;
}

const PharmacyContext = createContext<PharmacyContextValue | null>(null);
const STORAGE_KEY = 'medcrm.activePharmacyId';

export function PharmacyProvider({ children }: { children: ReactNode }) {
  const { user, loading: authLoading } = useAuth();
  const [activePharmacyId, setActivePharmacyId] = useState<string | null>(() =>
    storage.get<string | null>(STORAGE_KEY, null)
  );

  interface MembershipRow {
    pharmacy_id: string;
    role: MemberRole;
    pharmacy_name: string;
    pharmacy_logo_url: string | null;
  }

  const { data: memberships = [], isLoading, isError, error: queryError, isSuccess } =
    useQuery<PharmacyMembership[]>({
      queryKey: ['memberships', user?.id],
      enabled: !!user,
      queryFn: async () => {
        // crm_my_pharmacies is a view that already inlines pharmacy_name +
        // pharmacy_logo_url — single SELECT, no joins needed.
        const { data, error } = await supabase
          .from('crm_my_pharmacies')
          .select('pharmacy_id, role, pharmacy_name, pharmacy_logo_url')
          .order('pharmacy_id');
        if (error) {
          console.error('[PharmacyContext] memberships query failed:', error);
          const detail = [error.message, error.details, error.hint, error.code]
            .filter(Boolean)
            .join(' · ');
          throw new Error(detail || 'Failed to load memberships');
        }
        return ((data ?? []) as unknown as MembershipRow[]).map((row) => ({
          pharmacyId: row.pharmacy_id,
          pharmacyName: row.pharmacy_name,
          role: row.role,
          logoUrl: row.pharmacy_logo_url,
        }));
      },
      retry: 1,
    });

  // Reconcile activePharmacyId with the memberships list:
  //   • no active yet  → pick the first membership
  //   • active stale   → it points to a pharmacy the user no longer has access
  //                       to (deleted or removed); fall back to the first valid
  //                       membership AND clear the stale localStorage entry.
  useEffect(() => {
    if (memberships.length === 0) return;
    const stillValid = activePharmacyId && memberships.some((m) => m.pharmacyId === activePharmacyId);
    if (!stillValid) {
      const firstId = memberships[0]?.pharmacyId ?? null;
      setActivePharmacyId(firstId);
      if (firstId) storage.set(STORAGE_KEY, firstId);
      else storage.remove(STORAGE_KEY);
    }
  }, [activePharmacyId, memberships]);

  // Stable callback identity prevents children that depend on this from
  // re-rendering whenever PharmacyProvider re-renders.
  const setActivePharmacy = useCallback((id: string) => {
    setActivePharmacyId(id);
    storage.set(STORAGE_KEY, id);
  }, []);

  const activeRole = memberships.find((m) => m.pharmacyId === activePharmacyId)?.role ?? null;
  // Only set needsPharmacy when the query genuinely succeeded with empty data.
  // A failed query (e.g. PostgREST 400) must NOT trigger an onboarding redirect.
  const needsPharmacy =
    !authLoading && !isLoading && !!user && isSuccess && memberships.length === 0;

  // Memoise the context value — without this, every render of PharmacyProvider
  // (and there are many, since auth + query state flip during loads) creates
  // a brand-new object and forces every consumer to re-render even when none
  // of the fields actually changed.
  const value = useMemo(() => ({
    loading: authLoading || isLoading,
    error: isError ? (queryError as Error) : null,
    memberships,
    activePharmacyId,
    activeRole,
    setActivePharmacy,
    needsPharmacy,
  }), [authLoading, isLoading, isError, queryError, memberships, activePharmacyId, activeRole, setActivePharmacy, needsPharmacy]);

  return (
    <PharmacyContext.Provider value={value}>
      {children}
    </PharmacyContext.Provider>
  );
}

export function usePharmacy() {
  const ctx = useContext(PharmacyContext);
  if (!ctx) throw new Error('usePharmacy must be used inside <PharmacyProvider>');
  return ctx;
}

/** Throws if not active — use in pages where activePharmacyId is mandatory */
export function useActivePharmacy(): { pharmacyId: string; role: MemberRole; pharmacyName: string; logoUrl: string | null } {
  const { activePharmacyId, activeRole, memberships } = usePharmacy();
  const active = memberships.find((m) => m.pharmacyId === activePharmacyId);
  if (!activePharmacyId || !activeRole || !active) {
    throw new Error('No active pharmacy. Wrap component in <RequirePharmacy>.');
  }
  return {
    pharmacyId: activePharmacyId,
    role: activeRole,
    pharmacyName: active.pharmacyName,
    logoUrl: active.logoUrl,
  };
}
