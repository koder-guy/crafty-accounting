import { FileText } from 'lucide-react';
import { SectionLayout } from '../../components/SectionLayout';

const SECTIONS = [{ to: '/self-assessment/year-end', label: 'Year-end summary', icon: FileText }];

export function SelfAssessmentLayout() {
  return (
    <SectionLayout
      title="Self Assessment"
      subtitle="The figures for your Self Assessment return."
      sections={SECTIONS}
      variant="tabs"
    />
  );
}
