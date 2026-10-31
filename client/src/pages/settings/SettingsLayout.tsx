import { DatabaseBackup, Landmark, Layers, Tags, Users } from 'lucide-react';
import { SectionHeading, SectionLayout } from '../../components/SectionLayout';
import { useCanEdit } from '../../lib/queries';

const SECTIONS = [
  { to: '/settings/people', label: 'People', icon: Users },
  { to: '/settings/tax-years', label: 'Tax Years', icon: Layers },
  { to: '/settings/hmrc', label: 'HMRC', icon: Landmark },
  { to: '/settings/categories', label: 'Custom Categories', icon: Tags },
  { to: '/settings/backup', label: 'Backup and Restore', icon: DatabaseBackup },
];

export function SettingsLayout() {
  // Backups are for editors only.
  const canEdit = useCanEdit();
  return (
    <SectionLayout
      title="Settings"
      subtitle="Manage people, tax years, the HMRC connection, categories, backups and other app settings."
      sections={canEdit ? SECTIONS : SECTIONS.filter((s) => s.to !== '/settings/backup')}
    />
  );
}

export const SettingsHeading = SectionHeading;
