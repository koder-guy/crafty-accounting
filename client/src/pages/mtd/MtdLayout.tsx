import { FileSpreadsheet } from 'lucide-react';
import { SectionLayout } from '../../components/SectionLayout';

const SECTIONS = [{ to: '/mtd/quarterly', label: 'Quarterly updates', icon: FileSpreadsheet }];

export function MtdLayout() {
  return (
    <SectionLayout
      title="Making Tax Digital"
      subtitle="Send HMRC your figures each quarter."
      sections={SECTIONS}
      variant="tabs"
    />
  );
}
