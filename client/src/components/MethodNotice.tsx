import { Link } from 'react-router';
import { displayTaxYear, type SubmissionMethod } from '@crafty/shared';
import { useActiveTaxYear } from '../lib/queries';
import { Alert } from './ui';

const SET_TO: Record<SubmissionMethod, string> = {
  self_assessment: 'a Self Assessment return',
  mtd: 'Making Tax Digital',
};

/** Shown in the Self Assessment or Making Tax Digital section when the active year goes to HMRC the other way. */
export function MethodNotice({ method }: { method: SubmissionMethod }) {
  const { taxYear } = useActiveTaxYear();
  if (!taxYear || taxYear.submissionMethod === method) return null;
  return (
    <Alert tone="warning">
      {displayTaxYear(taxYear.label)} is set to {SET_TO[taxYear.submissionMethod]}, so this section isn’t in the menu for it. Change
      how the year goes to HMRC in{' '}
      <Link className="underline" to="/settings/tax-years">
        Settings → Tax years
      </Link>
      .
    </Alert>
  );
}
