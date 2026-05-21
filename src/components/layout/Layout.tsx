import { Outlet } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { Menu } from 'lucide-react';
import { AppSidebar } from './AppSidebar';
import { RemindersBell } from './RemindersBell';
import { TodayRemindersPopup } from './TodayRemindersPopup';
import { Button } from '@/components/ui/button';
import { cn, storage } from '@/lib/utils';

const COLLAPSED_KEY = 'medcrm.sidebar.collapsed';

export function Layout() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<boolean>(() =>
    storage.get<boolean>(COLLAPSED_KEY, false)
  );

  useEffect(() => {
    storage.set(COLLAPSED_KEY, collapsed);
  }, [collapsed]);

  const toggleCollapsed = () => setCollapsed((v) => !v);

  return (
    <div className="min-h-screen bg-background">
      <AppSidebar
        collapsed={collapsed}
        onToggleCollapsed={toggleCollapsed}
        mobileOpen={mobileOpen}
        onMobileClose={() => setMobileOpen(false)}
      />

      {/* Mobile backdrop */}
      {mobileOpen && (
        <button
          aria-label="Close menu"
          onClick={() => setMobileOpen(false)}
          className="fixed inset-0 z-30 bg-foreground/40 backdrop-blur-sm md:hidden"
        />
      )}

      {/* Mobile top bar */}
      <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b bg-background px-4 md:hidden">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setMobileOpen((v) => !v)}
          aria-label="Open menu"
        >
          <Menu className="h-5 w-5" />
        </Button>
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded bg-primary text-xs font-bold text-primary-foreground">
            M
          </div>
          <span className="font-semibold">Medstocksy</span>
        </div>
      </header>

      {/* Main content — width compensates for sidebar */}
      <main
        className={cn(
          'transition-[padding] duration-200 ease-out',
          collapsed ? 'md:pl-16' : 'md:pl-64'
        )}
      >
        <div className="mx-auto max-w-[1440px] animate-fade-in p-4 md:p-8">
          <Outlet />
        </div>
      </main>

      {/* Reminders bell — fixed top-right; respects rate limit + opt-out */}
      <RemindersBell />

      {/* Top-5 reminders popup — auto-opens once per day when there's work to do */}
      <TodayRemindersPopup />
    </div>
  );
}
