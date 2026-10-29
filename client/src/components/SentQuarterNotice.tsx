import { formatDisplayDate } from '@crafty/shared';
import { useMtdQuarters } from '../lib/queries';
import { Alert } from './ui';

/**
 * Warns that a change dated on or before the end of the latest quarter sent to
 * HMRC leaves HMRC's figures out of date. Updates are cumulative, so the next
 * one puts it right.
 */
export function SentQuarterNotice({
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
  const latest = data?.quarters.filter((q) => q.submission?.sent).at(-1);
  if (!latest || !dates.some((date) => date && date <= latest.endDate)) return null;
  return (
    <div className={className}>
      <Alert tone="warning">
        HMRC already has your figures up to {formatDisplayDate(latest.endDate)} (Q{latest.quarter}). This change will reach HMRC with
        your next quarterly update.
      </Alert>
    </div>
  );
}
