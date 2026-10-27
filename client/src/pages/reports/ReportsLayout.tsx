import { ChartPie, FileText } from 'lucide-react';
import { SectionLayout } from '../../components/SectionLayout';

const SECTIONS = [
  { to: '/reports/breakdown', label: 'Breakdown', icon: ChartPie },
  { to: '/reports/year-end', label: 'Year-end Summary', icon: FileText },
];

export function ReportsLayout() {
  return (
    <SectionLayout
      title="Reports"
      subtitle="Break down your income and spending, and prepare your return."
      sections={SECTIONS}
      variant="tabs"
    />
  );
}
