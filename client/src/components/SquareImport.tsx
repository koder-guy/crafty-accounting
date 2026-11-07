import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { CircleCheck, TriangleAlert } from 'lucide-react';
import { Link } from 'react-router';
import { displayTaxYear, formatDisplayDate, formatGBP, type SquareImportResult, type SquarePayout } from '@crafty/shared';
import { useActiveTaxYear, useImportSquarePayouts, useSquare, useSquarePayouts } from '../lib/queries';
import { SquareLogo } from './SquareLogo';
import { SubmittedFiguresNotice } from './SubmittedFiguresNotice';
import { Alert, Button, Spinner } from './ui';

const payoutsText = (n: number) => `${n.toLocaleString('en-GB')} ${n === 1 ? 'payout' : 'payouts'}`;

/** Ready to import: not in the books yet, and nothing stopping it. */
const importable = (p: SquarePayout) => p.incomeId === null && p.problem === null;

/** Income → Import from Square, shown once a Square access token is saved (Settings → Square Integration). */
export function SquareImportButton() {
  const { data: square } = useSquare();
  const [open, setOpen] = useState(false);
  if (!square?.configured) return null;
  return (
    <>
      <Button type="button" onClick={() => setOpen(true)} aria-label="Import from Square" title="Import from Square" className="size-9 shrink-0 !p-0">
        <SquareLogo className="size-3.5" />
      </Button>
      {open && <SquareImportDialog onClose={() => setOpen(false)} />}
    </>
  );
}

