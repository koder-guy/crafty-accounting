import {
  displayTaxYear,
  formatDisplayDate,
  mtdAmendmentDeadline,
  selfAssessmentAmendmentDeadline,
  startYearFromLabel,
  todayIso,
  type MtdQuartersResponse,
} from '@crafty/shared';
import { useMtdQuarters } from '../lib/queries';
import { Alert } from './ui';

const amendBy = (what: string, deadline: string) =>
  todayIso() <= deadline
    ? `This change only reaches HMRC if you amend ${what}, by ${formatDisplayDate(deadline)}.`
    : `The time to amend ${what} has passed, so contact HMRC if this changes what you owe.`;

/** What a change to entries with these dates means for what HMRC already has, if anything. */
function noticeFor({ taxYear, quarters, finalDeclaration }: MtdQuartersResponse, dates: string[]): string | null {
  if (dates.length === 0) return null;
  const year = displayTaxYear(taxYear.label);
  const startYear = startYearFromLabel(taxYear.label)!;
  if (taxYear.saFiledOn) {
    return `You filed your ${year} return on ${formatDisplayDate(taxYear.saFiledOn)}. ${amendBy('the return', selfAssessmentAmendmentDeadline(startYear))}`;
  }
  if (finalDeclaration) {
    return `You made the final declaration for ${year} on ${formatDisplayDate(finalDeclaration.at.slice(0, 10))}, so HMRC takes no more quarterly updates. ${amendBy('the year', mtdAmendmentDeadline(startYear))}`;
  }
  const latest = quarters.filter((q) => q.submission).at(-1);
  if (!latest || !dates.some((date) => date <= latest.endDate)) return null;
  const end = formatDisplayDate(latest.endDate);
  return `${latest.submission!.sent ? `HMRC already has your figures up to ${end} (Q${latest.quarter}).` : `You’ve recorded your figures up to ${end} (Q${latest.quarter}) as submitted.`} ${
    latest.quarter === 4 ? 'Submit Q4 again to bring HMRC up to date.' : 'This change will reach HMRC with your next quarterly update.'
  }`;
}

/**
 * Warns that a change to entries HMRC already has, on a quarterly update, a final
 * declaration or a return, leaves HMRC's figures out of date, and how to put that right.
 */
export function SubmittedFiguresNotice({
  taxYearId,
  dates,
  className,
}: {
  taxYearId: number | undefined;
  /** The transaction's date now and, when editing, before. */
  dates: (string | null | undefined)[];
  className?: string;
}) {
  const { data } = useMtdQuarters(taxYearId);
  const notice = data && noticeFor(data, dates.filter((date) => !!date) as string[]);
  if (!notice) return null;
  return (
    <div className={className}>
      <Alert tone="warning">{notice}</Alert>
    </div>
  );
}
