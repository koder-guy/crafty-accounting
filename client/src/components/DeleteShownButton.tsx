import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { ConfirmDialog } from './ConfirmDialog';
import { SubmittedFiguresNotice } from './SubmittedFiguresNotice';
import { Button } from './ui';
import { useDeleteTransactions } from '../lib/queries';
import { formatGBP, type TransactionDocument } from '@crafty/shared';

interface Row {
  id: number;
  date: string;
  documents: TransactionDocument[];
}

/**
 * Deletes every transaction the table shows: all of them, or with a filter in use only those
 * matching it (across every page). Asks first, and the person types "delete" to confirm.
 * Greyed out, like Export, while the table shows none.
 */
export function DeleteShownButton({
  kind,
  rows,
  filtered,
  totalPence,
  taxYearId,
}: {
  kind: 'incomes' | 'expenses';
  rows: Row[];
  filtered: boolean;
  totalPence: number;
  taxYearId: number | undefined;
}) {
  const [open, setOpen] = useState(false);
  const remove = useDeleteTransactions(kind);
  // Nothing shown: stays in place beside Export, greyed out, with the reason on hover.
  const empty = rows.length === 0;

  const noun = kind === 'incomes' ? 'income' : 'expense';
  const all = kind === 'incomes' ? 'income' : 'expenses';
  const label = filtered ? `Delete the ${rows.length} filtered` : `Delete all ${all}`;
  const count = `${rows.length} ${noun} ${rows.length === 1 ? 'transaction' : 'transactions'}`;
  const documents = rows.reduce((n, r) => n + r.documents.length, 0);

  return (
    <>
      <span className="inline-flex" title={empty ? 'Nothing to delete' : undefined}>
        <Button
          type="button"
          variant="softDanger"
          disabled={empty}
          onClick={() => setOpen(true)}
          aria-label={empty ? `Delete ${all}` : label}
          title={empty ? undefined : label}
          className="size-9 shrink-0 !p-0 disabled:pointer-events-none"
        >
          <Trash2 className="size-4" aria-hidden />
        </Button>
      </span>
      <ConfirmDialog
        open={open && !empty}
        title={filtered ? `Delete the ${count} shown?` : `Delete all ${count}?`}
        confirmLabel={rows.length === 1 ? 'Delete 1 transaction' : `Delete ${rows.length} transactions`}
        requireText="delete"
        onClose={() => setOpen(false)}
        onConfirm={() => remove.mutateAsync(rows.map((r) => r.id))}
      >
        <p>
          {filtered ? (
            <>
              Every {noun} matching the current filters, on every page, will be permanently deleted:{' '}
            </>
          ) : (
            <>Every {noun} in this tax year will be permanently deleted: </>
          )}
          <strong className="text-ink">{count}</strong> totalling <strong className="text-ink">{formatGBP(totalPence)}</strong>
          {documents ? `, along with ${rows.length === 1 ? 'its' : 'their'} ${documents === 1 ? 'attached document' : `${documents} attached documents`}` : ''}.
        </p>
        <p>This can't be undone. Download a backup or an export first if you might want them back.</p>
        <SubmittedFiguresNotice taxYearId={taxYearId} dates={rows.map((r) => r.date)} />
      </ConfirmDialog>
    </>
  );
}
