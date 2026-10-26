import { Fragment, useState } from 'react';
import { useNavigate } from 'react-router';
import { ArrowUpRight, ChevronRight, Plus } from 'lucide-react';
import { formatDisplayDate, formatGBP, type Expense, type ExpenseWithLineItems } from '@crafty/shared';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { NoTaxYear } from '../components/NoTaxYear';
import { PageBody, PageHeader } from '../components/PageHeader';
import {
  DocIndicator,
  ExportCsvButton,
  FilterBar,
  RowActions,
  SortTh,
  useSort,
  useTransactionFilters,
} from '../components/transactions';
import { Alert, Badge, ButtonLink, Card, CardHeader, EmptyState, PaymentBadge, Spinner } from '../components/ui';
import { exportCsvUrl, useActiveTaxYear, useCategories, useDeleteTransaction, useExpandedOutgoingRows, useExpenses } from '../lib/queries';

export function OutgoingList() {
  const { taxYear, isLoading: yearLoading } = useActiveTaxYear();
  const filterState = useTransactionFilters(taxYear);
  const { data: categories = [] } = useCategories();
  const { data, isLoading, error } = useExpenses(filterState.filters);
  const remove = useDeleteTransaction('expenses');
  const { isExpanded, toggle: toggleRow } = useExpandedOutgoingRows();
  const [toDelete, setToDelete] = useState<Expense | null>(null);
  const navigate = useNavigate();

  const { sorted, sort, toggle } = useSort(
    data,
    {
      date: (r) => `${r.date}-${String(r.id).padStart(8, '0')}`,
      supplier: (r) => r.supplier.toLowerCase(),
      category: (r) => r.categoryNames.join(', '),
      method: (r) => r.paymentMethod,
      amount: (r) => r.totalPence,
    },
    'date',
  );
  const total = (data ?? []).reduce((acc, r) => acc + r.totalPence, 0);

  return (
    <>
      <PageHeader
        title="Outgoing"
        actions={
          taxYear && (
            <>
              {filterState.filters && <ExportCsvButton href={exportCsvUrl('expenses', filterState.filters)} />}
              <ButtonLink to="/outgoing/new" variant="primary">
                <Plus className="size-4" aria-hidden />
                Add outgoing
              </ButtonLink>
            </>
          )
        }
      />
      <PageBody>
        {yearLoading ? (
          <Spinner />
        ) : !taxYear ? (
          <NoTaxYear />
        ) : (
          <Card>
            <CardHeader
              icon={<ArrowUpRight className="size-5 text-out-soft" />}
              title="Outgoing payments"
              action={
                data && (
                  <span className="text-sm text-muted">
                    {data.length} {data.length === 1 ? 'transaction' : 'transactions'} ·{' '}
                    <span className="tabular font-semibold text-out-soft">{formatGBP(total)}</span>
                  </span>
                )
              }
            />
            <FilterBar filterState={filterState} categories={categories} type="EXPENSE" />
            {error ? (
              <div className="p-6">
                <Alert>{error.message}</Alert>
              </div>
            ) : isLoading ? (
              <Spinner />
            ) : sorted.length === 0 ? (
              <EmptyState icon={<ArrowUpRight className="size-10" />} title={filterState.active ? 'No matching transactions' : 'No outgoing transactions yet'}>
                {filterState.active ? 'Try changing or clearing the filters.' : 'Record a purchase or invoice with “Add outgoing”.'}
              </EmptyState>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[820px] text-sm">
                  <thead className="text-xs tracking-wide text-muted uppercase">
                    <tr className="border-b border-line">
                      <th scope="col" className="w-10 pl-3">
                        <span className="sr-only">Show line items</span>
                      </th>
                      <SortTh label="Date" sortKey="date" sort={sort} onSort={toggle} />
                      <SortTh label="Supplier" sortKey="supplier" sort={sort} onSort={toggle} />
                      <SortTh label="Categories" sortKey="category" sort={sort} onSort={toggle} />
                      <SortTh label="Method" sortKey="method" sort={sort} onSort={toggle} />
                      <SortTh label="Amount" sortKey="amount" sort={sort} onSort={toggle} align="right" />
                      <th scope="col" className="px-4 py-3 text-right font-medium">
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {sorted.map((row) => {
                      const open = isExpanded(row.id);
                      return (
                        <Fragment key={row.id}>
                          <tr
                            className={`cursor-pointer transition-colors hover:bg-surface-2/60 ${open ? 'bg-surface-2/40' : ''}`}
                            onClick={(e) => !(e.target as HTMLElement).closest('a,button') && navigate(`/outgoing/${row.id}`)}
                          >
                            <td className="py-3 pl-3">
                              <button
                                type="button"
                                onClick={() => toggleRow(row.id)}
                                aria-expanded={open}
                                aria-controls={`lines-${row.id}`}
                                aria-label={`${open ? 'Hide' : 'Show'} line items for ${row.supplier}`}
                                className="inline-flex size-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-accent-bg hover:text-accent-soft"
                              >
                                <ChevronRight className={`size-4 transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden />
                              </button>
                            </td>
                            <td className="px-4 py-3 whitespace-nowrap text-muted">{formatDisplayDate(row.date)}</td>
                            <td className="max-w-xs px-4 py-3">
                              <div className="flex items-center gap-1.5 font-medium text-ink">
                                <span className="truncate">{row.supplier}</span>
                                <DocIndicator filename={row.documentFilename} />
                              </div>
                              <div className="truncate text-xs text-muted">
                                {[row.invoiceNumber, row.orderNumber, row.description].filter(Boolean).join(' · ') ||
                                  `${row.lineItemCount} line ${row.lineItemCount === 1 ? 'item' : 'items'}`}
                              </div>
                            </td>
                            <td className="max-w-[240px] px-4 py-3 text-muted">
                              <div className="truncate" title={row.categoryNames.join('\n')}>
                                {row.categoryNames[0]}
                                {row.categoryNames.length > 1 && <span className="text-faint"> +{row.categoryNames.length - 1}</span>}
                              </div>
                            </td>
                            <td className="px-4 py-3">
                              <PaymentBadge method={row.paymentMethod} />
                            </td>
                            <td className="px-4 py-3 text-right whitespace-nowrap">
                              <div className="tabular font-semibold text-out-soft">{formatGBP(row.totalPence)}</div>
                              {row.disallowablePence > 0 && (
                                <div className="tabular text-xs text-faint">{formatGBP(row.disallowablePence)} disallowable</div>
                              )}
                            </td>
                            <td className="px-3 py-2">
                              <RowActions
                                viewTo={`/outgoing/${row.id}`}
                                editTo={`/outgoing/${row.id}/edit`}
                                onDelete={() => setToDelete(row)}
                              />
                            </td>
                          </tr>
                          {open && (
                            <tr id={`lines-${row.id}`} className="border-t-0! bg-surface-2/40">
                              <td />
                              <td colSpan={6} className="px-4 pt-1 pb-4">
                                <LineItemsTable expense={row} />
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        )}
      </PageBody>

      <ConfirmDialog
        open={toDelete !== null}
        title="Delete this outgoing transaction?"
        confirmLabel="Delete"
        onClose={() => setToDelete(null)}
        onConfirm={() => remove.mutateAsync(toDelete!.id)}
      >
        {toDelete && (
          <>
            <p>
              <strong className="text-ink">{toDelete.supplier}</strong> on {formatDisplayDate(toDelete.date)} for{' '}
              <strong className="text-ink">{formatGBP(toDelete.totalPence)}</strong> will be permanently deleted, with its{' '}
              {toDelete.lineItemCount} line {toDelete.lineItemCount === 1 ? 'item' : 'items'}
              {toDelete.documentFilename ? ' and attached document' : ''}.
            </p>
            <p>This can't be undone.</p>
          </>
        )}
      </ConfirmDialog>
    </>
  );
}

/** Read-only line items shown under an expanded row. */
function LineItemsTable({ expense }: { expense: ExpenseWithLineItems }) {
  return (
    <table className="w-full rounded-lg border border-line bg-page/40 text-sm">
      <thead className="text-xs tracking-wide text-faint uppercase">
        <tr className="border-b border-line">
          <th scope="col" className="px-4 py-2 text-left font-medium">Line item</th>
          <th scope="col" className="px-4 py-2 text-left font-medium">Category</th>
          <th scope="col" className="px-4 py-2 text-right font-medium">Amount</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-line">
        {expense.lineItems.map((li) => (
          <tr key={li.id}>
            <td className="px-4 py-2 text-ink">
              {li.description}
              {li.disallowable && (
                <span className="ml-2">
                  <Badge tone="out">Disallowable</Badge>
                </span>
              )}
            </td>
            <td className="px-4 py-2 text-muted">
              {li.categoryName} <span className="ml-1 font-mono text-xs text-faint">{li.hmrcCode}</span>
            </td>
            <td className="tabular px-4 py-2 text-right text-ink">{formatGBP(li.amountPence)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
