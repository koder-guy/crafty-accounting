import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { Download, ListOrdered, Pencil, Trash2 } from 'lucide-react';
import { displayTaxYear, formatDisplayDate, formatGBP } from '@crafty/shared';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { BackLink, recordedBy } from '../components/FormShell';
import { PageBody, PageHeader } from '../components/PageHeader';
import { Alert, Badge, Button, ButtonLink, Card, CardHeader, DetailRow, PaymentBadge, Spinner } from '../components/ui';
import { documentUrl } from '../lib/api';
import { useDeleteTransaction, useExpense, useTaxYears } from '../lib/queries';

export function ExpenseView() {
  const id = Number(useParams().id);
  const navigate = useNavigate();
  const { data: expense, isLoading, error } = useExpense(id);
  const { data: years } = useTaxYears();
  const remove = useDeleteTransaction('expenses');
  const [confirming, setConfirming] = useState(false);
  const year = years?.taxYears.find((y) => y.id === expense?.taxYearId);

  return (
    <>
      <PageHeader
        title={expense ? expense.payee : 'Outgoing'}
        subtitle={expense ? `Outgoing · ${formatDisplayDate(expense.date)}` : undefined}
        actions={
          expense && (
            <>
              <ButtonLink to={`/outgoing/${id}/edit`}>
                <Pencil className="size-4" aria-hidden />
                Edit
              </ButtonLink>
              <Button variant="ghost" className="hover:text-out-soft!" onClick={() => setConfirming(true)}>
                <Trash2 className="size-4" aria-hidden />
                Delete
              </Button>
            </>
          )
        }
      />
      <PageBody>
        <BackLink to="/outgoing">All outgoing</BackLink>
        {isLoading ? (
          <Spinner />
        ) : error || !expense ? (
          <Alert>{error?.message ?? 'Transaction not found'}</Alert>
        ) : (
          <>
            <Card className="px-5 sm:px-6">
              <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-line py-5">
                <div>
                  <span className="tabular text-3xl font-bold text-out-soft">{formatGBP(expense.totalPence)}</span>
                  {expense.disallowablePence > 0 && (
                    <span className="ml-3 text-sm text-muted">{formatGBP(expense.disallowablePence)} disallowable</span>
                  )}
                </div>
                <PaymentBadge method={expense.paymentMethod} />
              </div>
              <dl className="divide-y divide-line">
                <DetailRow label="Date">{formatDisplayDate(expense.date)}</DetailRow>
                <DetailRow label="Payee">{expense.payee}</DetailRow>
                <DetailRow label="Invoice number">{expense.invoiceNumber}</DetailRow>
                <DetailRow label="Order number">{expense.orderNumber}</DetailRow>
                <DetailRow label="Description">{expense.description}</DetailRow>
                <DetailRow label="Tax year">{year ? displayTaxYear(year.label) : null}</DetailRow>
                <DetailRow label="Document">
                  {expense.documentFilename && (
                    <a
                      href={documentUrl(expense.documentFilename, true)}
                      className="inline-flex items-center gap-1.5 break-all text-accent-soft hover:underline"
                    >
                      <Download className="size-4 shrink-0" aria-hidden />
                      {expense.documentFilename}
                    </a>
                  )}
                </DetailRow>
                <DetailRow label="Notes">{expense.notes && <span className="whitespace-pre-wrap">{expense.notes}</span>}</DetailRow>
                <DetailRow label="Added by">{recordedBy(expense.createdBy, expense.createdAt)}</DetailRow>
                {expense.updatedAt !== expense.createdAt && (
                  <DetailRow label="Last changed by">{recordedBy(expense.updatedBy, expense.updatedAt)}</DetailRow>
                )}
              </dl>
            </Card>

            <Card>
              <CardHeader icon={<ListOrdered className="size-5 text-accent-soft" />} title="Line items" />
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-sm">
                  <thead className="text-xs tracking-wide text-muted uppercase">
                    <tr className="border-y border-line">
                      <th scope="col" className="px-4 py-3 text-left font-medium sm:pl-6">Description</th>
                      <th scope="col" className="px-4 py-3 text-left font-medium">Category</th>
                      <th scope="col" className="px-4 py-3 text-right font-medium sm:pr-6">Amount</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {expense.lineItems.map((li) => (
                      <tr key={li.id}>
                        <td className="px-4 py-3 sm:pl-6">
                          {li.description}
                          {li.disallowable && (
                            <span className="ml-2">
                              <Badge tone="out">Disallowable</Badge>
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-muted">
                          {li.categoryName} <span className="ml-1 font-mono text-xs text-faint">{li.hmrcCode}</span>
                        </td>
                        <td className="tabular px-4 py-3 text-right sm:pr-6">{formatGBP(li.amountPence)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-line-strong">
                      <td colSpan={2} className="px-4 py-3 text-right text-muted">Total</td>
                      <td className="tabular px-4 py-3 text-right font-semibold sm:pr-6">{formatGBP(expense.totalPence)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </Card>

          </>
        )}
      </PageBody>

      <ConfirmDialog
        open={confirming}
        title="Delete this outgoing transaction?"
        confirmLabel="Delete"
        onClose={() => setConfirming(false)}
        onConfirm={async () => {
          await remove.mutateAsync(id);
          navigate('/outgoing');
        }}
      >
        <p>
          This permanently deletes the transaction, its line items{expense?.documentFilename ? ' and its attached document' : ''}.
          This can't be undone.
        </p>
      </ConfirmDialog>
    </>
  );
}
