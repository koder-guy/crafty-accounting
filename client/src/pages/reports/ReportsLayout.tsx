import { Calculator, ChartPie, FileText } from 'lucide-react';
import { SectionLayout } from '../../components/SectionLayout';

const SECTIONS = [
  { to: '/reports/breakdown', label: 'Breakdown', icon: ChartPie },
  { to: '/reports/year-end', label: 'Year-end Summary', icon: FileText },
  { to: '/reports/tax-estimate', label: 'Tax estimate', icon: Calculator },
];

export function ReportsLayout() {
  return (
    <SectionLayout
      title="Reports"
      subtitle="Break down your income and spending, prepare your return and estimate your tax."
      sections={SECTIONS}
      variant="tabs"
    />
  );
}
