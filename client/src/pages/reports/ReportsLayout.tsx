import { Calculator, ChartPie } from 'lucide-react';
import { SectionLayout } from '../../components/SectionLayout';

// For every year, however it goes to HMRC.
const SECTIONS = [
  { to: '/reports/tax-estimate', label: 'Tax estimate', icon: Calculator },
  { to: '/reports/breakdown', label: 'Breakdown', icon: ChartPie },
];

export function ReportsLayout() {
  return (
    <SectionLayout
      title="Reports"
      subtitle="Estimate your tax and break down your income and spending."
      sections={SECTIONS}
      variant="tabs"
    />
  );
}
