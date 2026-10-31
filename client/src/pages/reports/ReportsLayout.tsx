import { Calculator, ChartPie, GitCompareArrows } from 'lucide-react';
import { SectionLayout } from '../../components/SectionLayout';

// For every year, however it goes to HMRC.
const SECTIONS = [
  { to: '/reports/tax-estimate', label: 'Tax estimate', icon: Calculator },
  { to: '/reports/breakdown', label: 'Breakdown', icon: ChartPie },
  { to: '/reports/compare-years', label: 'Compare years', icon: GitCompareArrows },
];

export function ReportsLayout() {
  return (
    <SectionLayout
      title="Reports"
      subtitle="Estimate your tax, break down your income and spending, and compare tax years."
      sections={SECTIONS}
      variant="tabs"
    />
  );
}
