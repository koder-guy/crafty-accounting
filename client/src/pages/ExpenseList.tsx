import { Fragment, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { ArrowUpRight, ChevronRight, CircleSlash, Plus, ScanText } from 'lucide-react';
import { formatDisplayDate, formatGBP, shortCategoryName, type Expense, type ExpenseWithLineItems } from '@crafty/shared';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { recordedBy } from '../components/FormShell';
import { Pagination, usePagination } from '../components/Pagination';
import { ImportButton } from '../components/ImportTransactions';
import { DeleteShownButton } from '../components/DeleteShownButton';
import { SubmittedFiguresNotice } from '../components/SubmittedFiguresNotice';
import { NoTaxYear } from '../components/NoTaxYear';
import { PageBody, PageHeader } from '../components/PageHeader';
import {
  attachedDocuments,
  DocIndicator,
  DetailHeading,
  DocumentsTable,
  NotesIndicator,
  NotesPanel,
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
import { exportUrl, useActiveTaxYear, useCanEdit, useCategories, useAi, useDeleteTransaction, useExpandedRows, useExpenses, useScans } from '../lib/queries';

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
  const { data: ai } = useAi();
  const { data: scans } = useScans(canEdit);
  const toCheck = scans?.scans.length ?? 0;

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
                  {canEdit && (ai?.configured || toCheck > 0) && (
                    <ButtonLink
                      to="/expenses/scans"
                      aria-label={toCheck ? `Scan documents (${toCheck} to check)` : 'Scan documents'}
                      title={toCheck ? `Scan documents: ${toCheck} to check` : 'Scan documents'}
                      className="relative size-9 shrink-0 !p-0"
                    >
                      <ScanText className="size-4" aria-hidden />
                      {toCheck > 0 && (
                        <span className="absolute -top-1.5 -right-1.5 inline-flex min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] leading-4 font-semibold text-white">
                          {toCheck}
                        </span>
                      )}
                    </ButtonLink>
                  )}
                  {canEdit && <ImportButton kind="expenses" iconOnly />}
                  {filterState.filters && <ExportMenu href={(format) => exportUrl('expenses', filterState.filters!, format)} count={data?.length} iconOnly />}
                  {canEdit && (
                    <DeleteShownButton kind="expenses" rows={data ?? []} filtered={filterState.active} totalPence={total} taxYearId={taxYear.id} />
                  )}
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
                    notes={row.notes}
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
                      {canEdit && (
                        <th scope="col" className="px-4 py-3 text-right font-medium">
                          Actions
                        </th>
                      )}
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
                                <Link to={`/expenses/${row.id}`} className="min-w-0 truncate rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-soft">
                                  {row.payee}
                                </Link>
                                <NotesIndicator notes={row.notes} muted />
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
                            {canEdit && (
                              <td className="px-3 py-2">
                                <RowActions editTo={`/expenses/${row.id}/edit`} onDelete={() => setToDelete(row)} />
                              </td>
                            )}
                          </tr>
                          {open && (
                            <tr id={`lines-${row.id}`} className="border-t-0! bg-surface-2/40">
                              <td />
                              <td colSpan={canEdit ? 7 : 6} className="px-4 py-4">
                                <div className="space-y-3">
                                  <ExpenseSummary expense={row} />
                                  <LineItemsTable expense={row} />
                                  <DocumentsTable documents={row.documents} />
                                  <NotesPanel notes={row.notes} />
                                </div>
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

/**
 * The boxes at the top of an expanded row, side by side from small screens up: the invoice and order
 * numbers (only when it has either) and who added and last changed it.
 */
function ExpenseSummary({ expense }: { expense: Expense }) {
  const changed = expense.updatedAt !== expense.createdAt;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {(expense.invoiceNumber || expense.orderNumber) && (
        <PairBox
          label="Invoice and order numbers"
          rows={[
            ['Invoice #', expense.invoiceNumber],
            ['Order #', expense.orderNumber],
          ]}
        />
      )}
      <PairBox
        label="Who added and changed it"
        rows={[
          ['Added by', recordedBy(expense.createdBy, expense.createdAt)],
          ['Last changed by', changed ? recordedBy(expense.updatedBy, expense.updatedAt) : null],
        ]}
      />
    </div>
  );
}

/**
 * Two labelled values boxed like the notes: the first in the header strip, the second below. The rows
 * share one grid (subgrid), so both values start 20px after the wider label. A missing value shows a dash.
 */
function PairBox({ label, rows: [first, second] }: { label: string; rows: [[string, string | null], [string, string | null]] }) {
  const labelClass = 'text-xs font-medium tracking-wide whitespace-nowrap text-faint uppercase';
  return (
    <dl aria-label={label} className="grid grid-cols-[auto_minmax(0,1fr)] rounded-lg border border-line bg-page/40 text-sm">
      {/* leading-4 keeps the strip the height of the tables' header rows, whatever the value's size. */}
      <div className="col-span-2 grid grid-cols-subgrid gap-x-5 border-b border-line px-4 py-2 leading-4">
        <dt className={labelClass}>
          <DetailHeading>{first[0]}</DetailHeading>
        </dt>
        <dd className="truncate text-ink" title={first[1] ?? undefined}>
          <DetailHeading>{first[1] ?? '—'}</DetailHeading>
        </dd>
      </div>
      <div className="col-span-2 grid grid-cols-subgrid items-baseline gap-x-5 px-4 py-2">
        <dt className={labelClass}>{second[0]}</dt>
        <dd className="break-words text-ink">{second[1] ?? '—'}</dd>
      </div>
    </dl>
  );
}

/** Read-only line items shown under an expanded row. */
function LineItemsTable({ expense }: { expense: ExpenseWithLineItems }) {
  return (
    // Boxed in a div: a table's collapsed border can't have rounded corners.
    <div className="overflow-hidden rounded-lg border border-line bg-page/40">
      <table className="w-full text-sm">
        <thead className="text-xs tracking-wide text-faint uppercase">
          <tr className="border-b border-line">
            <th scope="col" className="px-4 py-2 text-left font-medium">
              <DetailHeading>Line items</DetailHeading>
            </th>
            <th scope="col" className="px-4 py-2 text-left font-medium">
              <DetailHeading>Category</DetailHeading>
            </th>
            <th scope="col" className="px-4 py-2 text-right font-medium">
              <DetailHeading>Amount</DetailHeading>
            </th>
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
    </div>
  );
}
