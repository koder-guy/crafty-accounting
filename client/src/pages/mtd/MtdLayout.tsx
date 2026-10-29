import { FileCheck, FileSpreadsheet } from 'lucide-react';
import { SectionLayout } from '../../components/SectionLayout';

const SECTIONS = [
  { to: '/mtd/quarterly', label: 'Quarterly updates', icon: FileSpreadsheet },
  { to: '/mtd/final-declaration', label: 'Final declaration', icon: FileCheck },
];

export function MtdLayout() {
  return (
    <SectionLayout
      title="Making Tax Digital"
      subtitle="Send HMRC your figures each quarter, then confirm the year."
      sections={SECTIONS}
      variant="tabs"
    />
  );
}
