import { DatabaseBackup, Landmark, Layers, Tags, Users } from 'lucide-react';
import { SectionHeading, SectionLayout } from '../../components/SectionLayout';
import { useCanEdit } from '../../lib/queries';

const SECTIONS = [
  { to: '/settings/tax-years', label: 'Tax years', icon: Layers },
  { to: '/settings/categories', label: 'Custom categories', icon: Tags },
  { to: '/settings/people', label: 'People', icon: Users },
  { to: '/settings/hmrc', label: 'HMRC', icon: Landmark },
  { to: '/settings/backup', label: 'Backup and restore', icon: DatabaseBackup },
];

export function SettingsLayout() {
  // Backups are for editors only.
  const canEdit = useCanEdit();
  return (
    <SectionLayout
      title="Settings"
      subtitle="Manage tax years, categories, people, the HMRC connection, backups and other app settings."
      sections={canEdit ? SECTIONS : SECTIONS.filter((s) => s.to !== '/settings/backup')}
    />
  );
}

export const SettingsHeading = SectionHeading;
