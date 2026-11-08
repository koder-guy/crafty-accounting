import { Briefcase, CircleArrowUp, DatabaseBackup, Landmark, Layers, LockKeyhole, Sparkles, Tags, Users } from 'lucide-react';
import { SectionHeading, SectionLayout } from '../../components/SectionLayout';
import { SquareLogo } from '../../components/SquareLogo';
import { useCanEdit, useHmrc } from '../../lib/queries';

const SECTIONS = [
  { to: '/settings/business', label: 'Business Details', icon: Briefcase },
  { to: '/settings/users', label: 'Users', icon: Users },
  { to: '/settings/tax-years', label: 'Tax Years', icon: Layers },
  { to: '/settings/hmrc', label: 'HMRC', icon: Landmark },
  { to: '/settings/ai', label: 'AI Document Scanning', icon: Sparkles },
  { to: '/settings/square', label: 'Square Integration', icon: SquareLogo },
  { to: '/settings/categories', label: 'Custom Categories', icon: Tags },
  { to: '/settings/https', label: 'HTTPS Certificate', icon: LockKeyhole },
  { to: '/settings/backup', label: 'Backup and Restore', icon: DatabaseBackup },
  { to: '/settings/updates', label: 'Updates', icon: CircleArrowUp },
];

export function SettingsLayout() {
  // Backups are for editors only; HMRC only with credentials set.
  const canEdit = useCanEdit();
  const { data: hmrc } = useHmrc();
  return (
    <SectionLayout
      title="Settings"
      subtitle="Manage your application settings here"
      sections={SECTIONS.filter((s) => (s.to !== '/settings/backup' || canEdit) && (s.to !== '/settings/hmrc' || hmrc?.configured))}
      ready={!!hmrc}
    />
  );
}

export const SettingsHeading = SectionHeading;
