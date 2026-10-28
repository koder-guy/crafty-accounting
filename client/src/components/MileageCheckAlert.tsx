import { Link } from 'react-router';
import { formatGBP, type MileageCheck } from '@crafty/shared';
import { Alert } from './ui';

/** Warns about a possible double claim: mileage plus vehicle running costs in the same tax year. */
export function MileageCheckAlert({ check }: { check: MileageCheck }) {
  return (
    <Alert tone="warning">
      <p>
        You're claiming {formatGBP(check.mileagePence)} of mileage and have also recorded {formatGBP(check.outgoingPence)} of outgoing (
        {check.outgoingCount} {check.outgoingCount === 1 ? 'item' : 'items'}) in car, van and travel expenses this tax year. If any of
        that is fuel, insurance, servicing or repairs for a vehicle you claim mileage on, it's claimed twice: the mileage rate already
        covers those costs, so remove it. Parking, tolls, congestion charges and train or bus fares are fine to keep.
      </p>
      <Link to={`/outgoing?categoryId=${check.categoryId}`} className="mt-2 inline-block font-medium underline hover:text-white">
        Check that outgoing
      </Link>
    </Alert>
  );
}
