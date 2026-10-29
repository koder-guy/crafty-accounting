import { Calculator, FileSpreadsheet } from 'lucide-react';
import { SectionLayout } from '../../components/SectionLayout';

const SECTIONS = [
  { to: '/mtd/quarterly', label: 'Quarterly updates', icon: FileSpreadsheet },
  { to: '/mtd/tax-estimate', label: 'Tax estimate', icon: Calculator },
];

export function MtdLayout() {
  return (
    <SectionLayout
      title="Making Tax Digital"
      subtitle="Send HMRC your figures each quarter, and see the tax on your profit."
      sections={SECTIONS}
      variant="tabs"
    />
  );
}
