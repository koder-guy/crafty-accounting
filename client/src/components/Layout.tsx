import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import {
  ArrowDownRight,
  ArrowUpRight,
  CalendarDays,
  FileSpreadsheet,
  Layers,
  LogOut,
  Menu,
  Settings,
  TrendingUp,
  Wallet,
  X,
} from 'lucide-react';
import { APP_NAME, APP_VERSION, displayTaxYear, taxYearStartYearForDate, todayIso } from '@crafty/shared';
import { useLogout, useTaxYearMutations, useTaxYears } from '../lib/queries';

function Brand() {
  return (
    <div className="flex items-center gap-3.5">
      <div className="flex size-11 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-indigo-500 shadow-lg shadow-indigo-900/40">
        <Wallet className="size-6 text-white" aria-hidden />
      </div>
      <div className="leading-tight">
        <div className="text-lg font-bold text-white">Crafty</div>
        <div className="text-xs font-semibold tracking-[0.18em] text-accent-soft">ACCOUNTING</div>
      </div>
    </div>
  );
}

function TaxYearSwitcher() {
  const { data } = useTaxYears();
  const { setActive } = useTaxYearMutations();
  const currentStart = taxYearStartYearForDate(todayIso());

  if (!data) return <div className="h-11 rounded-lg border border-line bg-surface" />;
  if (data.taxYears.length === 0) {
    return (
      <NavLink to="/tax-years" className="block rounded-lg border border-dashed border-line-strong px-3 py-2.5 text-sm text-muted hover:text-ink">
        Create your first tax year →
      </NavLink>
    );
  }

  return (
    <div className="relative">
      <label htmlFor="active-tax-year" className="sr-only">
        Active tax year
      </label>
      <select
        id="active-tax-year"
        value={data.activeTaxYearId ?? ''}
        disabled={setActive.isPending}
        onChange={(e) => setActive.mutate(Number(e.target.value))}
        className="w-full cursor-pointer appearance-none rounded-lg border border-line-strong bg-surface py-2.5 pr-10 pl-3 text-sm text-ink hover:border-accent-soft/50 focus:border-accent focus:outline-none"
      >
        {data.taxYears.map((year) => (
          <option key={year.id} value={year.id}>
            Tax Year {displayTaxYear(year.label)}
            {Number(year.label.slice(0, 4)) === currentStart ? ' (Current)' : ''}
          </option>
        ))}
      </select>
      <CalendarDays className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted" aria-hidden />
    </div>
  );
}

function NavItem({
  to,
  icon,
  label,
  count,
  end,
}: {
  to: string;
  icon: React.ReactNode;
  label: string;
  count?: number;
  end?: boolean;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        `flex items-center gap-3 rounded-xl border px-4 py-3 text-[15px] transition-colors ${
          isActive
            ? 'border-white/80 bg-surface font-medium text-accent-soft'
            : 'border-transparent text-ink/90 hover:bg-surface hover:text-white'
        }`
      }
    >
      {icon}
      <span className="flex-1">{label}</span>
      {count !== undefined && (
        <span className="tabular min-w-7 rounded-full bg-surface-2 px-2 py-0.5 text-center text-xs text-muted">{count}</span>
      )}
    </NavLink>
  );
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { data } = useTaxYears();
  const logout = useLogout();
  const active = data?.taxYears.find((y) => y.id === data.activeTaxYearId);

  return (
    <div className="flex h-full flex-col" onClick={(e) => (e.target as HTMLElement).closest('a') && onNavigate?.()}>
      <div className="hidden border-b border-line px-6 py-6 lg:block">
        <Brand />
      </div>
      <div className="border-b border-line px-4 py-5">
        <div className="eyebrow mb-2.5 px-1">Active tax year</div>
        <TaxYearSwitcher />
      </div>
      <nav className="flex-1 space-y-1.5 overflow-y-auto px-4 py-5" aria-label="Main">
        <NavItem to="/" end icon={<TrendingUp className="size-5 text-accent-soft" aria-hidden />} label="Dashboard" />
        <NavItem
          to="/incoming"
          icon={<ArrowDownRight className="size-5 text-in-soft" aria-hidden />}
          label="Incoming"
          count={active?.incomeCount}
        />
        <NavItem
          to="/outgoing"
          icon={<ArrowUpRight className="size-5 text-out-soft" aria-hidden />}
          label="Outgoing"
          count={active?.expenseCount}
        />
        <NavItem to="/mtd" icon={<FileSpreadsheet className="size-5 text-muted" aria-hidden />} label="MTD Quarterly" />
        <NavItem to="/tax-years" icon={<Layers className="size-5 text-muted" aria-hidden />} label="Tax Years Management" />
        <NavItem to="/settings" icon={<Settings className="size-5 text-muted" aria-hidden />} label="Settings" />
      </nav>
      <div className="flex items-end justify-between gap-2 border-t border-line px-5 py-4">
        <div className="text-xs leading-relaxed">
          <div className="font-semibold text-ink/80">
            {APP_NAME} v{APP_VERSION}
          </div>
          <div className="text-faint">SQLite database</div>
        </div>
        <button
          type="button"
          onClick={() => logout.mutate()}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted hover:bg-surface-2 hover:text-ink"
        >
          <LogOut className="size-3.5" aria-hidden />
          Sign out
        </button>
      </div>
    </div>
  );
}

export function Layout() {
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setMenuOpen(false), [location.pathname]);

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[300px_1fr]">
      {/* Mobile top bar */}
      <div className="sticky top-0 z-30 flex items-center justify-between border-b border-line bg-sidebar/95 px-4 py-3 backdrop-blur lg:hidden">
        <Brand />
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          aria-expanded={menuOpen}
          aria-label={menuOpen ? 'Close menu' : 'Open menu'}
          className="rounded-lg p-2 text-muted hover:bg-surface hover:text-ink"
        >
          {menuOpen ? <X className="size-6" /> : <Menu className="size-6" />}
        </button>
      </div>
      {menuOpen && (
        <div className="fixed inset-x-0 top-[69px] bottom-0 z-20 bg-sidebar lg:hidden">
          <Sidebar onNavigate={() => setMenuOpen(false)} />
        </div>
      )}

      <aside className="sticky top-0 hidden h-screen border-r border-line bg-sidebar lg:block">
        <Sidebar />
      </aside>
      <main className="min-w-0">
        <Outlet />
      </main>
    </div>
  );
}
