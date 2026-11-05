import { Fragment, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { ArrowUpRight, ChevronRight, CircleSlash, Plus } from 'lucide-react';
import { formatDisplayDate, formatGBP, shortCategoryName, type Expense, type ExpenseWithLineItems } from '@crafty/shared';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Pagination, usePagination } from '../components/Pagination';
import { ImportButton } from '../components/ImportTransactions';
import { SubmittedFiguresNotice } from '../components/SubmittedFiguresNotice';
import { NoTaxYear } from '../components/NoTaxYear';
import { PageBody, PageHeader } from '../components/PageHeader';
import {
  attachedDocuments,
  DocIndicator,
  DocumentsTable,
  ExportMenu,
  FilterBar,
  FilterToggle,
  RowActions,
  SortTh,
  TransactionCard,
  useSort,
  useFiltersShown,
  useTransactionFilters,
} from '../components/transactions';
import { Alert, Badge, ButtonLink, Card, CardHeader, EmptyState, PaymentBadge, Spinner } from '../components/ui';
import { exportUrl, useActiveTaxYear, useCanEdit, useCategories, useDeleteTransaction, useExpandedRows, useExpenses } from '../lib/queries';

export function ExpenseList() {
  const { taxYear, isLoading: yearLoading } = useActiveTaxYear();
  const filterState = useTransactionFilters(taxYear);
  const { data: categories = [] } = useCategories();
  const { data, isLoading, error } = useExpenses(filterState.filters);
  const canEdit = useCanEdit();
  const [filtersShown, setFiltersShown] = useFiltersShown('expenses');
  const remove = useDeleteTransaction('expenses');
  const { isExpanded, toggle: toggleRow } = useExpandedRows('expenses');
  const [toDelete, setToDelete] = useState<Expense | null>(null);
  const navigate = useNavigate();

  const { sorted, sort, toggle: toggleSort } = useSort(
    data,
    {
      date: (r) => `${r.date}-${String(r.id).padStart(8, '0')}`,
      payee: (r) => r.payee.toLowerCase(),
      invoice: (r) => (r.invoiceNumber ?? '').toLowerCase(),
      category: (r) => r.categoryNames.join(', '),
      method: (r) => r.paymentMethod,
      amount: (r) => r.totalPence,
    },
    'date',
    'expenses',
  );
  const tableTop = useRef<HTMLElement>(null);
  const pagination = usePagination(sorted, tableTop);
  const { pageRows } = pagination;
  // A new order starts again from the first page.
  const toggle = (key: Parameters<typeof toggleSort>[0]) => {
    toggleSort(key);
    pagination.setPage(1, false);
  };
  const total = (data ?? []).reduce((acc, r) => acc + r.totalPence, 0);

  return (
    <>
      <PageHeader title="Expenses" />
      <PageBody>
        {yearLoading ? (
          <Spinner />
        ) : !taxYear ? (
          <NoTaxYear />
        ) : (
          <Card ref={tableTop}>
            <CardHeader
              icon={<ArrowUpRight className="size-5 text-out-soft" />}
              title="Expenses paid"
              tools={
                <>
                  <FilterToggle
                    shown={filtersShown}
                    onToggle={() => setFiltersShown((v) => !v)}
                    controls="expenses-filters"
                    active={filterState.active}
                  />
                  {canEdit && (
                    <ButtonLink to="/expenses/new" aria-label="Add expense" title="Add expense" className="size-9 shrink-0 !p-0">
                      <Plus className="size-4" aria-hidden />
                    </ButtonLink>
                  )}
                  {canEdit && <ImportButton kind="expenses" iconOnly />}
                  {filterState.filters && <ExportMenu href={(format) => exportUrl('expenses', filterState.filters!, format)} count={data?.length} iconOnly />}
                </>
              }
              action={
                data && (
                  <span className="text-sm text-muted">
                    {data.length} {filterState.active ? 'filtered ' : ''}
                    {data.length === 1 ? 'transaction' : 'transactions'} ·{' '}
                    <span className="tabular font-semibold text-out-soft">{formatGBP(total)}</span>
                  </span>
                )
              }
            />
            <FilterBar filterState={filterState} categories={categories} type="EXPENSE" id="expenses-filters" shown={filtersShown} />
            {error ? (
              <div className="p-6">
                <Alert>{error.message}</Alert>
              </div>
            ) : isLoading ? (
              <Spinner />
            ) : sorted.length === 0 ? (
              <EmptyState icon={<ArrowUpRight className="size-10" />} title={filterState.active ? 'No matching transactions' : 'No expenses recorded yet'}>
                {filterState.active ? 'Try changing or clearing the filters.' : 'Record a purchase or invoice with “Add expense”.'}
              </EmptyState>
            ) : (
              <>
              <ul className="divide-y divide-line border-t border-line sm:hidden">
                {pageRows.map((row) => (
                  <TransactionCard
                    key={row.id}
                    to={`/expenses/${row.id}`}
                    title={row.payee}
                    sub={`${formatDisplayDate(row.date)} · ${categorySummary(row.categoryNames)}`}
                    amount={formatGBP(row.totalPence)}
                    amountClass="text-out-soft"
                    method={row.paymentMethod}
                    documents={row.documents}
                  />
                ))}
              </ul>
              <div className="hidden overflow-x-auto sm:block">
                <table className="w-full min-w-[880px] text-sm">
                  <thead className="text-xs tracking-wide text-muted uppercase">
                    <tr className="border-b border-line">
                      <th scope="col" className="w-10 pl-3">
                        <span className="sr-only">Show line items</span>
                      </th>
                      <SortTh label="Date" sortKey="date" sort={sort} onSort={toggle} />
                      <SortTh label="Payee" sortKey="payee" sort={sort} onSort={toggle} />
                      <SortTh label="Invoice no." sortKey="invoice" sort={sort} onSort={toggle} />
                      <SortTh label="Categories" sortKey="category" sort={sort} onSort={toggle} />
                      <SortTh label="Method" sortKey="method" sort={sort} onSort={toggle} />
                      <SortTh label="Amount" sortKey="amount" sort={sort} onSort={toggle} align="right" />
                      <th scope="col" className="px-4 py-3 text-right font-medium">
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {pageRows.map((row) => {
                      const open = isExpanded(row.id);
                      return (
                        <Fragment key={row.id}>
                          <tr
                            className={`cursor-pointer transition-colors hover:bg-surface-2/60 ${open ? 'bg-surface-2/40' : ''}`}
                            onClick={(e) => !(e.target as HTMLElement).closest('a,button') && navigate(`/expenses/${row.id}`)}
                          >
                            <td className="py-2 pl-3">
                              <button
                                type="button"
                                onClick={() => toggleRow(row.id)}
                                aria-expanded={open}
                                aria-controls={`lines-${row.id}`}
                                aria-label={`${open ? 'Hide' : 'Show'} line items for ${row.payee}`}
                                className="inline-flex size-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-accent-bg hover:text-accent-soft"
                              >
                                <ChevronRight className={`size-4 transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden />
                              </button>
                            </td>
                            <td className="px-4 py-3 whitespace-nowrap text-muted">{formatDisplayDate(row.date)}</td>
                            <td className="w-1/3 max-w-0 px-4 py-3">
                              <div className="flex items-center gap-1.5 font-medium text-ink">
                                <span className="truncate">{row.payee}</span>
                                <DocIndicator documents={row.documents} muted />
                              </div>
                            </td>
                            <td className="w-[30%] max-w-0 px-4 py-3 whitespace-nowrap text-muted">
                              {row.invoiceNumber ? (
                                <div className="truncate" title={row.invoiceNumber}>
                                  {row.invoiceNumber}
                                </div>
                              ) : (
                                <span className="text-faint" aria-label="None">—</span>
                              )}
                            </td>
                            <td className="w-[37%] max-w-0 px-4 py-3 text-muted">
                              <div className="truncate" title={row.categoryNames.join('\n')}>
                                {shortCategoryName(row.categoryNames[0])}
                                {row.categoryNames.length > 1 && <span className="text-faint"> +{row.categoryNames.length - 1}</span>}
                              </div>
                            </td>
                            <td className="px-4 py-3">
                              <PaymentBadge method={row.paymentMethod} />
                            </td>
                            <td
                              className="tabular px-4 py-3 text-right font-semibold whitespace-nowrap text-out-soft"
                              title={row.disallowablePence > 0 ? `${formatGBP(row.disallowablePence)} disallowable` : undefined}
                            >
                              {/* Before the amount, so the amounts still line up on the right. */}
                              {row.disallowablePence > 0 && (
                                <>
                                  <CircleSlash className="mr-1.5 inline size-3.5 align-[-2px] text-faint" aria-hidden />
                                  <span className="sr-only">Includes {formatGBP(row.disallowablePence)} disallowable: </span>
                                </>
                              )}
                              {formatGBP(row.totalPence)}
                            </td>
                            <td className="px-3 py-2">
                              <RowActions
                                viewTo={`/expenses/${row.id}`}
                                editTo={`/expenses/${row.id}/edit`}
                                onDelete={() => setToDelete(row)}
                              />
                            </td>
                          </tr>
                          {open && (
                            <tr id={`lines-${row.id}`} className="border-t-0! bg-surface-2/40">
                              <td />
                              <td colSpan={7} className="px-4 py-4">
                                <LineItemsTable expense={row} />
                                <DocumentsTable documents={row.documents} className="mt-3" />
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <Pagination pagination={pagination} />
              </>
            )}
          </Card>
        )}
      </PageBody>

      <ConfirmDialog
        open={toDelete !== null}
        title="Delete this expense?"
        confirmLabel="Delete"
        onClose={() => setToDelete(null)}
        onConfirm={() => remove.mutateAsync(toDelete!.id)}
      >
        {toDelete && (
          <>
            <p>
              <strong className="text-ink">{toDelete.payee}</strong> on {formatDisplayDate(toDelete.date)} for{' '}
              <strong className="text-ink">{formatGBP(toDelete.totalPence)}</strong> will be permanently deleted, with its{' '}
              {toDelete.lineItemCount} line {toDelete.lineItemCount === 1 ? 'item' : 'items'}
              {toDelete.documents.length ? ` and ${attachedDocuments(toDelete.documents.length)}` : ''}.
            </p>
            <p>This can't be undone.</p>
          </>
        )}
        <SubmittedFiguresNotice taxYearId={toDelete?.taxYearId} dates={[toDelete?.date]} />
      </ConfirmDialog>
    </>
  );
}

/** "Stall fees" or "Beads +2" */
const categorySummary = (names: string[]) =>
  `${shortCategoryName(names[0])}${names.length > 1 ? ` +${names.length - 1}` : ''}`;

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
            <td className="px-4 py-2 text-muted" title={li.categoryName}>
              {shortCategoryName(li.categoryName)}
            </td>
            <td className="tabular px-4 py-2 text-right text-ink">{formatGBP(li.amountPence)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
