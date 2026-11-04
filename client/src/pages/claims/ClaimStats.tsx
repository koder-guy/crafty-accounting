import type { ReactNode } from 'react';
import { Card } from '../../components/ui';

/** The boxes across the top of Mileage and Use of Home. */
export function ClaimStats({ children }: { children: ReactNode }) {
  return <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{children}</div>;
}

export function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <Card className="p-5">
      <div className="eyebrow">{label}</div>
      <div className="tabular mt-2 text-2xl font-bold text-white">{value}</div>
      <div className="mt-1 text-xs text-muted">{sub}</div>
    </Card>
  );
}

/** HMRC's rates for the tax year, one line each. */
export function RatesUsed({ rates, note }: { rates: { label: string; rate: string }[]; note?: string }) {
  return (
    <Card className="p-5">
      <div className="eyebrow">Rates used</div>
      <dl className="mt-2 space-y-1 text-sm">
        {rates.map((r) => (
          <div key={r.label} className="flex justify-between gap-3">
            <dt className="text-muted">{r.label}</dt>
            <dd className="tabular font-semibold whitespace-nowrap text-ink">{r.rate}</dd>
          </div>
        ))}
      </dl>
      {note && <div className="mt-2 text-xs text-muted">{note}</div>}
    </Card>
  );
}
