import { CircleArrowUp, CreditCard, DatabaseBackup, Landmark, Layers, Sparkles, Tags, Users } from 'lucide-react';
import { SectionHeading, SectionLayout } from '../../components/SectionLayout';
import { useCanEdit, useHmrc } from '../../lib/queries';

const SECTIONS = [
  { to: '/settings/users', label: 'Users', icon: Users },
  { to: '/settings/tax-years', label: 'Tax Years', icon: Layers },
  { to: '/settings/hmrc', label: 'HMRC', icon: Landmark },
  { to: '/settings/claude', label: 'Claude Integration', icon: Sparkles },
  { to: '/settings/square', label: 'Square', icon: CreditCard },
  { to: '/settings/categories', label: 'Custom Categories', icon: Tags },
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
      subtitle="Manage users, tax years, categories, the Claude integration, Square, backups, updates and other app settings."
      sections={SECTIONS.filter((s) => (s.to !== '/settings/backup' || canEdit) && (s.to !== '/settings/hmrc' || hmrc?.configured))}
      ready={!!hmrc}
    />
  );
}

export const SettingsHeading = SectionHeading;
