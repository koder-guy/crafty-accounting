import { Calculator, FileText } from 'lucide-react';
import { SectionLayout } from '../../components/SectionLayout';

const SECTIONS = [
  { to: '/self-assessment/tax-estimate', label: 'Tax estimate', icon: Calculator },
  { to: '/self-assessment/year-end', label: 'Year-end summary', icon: FileText },
];

export function SelfAssessmentLayout() {
  return (
    <SectionLayout
      title="Self Assessment"
      subtitle="Estimate the tax on your profit and get the figures for your Self Assessment return."
      sections={SECTIONS}
      variant="tabs"
    />
  );
}
