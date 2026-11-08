import { businessAddress, businessName } from '@crafty/shared';
import { useBusiness } from '../lib/queries';

/** The business's logo, name and address at the top of a printed report; hidden on screen. */
export function PrintBusinessHeader() {
  const { data } = useBusiness();
  const details = data?.details;
  if (!details) return null;
  const name = businessName(details);
  return (
    <div className="hidden items-center gap-4 border-b border-line pb-4 print:flex">
      {data.logo && <img src={data.logo.url} alt="" className="h-16 max-w-48 object-contain" />}
      <div>
        <p className="text-lg font-semibold text-white">{name}</p>
        {name !== details.ownerName && <p className="text-sm">{details.ownerName}</p>}
        <p className="text-sm text-muted">{businessAddress(details)}</p>
      </div>
    </div>
  );
}
