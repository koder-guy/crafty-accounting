import { DatabaseBackup, Layers, Tags } from 'lucide-react';
import { SectionHeading, SectionLayout } from '../../components/SectionLayout';

const SECTIONS = [
  { to: '/settings/tax-years', label: 'Tax years', icon: Layers },
  { to: '/settings/categories', label: 'Custom categories', icon: Tags },
  { to: '/settings/backup', label: 'Backup and restore', icon: DatabaseBackup },
];

export function SettingsLayout() {
  return (
    <SectionLayout title="Settings" subtitle="Manage tax years, categories, backups and other app settings." sections={SECTIONS} />
  );
}

export const SettingsHeading = SectionHeading;
