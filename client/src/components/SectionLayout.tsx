import type { ComponentType, ReactNode } from 'react';
import { NavLink, Outlet } from 'react-router';
import { PageBody, PageHeader } from './PageHeader';

export interface SectionLink {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
}

/** A page with a sub-menu down the side on desktop (tabs across the top on phones). */
export function SectionLayout({ title, subtitle, sections }: { title: string; subtitle: string; sections: SectionLink[] }) {
  return (
    <>
      <PageHeader title={title} subtitle={subtitle} />
      <PageBody>
        <div className="lg:grid lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-8 print:block">
          <nav aria-label={title} className="mb-6 flex gap-2 overflow-x-auto lg:mb-0 lg:flex-col lg:gap-1 print:hidden">
            {sections.map(({ to, label, icon: Icon }) => (
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

export function SectionHeading({ title, description, actions }: { title: string; description: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <h2 className="text-lg font-semibold text-white">{title}</h2>
        <p className="mt-1 text-sm text-muted">{description}</p>
      </div>
      {actions && <div className="flex shrink-0 gap-2 print:hidden">{actions}</div>}
    </div>
  );
}
