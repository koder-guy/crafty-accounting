import { useEffect } from 'react';
import { Navigate, useLocation } from 'react-router';
import { DatabaseBackup, Landmark, Layers, Tags, Users } from 'lucide-react';
import { SectionHeading, SectionLayout } from '../../components/SectionLayout';
import { useCanEdit, useHmrc } from '../../lib/queries';

const SECTIONS = [
  { to: '/settings/people', label: 'People', icon: Users },
  { to: '/settings/tax-years', label: 'Tax Years', icon: Layers },
  { to: '/settings/hmrc', label: 'HMRC', icon: Landmark },
  { to: '/settings/categories', label: 'Custom Categories', icon: Tags },
  { to: '/settings/backup', label: 'Backup and Restore', icon: DatabaseBackup },
];

/** The Settings pages this person can see, and whether that's settled (HMRC's status has loaded). */
function useSections() {
  // Backups are for editors only; HMRC only with credentials set.
  const canEdit = useCanEdit();
  const { data: hmrc } = useHmrc();
  const sections = SECTIONS.filter((s) => (s.to !== '/settings/backup' || canEdit) && (s.to !== '/settings/hmrc' || hmrc?.configured));
  return { sections, settled: !!hmrc };
}

// The last Settings page shown in this tab, so coming back to Settings opens it again.
const LAST_PAGE_KEY = 'crafty.settingsPage';

function lastPage(): string | null {
  try {
    return sessionStorage.getItem(LAST_PAGE_KEY);
  } catch {
    return null;
  }
}

export function SettingsLayout() {
  const { sections } = useSections();
  const { pathname } = useLocation();
  const isSection = sections.some((s) => s.to === pathname);
  useEffect(() => {
    if (!isSection) return;
    try {
      sessionStorage.setItem(LAST_PAGE_KEY, pathname);
    } catch {
      // Storage unavailable: Settings opens on its first page.
    }
  }, [isSection, pathname]);
  return (
    <SectionLayout
      title="Settings"
      subtitle="Manage people, tax years, categories, backups and other app settings."
      sections={sections}
    />
  );
}

/** `/settings` itself: the page last shown in this tab, if it's still available, else People. */
export function SettingsIndex() {
  const { sections, settled } = useSections();
  if (!settled) return null;
  const last = lastPage();
  return <Navigate to={sections.some((s) => s.to === last) ? last! : '/settings/people'} replace />;
}

export const SettingsHeading = SectionHeading;
