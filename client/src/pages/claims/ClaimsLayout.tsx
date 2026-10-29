import { Car, House } from 'lucide-react';
import { SectionLayout } from '../../components/SectionLayout';

const SECTIONS = [
  { to: '/claims/mileage', label: 'Mileage', icon: Car },
  { to: '/claims/use-of-home', label: 'Use of Home', icon: House },
];

/** Mileage and use of home: both claimed at HMRC's flat rates rather than what they actually cost. */
export function ClaimsLayout() {
  return (
    <SectionLayout
      title="Simplified Expenses"
      subtitle="Mileage and working from home, claimed at HMRC's flat rates instead of what they actually cost."
      sections={SECTIONS}
      variant="tabs"
    />
  );
}
