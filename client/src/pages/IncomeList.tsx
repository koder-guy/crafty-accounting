import { Fragment, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { ArrowDownRight, ChevronRight, Plus } from 'lucide-react';
import { formatDisplayDate, formatGBP, shortCategoryName, type Income } from '@crafty/shared';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Pagination, usePagination } from '../components/Pagination';
import { ImportButton } from '../components/ImportTransactions';
import { SquareImportButton } from '../components/SquareImport';
import { DeleteShownButton } from '../components/DeleteShownButton';
import { SubmittedFiguresNotice } from '../components/SubmittedFiguresNotice';
import { NoTaxYear } from '../components/NoTaxYear';
import { PageBody, PageHeader } from '../components/PageHeader';
import {
  attachedDocuments,
  DocIndicator,
  DocumentsTable,
  NotesIndicator,
  NotesPanel,
  ValueStrip,
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
import { Alert, ButtonLink, Card, CardHeader, EmptyState, PaymentBadge, Spinner } from '../components/ui';
import { exportUrl, useActiveTaxYear, useCanEdit, useCategories, useDeleteTransaction, useExpandedRows, useIncomes } from '../lib/queries';

export function IncomeList() {
  const { taxYear, isLoading: yearLoading } = useActiveTaxYear();
  const filterState = useTransactionFilters(taxYear);
  const { data: categories = [] } = useCategories();
  const { data, isLoading, error } = useIncomes(filterState.filters);
  const canEdit = useCanEdit();
  const [filtersShown, setFiltersShown] = useFiltersShown('incomes');
  const remove = useDeleteTransaction('incomes');
  const [toDelete, setToDelete] = useState<Income | null>(null);
  const navigate = useNavigate();
  const { isExpanded, toggle: toggleRow } = useExpandedRows('incomes');

  const { sorted, sort, toggle: toggleSort } = useSort(
    data,
    {
      date: (r) => `${r.date}-${String(r.id).padStart(8, '0')}`,
      description: (r) => r.description.toLowerCase(),
      category: (r) => r.categoryName,
      method: (r) => r.paymentMethod,
      amount: (r) => r.amountPence,
    },
    'date',
    'incomes',
  );
  const tableTop = useRef<HTMLElement>(null);
  const pagination = usePagination(sorted, tableTop);
  const { pageRows } = pagination;
  // A new order starts again from the first page.
  const toggle = (key: Parameters<typeof toggleSort>[0]) => {
    toggleSort(key);
    pagination.setPage(1, false);
  };
  const total = (data ?? []).reduce((acc, r) => acc + r.amountPence, 0);

  return (
    <>
      <PageHeader title="Income" />
      <PageBody>
        {yearLoading ? (
          <Spinner />
        ) : !taxYear ? (
          <NoTaxYear />
        ) : (
          <Card ref={tableTop}>
            <CardHeader
              icon={<ArrowDownRight className="size-5 text-in-soft" />}
              title="Income received"
              tools={
                <>
                  <FilterToggle
                    shown={filtersShown}
                    onToggle={() => setFiltersShown((v) => !v)}
                    controls="incomes-filters"
                    active={filterState.active}
                  />
                  {canEdit && (
                    <ButtonLink to="/income/new" aria-label="Add income" title="Add income" className="size-9 shrink-0 !p-0">
                      <Plus className="size-4" aria-hidden />
                    </ButtonLink>
                  )}
                  {canEdit && <ImportButton kind="incomes" iconOnly />}
                  {canEdit && <SquareImportButton />}
                  {filterState.filters && <ExportMenu href={(format) => exportUrl('incomes', filterState.filters!, format)} count={data?.length} iconOnly />}
                  {canEdit && (
                    <DeleteShownButton kind="incomes" rows={data ?? []} filtered={filterState.active} totalPence={total} taxYearId={taxYear.id} />
                  )}
                </>
              }
              action={
                data && (
                  <span className="text-sm text-muted">
                    {data.length} {filterState.active ? 'filtered ' : ''}
                    {data.length === 1 ? 'transaction' : 'transactions'} ·{' '}
                    <span className="tabular font-semibold text-in-soft">{formatGBP(total)}</span>
                  </span>
                )
              }
            />
            <FilterBar filterState={filterState} categories={categories} type="INCOME" id="incomes-filters" shown={filtersShown} />
            {error ? (
              <div className="p-6">
                <Alert>{error.message}</Alert>
              </div>
            ) : isLoading ? (
              <Spinner />
            ) : sorted.length === 0 ? (
              <EmptyState icon={<ArrowDownRight className="size-10" />} title={filterState.active ? 'No matching transactions' : 'No income recorded yet'}>
                {filterState.active ? 'Try changing or clearing the filters.' : 'Record your first sale with “Add income”.'}
              </EmptyState>
            ) : (
              <>
              <ul className="divide-y divide-line border-t border-line sm:hidden">
                {pageRows.map((row) => (
                  <TransactionCard
                    key={row.id}
                    to={`/income/${row.id}`}
                    title={row.description}
                    sub={`${formatDisplayDate(row.date)} · ${shortCategoryName(row.categoryName)}`}
                    amount={formatGBP(row.amountPence)}
                    amountClass="text-in-soft"
                    method={row.paymentMethod}
                    documents={row.documents}
                    notes={row.notes}
                  />
                ))}
              </ul>
              <div className="hidden overflow-x-auto sm:block">
                <table className="w-full min-w-[720px] text-sm">
                  <thead className="text-xs tracking-wide text-muted uppercase">
                    <tr className="border-b border-line">
                      <th scope="col" className="w-10 pl-3">
                        <span className="sr-only">Show details</span>
                      </th>
                      <SortTh label="Date" sortKey="date" sort={sort} onSort={toggle} />
                      <SortTh label="Description" sortKey="description" sort={sort} onSort={toggle} />
                      <SortTh label="Category" sortKey="category" sort={sort} onSort={toggle} />
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
                      // Only a row with documents, a reference or notes has anything to show when expanded.
                      const expandable = row.documents.length > 0 || !!row.reference?.trim() || !!row.notes?.trim();
                      const open = expandable && isExpanded(row.id);
                      return (
                        <Fragment key={row.id}>
                          <tr
                            className={`cursor-pointer transition-colors hover:bg-surface-2/60 ${open ? 'bg-surface-2/40' : ''}`}
                            onClick={(e) => !(e.target as HTMLElement).closest('a,button') && navigate(`/income/${row.id}`)}
                          >
                            <td className="py-2 pl-3">
                              {expandable && (
                                <button
                                  type="button"
                                  onClick={() => toggleRow(row.id)}
                                  aria-expanded={open}
                                  aria-controls={`details-${row.id}`}
                                  aria-label={`${open ? 'Hide' : 'Show'} details for ${row.description}`}
                                  className="inline-flex size-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-accent-bg hover:text-accent-soft"
                                >
                                  <ChevronRight className={`size-4 transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden />
                                </button>
                              )}
                            </td>
                            <td className="px-4 py-3 whitespace-nowrap text-muted">{formatDisplayDate(row.date)}</td>
                            <td className="w-2/3 max-w-0 px-4 py-3">
                              <div className="flex items-center gap-1.5 font-medium text-ink">
                                <Link to={`/income/${row.id}`} className="min-w-0 truncate rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-soft">
                                  {row.description}
                                </Link>
                                <NotesIndicator notes={row.notes} muted />
                                <DocIndicator documents={row.documents} muted />
                              </div>
                            </td>
                            <td className="w-1/3 max-w-0 truncate px-4 py-3 text-muted" title={row.categoryName}>
                              {shortCategoryName(row.categoryName)}
                            </td>
                            <td className="px-4 py-3">
                              <PaymentBadge method={row.paymentMethod} />
                            </td>
                            <td className="tabular px-4 py-3 text-right font-semibold whitespace-nowrap text-in-soft">
                              {formatGBP(row.amountPence)}
                            </td>
                            {canEdit && (
                              <td className="px-3 py-2">
                                <RowActions editTo={`/income/${row.id}/edit`} onDelete={() => setToDelete(row)} />
                              </td>
                            )}
                          </tr>
                          {open && (
                            <tr id={`details-${row.id}`} className="border-t-0! bg-surface-2/40">
                              <td />
                              <td colSpan={canEdit ? 6 : 5} className="px-4 py-4">
                                <div className="space-y-3">
                                  <ValueStrip label="Reference" value={row.reference} />
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
        title="Delete this income?"
        confirmLabel="Delete"
        onClose={() => setToDelete(null)}
        onConfirm={() => remove.mutateAsync(toDelete!.id)}
      >
        {toDelete && (
          <>
            <p>
              <strong className="text-ink">{toDelete.description}</strong> on {formatDisplayDate(toDelete.date)} for{' '}
              <strong className="text-ink">{formatGBP(toDelete.amountPence)}</strong> will be permanently deleted
              {toDelete.documents.length ? `, along with ${attachedDocuments(toDelete.documents.length)}` : ''}.
            </p>
            <p>This can't be undone.</p>
          </>
        )}
        <SubmittedFiguresNotice taxYearId={toDelete?.taxYearId} dates={[toDelete?.date]} />
      </ConfirmDialog>
    </>
  );
}
