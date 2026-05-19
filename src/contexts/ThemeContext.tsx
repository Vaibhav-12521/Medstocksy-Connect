import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { storage } from '@/lib/utils';

export type Theme = 'light' | 'dark' | 'system';

interface ThemeContextValue {
  theme: Theme;             // user's stored preference (light | dark | system)
  resolvedTheme: 'light' | 'dark';  // what's actually applied to <html>
  setTheme: (next: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);
const STORAGE_KEY = 'medcrm.theme';

function getSystemTheme(): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(t: 'light' | 'dark') {
  const root = document.documentElement;
  root.classList.toggle('dark', t === 'dark');
  root.style.colorScheme = t;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() =>
    storage.get<Theme>(STORAGE_KEY, 'system')
  );
  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>(() =>
    theme === 'system' ? getSystemTheme() : theme
  );

  // Keep <html> class in sync with the resolved theme.
  useEffect(() => {
    const next = theme === 'system' ? getSystemTheme() : theme;
    setResolvedTheme(next);
    applyTheme(next);
  }, [theme]);

  // When the user picks "system", react to OS-level changes live.
  useEffect(() => {
    if (theme !== 'system' || typeof window === 'undefined') return;
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => {
      const next = mql.matches ? 'dark' : 'light';
      setResolvedTheme(next);
      applyTheme(next);
    };
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    storage.set(STORAGE_KEY, next);
  }, []);

  const value = useMemo(
    () => ({ theme, resolvedTheme, setTheme }),
    [theme, resolvedTheme, setTheme]
  );

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>');
  return ctx;
}
