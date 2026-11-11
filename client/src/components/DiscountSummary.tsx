import { BadgePercent } from 'lucide-react';
import { discountSummary, formatGBP, type DiscountCheckLine } from '@crafty/shared';

/**
 * "Discounts applied": each discount, what it was taken off and what that category's items came to
 * before and after. Worked out from the lines each time, so it never goes out of date.
 */
export function DiscountSummary({
  lines,
  categoryName,
  className = '',
}: {
  lines: (DiscountCheckLine & { description: string })[];
  categoryName: (id: number) => string;
  className?: string;
}) {
  const discounts = discountSummary(lines);
  if (discounts.length === 0) return null;
  return (
    <div className={`text-sm ${className}`}>
      <h3 className="flex items-center gap-2 font-medium text-ink">
        <BadgePercent className="size-4 text-ok" aria-hidden />
        Discounts applied
      </h3>
      <ul className="mt-2 space-y-1.5">
        {discounts.map((d, i) => (
          <li key={i} className="text-muted">
            <span className="text-ink">{d.description}</span>, <span className="tabular text-ok">−{formatGBP(d.amountPence)}</span> off{' '}
            {categoryName(d.categoryId)}
            {d.disallowable && ' (disallowable)'}{' '}
            <span className="tabular text-faint">
              ({formatGBP(d.beforePence)} → {formatGBP(d.afterPence)})
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
