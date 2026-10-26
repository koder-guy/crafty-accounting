import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { Download, Pencil, Trash2 } from 'lucide-react';
import { displayTaxYear, formatDisplayDate, formatGBP } from '@crafty/shared';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { BackLink } from '../components/FormShell';
import { PageBody, PageHeader } from '../components/PageHeader';
import { Alert, Button, ButtonLink, Card, DetailRow, PaymentBadge, Spinner } from '../components/ui';
import { documentUrl } from '../lib/api';
import { useDeleteTransaction, useIncome, useTaxYears } from '../lib/queries';

export function IncomeView() {
  const id = Number(useParams().id);
  const navigate = useNavigate();
  const { data: income, isLoading, error } = useIncome(id);
  const { data: years } = useTaxYears();
  const remove = useDeleteTransaction('incomes');
  const [confirming, setConfirming] = useState(false);
  const year = years?.taxYears.find((y) => y.id === income?.taxYearId);

  return (
    <>
      <PageHeader
        title={income ? income.description : 'Incoming'}
        subtitle={income ? `Incoming · ${formatDisplayDate(income.date)}` : undefined}
        actions={
          income && (
            <>
              <ButtonLink to={`/incoming/${id}/edit`}>
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
        <BackLink to="/incoming">All incoming</BackLink>
        {isLoading ? (
          <Spinner />
        ) : error || !income ? (
          <Alert>{error?.message ?? 'Transaction not found'}</Alert>
        ) : (
          <>
            <Card className="px-5 sm:px-6">
              <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-line py-5">
                <span className="tabular text-3xl font-bold text-in-soft">{formatGBP(income.amountPence)}</span>
                <PaymentBadge method={income.paymentMethod} />
              </div>
              <dl className="divide-y divide-line">
                <DetailRow label="Date">{formatDisplayDate(income.date)}</DetailRow>
                <DetailRow label="Description">{income.description}</DetailRow>
                <DetailRow label="Reference">{income.reference}</DetailRow>
                <DetailRow label="Category">
                  {income.categoryName} <span className="ml-1 font-mono text-xs text-faint">{income.hmrcCode}</span>
                </DetailRow>
                <DetailRow label="Tax year">{year ? displayTaxYear(year.label) : null}</DetailRow>
                <DetailRow label="Document">
                  {income.documentFilename && (
                    <a
                      href={documentUrl(income.documentFilename, true)}
                      className="inline-flex items-center gap-1.5 break-all text-accent-soft hover:underline"
                    >
                      <Download className="size-4 shrink-0" aria-hidden />
                      {income.documentFilename}
                    </a>
                  )}
                </DetailRow>
                <DetailRow label="Notes">{income.notes && <span className="whitespace-pre-wrap">{income.notes}</span>}</DetailRow>
              </dl>
            </Card>
          </>
        )}
      </PageBody>

      <ConfirmDialog
        open={confirming}
        title="Delete this incoming transaction?"
        confirmLabel="Delete"
        onClose={() => setConfirming(false)}
        onConfirm={async () => {
          await remove.mutateAsync(id);
          navigate('/incoming');
        }}
      >
        <p>
          This permanently deletes the transaction{income?.documentFilename ? ' and its attached document' : ''}. This can't be undone.
        </p>
      </ConfirmDialog>
    </>
  );
}
