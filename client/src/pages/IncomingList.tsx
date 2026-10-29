import { useState } from 'react';
import { useNavigate } from 'react-router';
import { ArrowDownRight, Plus } from 'lucide-react';
import { formatDisplayDate, formatGBP, shortCategoryName, type Income } from '@crafty/shared';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { SentQuarterNotice } from '../components/SentQuarterNotice';
import { NoTaxYear } from '../components/NoTaxYear';
import { PageBody, PageHeader } from '../components/PageHeader';
import {
  attachedDocuments,
  DocDownloadLink,
  ExportCsvButton,
  FilterBar,
  RowActions,
  SortTh,
  TransactionCard,
  useSort,
  useTransactionFilters,
} from '../components/transactions';
import { Alert, ButtonLink, Card, CardHeader, EmptyState, PaymentBadge, Spinner } from '../components/ui';
import { exportCsvUrl, useActiveTaxYear, useCanEdit, useCategories, useDeleteTransaction, useIncomes } from '../lib/queries';

export function IncomingList() {
  const { taxYear, isLoading: yearLoading } = useActiveTaxYear();
  const filterState = useTransactionFilters(taxYear);
  const { data: categories = [] } = useCategories();
  const { data, isLoading, error } = useIncomes(filterState.filters);
  const canEdit = useCanEdit();
  const remove = useDeleteTransaction('incomes');
  const [toDelete, setToDelete] = useState<Income | null>(null);
  const navigate = useNavigate();

  const { sorted, sort, toggle } = useSort(
    data,
    {
      date: (r) => `${r.date}-${String(r.id).padStart(8, '0')}`,
      description: (r) => r.description.toLowerCase(),
      category: (r) => r.categoryName,
      method: (r) => r.paymentMethod,
      amount: (r) => r.amountPence,
    },
    'date',
  );
  const total = (data ?? []).reduce((acc, r) => acc + r.amountPence, 0);

  return (
    <>
      <PageHeader
        title="Incoming"
        actions={
          taxYear && (
            <>
              {filterState.filters && <ExportCsvButton href={exportCsvUrl('incomes', filterState.filters)} />}
              {canEdit && (
                <ButtonLink to="/incoming/new" variant="primary">
                  <Plus className="size-4" aria-hidden />
                  Add incoming
                </ButtonLink>
              )}
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
              icon={<ArrowDownRight className="size-5 text-in-soft" />}
              title="Incoming sales"
              action={
                data && (
                  <span className="text-sm text-muted">
                    {data.length} {data.length === 1 ? 'transaction' : 'transactions'} ·{' '}
                    <span className="tabular font-semibold text-in-soft">{formatGBP(total)}</span>
                  </span>
                )
              }
            />
            <FilterBar filterState={filterState} categories={categories} type="INCOME" />
            {error ? (
              <div className="p-6">
                <Alert>{error.message}</Alert>
              </div>
            ) : isLoading ? (
              <Spinner />
            ) : sorted.length === 0 ? (
              <EmptyState icon={<ArrowDownRight className="size-10" />} title={filterState.active ? 'No matching transactions' : 'No incoming transactions yet'}>
                {filterState.active ? 'Try changing or clearing the filters.' : 'Record your first sale with “Add incoming”.'}
              </EmptyState>
            ) : (
              <>
              <ul className="divide-y divide-line border-t border-line sm:hidden">
                {sorted.map((row) => (
                  <TransactionCard
                    key={row.id}
                    to={`/incoming/${row.id}`}
                    title={row.description}
                    sub={`${formatDisplayDate(row.date)} · ${shortCategoryName(row.categoryName)}`}
                    amount={formatGBP(row.amountPence)}
                    amountClass="text-in-soft"
                    method={row.paymentMethod}
                    documents={row.documents}
                  />
                ))}
              </ul>
              <div className="hidden overflow-x-auto sm:block">
                <table className="w-full min-w-[720px] text-sm">
                  <thead className="text-xs tracking-wide text-muted uppercase">
                    <tr className="border-b border-line">
                      <SortTh label="Date" sortKey="date" sort={sort} onSort={toggle} />
                      <SortTh label="Description" sortKey="description" sort={sort} onSort={toggle} />
                      <SortTh label="Category" sortKey="category" sort={sort} onSort={toggle} />
                      <SortTh label="Method" sortKey="method" sort={sort} onSort={toggle} />
                      <SortTh label="Amount" sortKey="amount" sort={sort} onSort={toggle} align="right" />
                      <th scope="col" className="px-4 py-3 text-right font-medium">
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {sorted.map((row) => (
                      <tr
                        key={row.id}
                        className="cursor-pointer transition-colors hover:bg-surface-2/60"
                        onClick={(e) => !(e.target as HTMLElement).closest('a,button') && navigate(`/incoming/${row.id}`)}
                      >
                        <td className="px-4 py-3 whitespace-nowrap text-muted">{formatDisplayDate(row.date)}</td>
                        <td className="w-2/3 max-w-0 px-4 py-3">
                          <div className="flex items-center gap-1.5 font-medium text-ink">
                            <span className="truncate">{row.description}</span>
                            <DocDownloadLink documents={row.documents} />
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
                        <td className="px-3 py-2">
                          <RowActions
                            viewTo={`/incoming/${row.id}`}
                            editTo={`/incoming/${row.id}/edit`}
                            onDelete={() => setToDelete(row)}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              </>
            )}
          </Card>
        )}
      </PageBody>

      <ConfirmDialog
        open={toDelete !== null}
        title="Delete this incoming transaction?"
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
        <SentQuarterNotice taxYearId={toDelete?.taxYearId} dates={[toDelete?.date]} />
      </ConfirmDialog>
    </>
  );
}
