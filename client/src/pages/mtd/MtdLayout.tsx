import { FileCheck, FileSpreadsheet } from 'lucide-react';
import { SectionLayout } from '../../components/SectionLayout';
import { useActiveTaxYear, useHmrc, useMtdQuarters } from '../../lib/queries';

const QUARTERLY = { to: '/mtd/quarterly', label: 'Quarterly updates', icon: FileSpreadsheet };
const FINAL_DECLARATION = { to: '/mtd/final-declaration', label: 'Final declaration', icon: FileCheck };

export function MtdLayout() {
  const { data: hmrc } = useHmrc();
  const { taxYear } = useActiveTaxYear();
  const { data } = useMtdQuarters(taxYear?.id);
  // The app can only make a final declaration when connected to HMRC, but one already made stays on show.
  const showDeclaration = hmrc?.configured || data?.finalDeclaration;
  return (
    <SectionLayout
      title="Making Tax Digital"
      subtitle={
        hmrc?.configured
          ? 'Send HMRC your figures each quarter, then confirm the year.'
          : 'Export your figures each quarter for your bridging software, then record each submission.'
      }
      sections={showDeclaration ? [QUARTERLY, FINAL_DECLARATION] : [QUARTERLY]}
      variant="tabs"
    />
  );
}
