import { NavLink, Outlet } from 'react-router';
import { DatabaseBackup, Layers, Tags } from 'lucide-react';
import { PageBody, PageHeader } from '../../components/PageHeader';

const SECTIONS = [
  { to: '/settings/tax-years', label: 'Tax years', icon: Layers },
  { to: '/settings/categories', label: 'Custom categories', icon: Tags },
  { to: '/settings/backup', label: 'Backup and restore', icon: DatabaseBackup },
];

/** Settings shell: a sub-menu down the side on desktop, tabs across the top on phones. */
export function SettingsLayout() {
  return (
    <>
      <PageHeader title="Settings" subtitle="Manage tax years, categories, backups and other app settings." />
      <PageBody>
        <div className="lg:grid lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-8">
          <nav aria-label="Settings" className="mb-6 flex gap-2 overflow-x-auto lg:mb-0 lg:flex-col lg:gap-1">
            {SECTIONS.map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                className={({ isActive }) =>
                  `flex shrink-0 items-center gap-2.5 rounded-lg border px-3 py-2 text-sm whitespace-nowrap transition-colors ${
                    isActive
                      ? 'border-accent/40 bg-accent-bg font-medium text-accent-soft'
                      : 'border-transparent text-muted hover:bg-surface hover:text-ink'
                  }`
                }
              >
                <Icon className="size-4" aria-hidden />
                {label}
              </NavLink>
            ))}
          </nav>
          <div className="min-w-0">
            <Outlet />
          </div>
        </div>
      </PageBody>
    </>
  );
}

export function SettingsHeading({ title, description }: { title: string; description: string }) {
  return (
    <div>
      <h2 className="text-lg font-semibold text-white">{title}</h2>
      <p className="mt-1 text-sm text-muted">{description}</p>
    </div>
  );
}