function SquareImportDialog({ onClose }: { onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  // The year chosen in the sidebar when the dialog opened: only its sales are listed and imported.
  const { taxYear: activeYear } = useActiveTaxYear();
  const [taxYear] = useState(activeYear);
  const query = useSquarePayouts(taxYear?.id ?? null);
  const run = useImportSquarePayouts();
  const [result, setResult] = useState<SquareImportResult | null>(null);
  // Payouts ticked or unticked by hand; the rest follow the default.
  const [picked, setPicked] = useState<Map<string, boolean>>(new Map());

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const payouts = useMemo(() => query.data?.payouts ?? [], [query.data]);
  // A payout that may already be in the books by hand starts unticked.
  const isChosen = (p: SquarePayout) => importable(p) && (picked.get(p.id) ?? p.possibleDuplicate === null);
  const chosen = payouts.filter(isChosen);
  const salesPence = chosen.reduce((acc, p) => acc + p.incomePence, 0);
  const feesPence = chosen.reduce((acc, p) => acc + p.feesPence, 0);
  const waiting = payouts.filter(importable);
  const imported = payouts.filter((p) => p.incomeId !== null).length;

  const close = () => {
    if (!run.isPending) onClose();
  };

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClose={onClose}
      className="m-auto flex max-h-[calc(100dvh-32px)] w-[calc(100%-32px)] max-w-3xl flex-col rounded-[var(--radius-card)] border border-line bg-surface p-0 text-ink shadow-2xl backdrop:bg-black/70 backdrop:backdrop-blur-sm"
    >
      <div className="flex gap-4 px-6 pt-6">
        <div
          className={`flex size-10 shrink-0 items-center justify-center rounded-full ${result ? 'bg-ok/10 text-in-soft' : 'bg-accent-bg text-accent-soft'}`}
        >
          {result ? <CircleCheck className="size-5" aria-hidden /> : <SquareLogo className="size-5" />}
        </div>
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="text-base font-semibold">
            {result ? `Imported ${payoutsText(result.imported)}` : 'Import from Square'}
          </h2>
          <p className="mt-1 text-sm text-muted">
            {result
              ? 'Each is now an income of its card sales and an expense for Square’s fees.'
              : 'Each payout to your bank becomes an income of the day’s card sales and an expense for Square’s fees.'}
          </p>
        </div>
      </div>

      {result ? (
        <div className="space-y-3 px-6 pt-4 text-sm text-muted">
          <p>
            <strong className="text-in-soft">{formatGBP(result.incomePence)}</strong> of sales and <strong className="text-out-soft">{formatGBP(result.feesPence)}</strong> of
            fees, in tax {result.years.length === 1 ? 'year' : 'years'} {result.years.map((y) => displayTaxYear(y.label)).join(' and ')}.
          </p>
          {result.alreadyImported > 0 && <p>{payoutsText(result.alreadyImported)} had been imported already, and were left out.</p>}
          {result.years.map((y) => (
            <SubmittedFiguresNotice key={y.taxYearId} taxYearId={y.taxYearId} dates={[y.firstDate]} />
          ))}
        </div>
      ) : (
        <>
          <p className="px-6 pt-4 text-sm text-muted">
            Payouts for sales in tax year <strong className="text-ink">{taxYear ? displayTaxYear(taxYear.label) : '…'}</strong>
            {query.data && payouts.length > 0 && `: ${payoutsText(payouts.length)}, ${waiting.length} to import${imported ? `, ${imported} imported already` : ''}`}.
          </p>

          <div className="mt-4 min-h-0 flex-1 overflow-y-auto border-y border-line">
            {query.isFetching ? (
              <div className="p-6">
                <Spinner label="Fetching payouts from Square…" />
              </div>
            ) : query.error ? (
              <div className="p-6">
                <Alert>{query.error.message}</Alert>
              </div>
            ) : !query.data ? (
              <p className="p-6 text-sm text-muted">Choose a tax year in the sidebar first.</p>
            ) : payouts.length === 0 ? (
              <p className="p-6 text-sm text-muted">Square has made no payouts to your bank for sales in this tax year.</p>
            ) : (
              <ul className="divide-y divide-line">
                {payouts.map((p) => (
                  <PayoutRow
                    key={p.id}
                    payout={p}
                    checked={isChosen(p)}
                    onChange={(value) => setPicked((m) => new Map(m).set(p.id, value))}
                    onOpenIncome={onClose}
                  />
                ))}
              </ul>
            )}
          </div>
        </>
      )}

      {run.error && !result && (
        <div className="px-6 pt-4">
          <Alert>{run.error.message}</Alert>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-end gap-3 px-6 py-5">
        {result ? (
          <Button type="button" variant="primary" onClick={onClose}>
            Close
          </Button>
        ) : (
          <>
            {chosen.length > 0 && (
              <p className="mr-auto text-sm text-muted">
                {payoutsText(chosen.length)}: <span className="tabular text-in-soft">{formatGBP(salesPence)}</span> sales,{' '}
                <span className="tabular text-out-soft">{formatGBP(feesPence)}</span> fees
              </p>
            )}
            <Button type="button" variant="ghost" onClick={close} disabled={run.isPending}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="primary"
              disabled={chosen.length === 0 || query.isFetching}
              busy={run.isPending}
              onClick={() => taxYear && run.mutate({ taxYearId: taxYear.id, payoutIds: chosen.map((p) => p.id) }, { onSuccess: setResult })}
            >
              Import {chosen.length > 0 ? payoutsText(chosen.length) : ''}
            </Button>
          </>
        )}
      </div>
    </dialog>
  );
}

function PayoutRow({
  payout: p,
  checked,
  onChange,
  onOpenIncome,
}: {
  payout: SquarePayout;
  checked: boolean;
  onChange: (value: boolean) => void;
  onOpenIncome: () => void;
}) {
  const id = useId();
  const done = p.incomeId !== null;
  const disabled = !importable(p);
  return (
    <li className={`flex gap-3 px-6 py-3 text-sm ${disabled ? 'bg-surface-2/40' : ''}`}>
      <input
        id={id}
        type="checkbox"
        className="mt-0.5 size-4 shrink-0 accent-[var(--color-accent)]"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        aria-describedby={`${id}-more`}
      />
      <div className="min-w-0 flex-1">
        <label htmlFor={id} className={`flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 ${disabled ? '' : 'cursor-pointer'}`}>
          <span className={done ? 'text-muted' : 'font-medium'}>
            {p.saleDate ? `Sales on ${formatDisplayDate(p.saleDate)}` : `Paid in on ${formatDisplayDate(p.arrivalDate)}`}
          </span>
          {done ? (
            <span className="tabular text-muted">{formatGBP(p.incomePence)}</span>
          ) : (
            <span className="tabular">
              <span className="text-in-soft">{formatGBP(p.incomePence)}</span>
              <span className="text-muted"> − </span>
              <span className="text-out-soft">{formatGBP(p.feesPence)}</span>
              <span className="text-muted"> fees = {formatGBP(p.netPence)}</span>
            </span>
          )}
        </label>
        <div id={`${id}-more`} className="mt-0.5 text-xs text-muted">
          {done ? (
            <>
              Imported already ·{' '}
              <Link to={`/income/${p.incomeId}`} onClick={onOpenIncome} className="text-accent-soft underline-offset-2 hover:underline">
                View income
              </Link>
            </>
          ) : (
            <>
              Paid in on {formatDisplayDate(p.arrivalDate)}
              {p.saleDates.length > 1 && ` · sales on ${p.saleDates.map((d) => formatDisplayDate(d)).join(', ')}`}
              {p.refundsPence > 0 && ` · less ${formatGBP(p.refundsPence)} of refunds`}
            </>
          )}
        </div>
        {p.problem && (
          <p className="mt-1.5 flex gap-1.5 text-xs text-out-soft">
            <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
            <span>Can’t be imported: {p.problem} Add it by hand instead.</span>
          </p>
        )}
        {p.possibleDuplicate && (
          <p className="mt-1.5 flex gap-1.5 text-xs text-warn">
            <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
            <span>
              Already in your books?{' '}
              <Link to={`/income/${p.possibleDuplicate.id}`} onClick={onOpenIncome} className="underline-offset-2 hover:underline">
                “{p.possibleDuplicate.description}”
              </Link>{' '}
              is {formatGBP(p.possibleDuplicate.amountPence)} on the same day. Tick it to import it anyway.
            </span>
          </p>
        )}
      </div>
    </li>
  );
}
