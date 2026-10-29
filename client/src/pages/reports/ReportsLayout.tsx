import { ChartPie } from 'lucide-react';
import { SectionLayout } from '../../components/SectionLayout';

const SECTIONS = [{ to: '/reports/breakdown', label: 'Breakdown', icon: ChartPie }];

export function ReportsLayout() {
  return <SectionLayout title="Reports" subtitle="Break down your income and spending for any period." sections={SECTIONS} variant="tabs" />;
}
