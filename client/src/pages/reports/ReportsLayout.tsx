import { Calculator, ChartPie, FileText } from 'lucide-react';
import { SectionLayout } from '../../components/SectionLayout';

const SECTIONS = [
  { to: '/reports/tax-estimate', label: 'Tax estimate', icon: Calculator },
  { to: '/reports/year-end', label: 'Year-end summary', icon: FileText },
  { to: '/reports/breakdown', label: 'Breakdown', icon: ChartPie },
];

export function ReportsLayout() {
  return (
    <SectionLayout
      title="Reports"
      subtitle="Estimate your tax, prepare your return and break down your income and spending."
      sections={SECTIONS}
      variant="tabs"
    />
  );
}
