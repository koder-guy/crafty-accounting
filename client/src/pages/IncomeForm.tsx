import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useNavigate, useParams } from 'react-router';
import { isDateInTaxYear, parsePoundsToPence, penceToPounds, todayIso, type Income, type PaymentMethod } from '@crafty/shared';
import { CategoryOptions } from '../components/CategoryOptions';
import { BackLink, ChangedElsewhere, dateInYear, yearRangeHint } from '../components/FormShell';
import { NoTaxYear } from '../components/NoTaxYear';
import { PageBody, PageHeader } from '../components/PageHeader';
import { DocumentField, PaymentMethodOptions } from '../components/transactions';
import { Alert, Button, Card, Field, Spinner } from '../components/ui';
import { ApiError, transactionForm } from '../lib/api';
import { useActiveTaxYear, useCategories, useIncome, useSaveTransaction, useTaxYears } from '../lib/queries';

interface Values {
  date: string;
  description: string;
  reference: string;
  paymentMethod: PaymentMethod | '';
  amount: string;
  categoryId: string;
  notes: string;
}

export function IncomeForm() {
  const params = useParams();
  const id = params.id ? Number(params.id) : null;
  const navigate = useNavigate();
  const { data: existing, isLoading: loadingExisting, error: loadError, refetch: refetchExisting } = useIncome(id);
  const { data: years } = useTaxYears();
  const { taxYear: activeYear, isLoading: yearLoading } = useActiveTaxYear();
  const { data: categories = [] } = useCategories();
  const incomeCategories = categories.filter((c) => c.type === 'INCOME');
  const save = useSaveTransaction<Income>('incomes');

  const taxYear = id ? (years?.taxYears.find((y) => y.id === existing?.taxYearId) ?? null) : activeYear;

  const [file, setFile] = useState<File | null>(null);
  const [removeDoc, setRemoveDoc] = useState(false);

  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors },
  } = useForm<Values>({
    defaultValues: {
      date: '',
      description: '',
      reference: '',
      paymentMethod: '',
      amount: '',
      categoryId: '',
      notes: '',
    },
  });

  // The version of the record the form was filled from; saving is refused if it has changed since.
  const [loaded, setLoaded] = useState<Income | null>(null);
  const filledFor = useRef<string | null>(null);
  const fillFrom = (record: Income) => {
    reset({
      date: record.date,
      description: record.description,
      reference: record.reference ?? '',
      paymentMethod: record.paymentMethod,
      amount: penceToPounds(record.amountPence),
      categoryId: String(record.categoryId),
      notes: record.notes ?? '',
    });
    setLoaded(record);
  };

  // Fill the form once the record (edit) or the defaults (new) are known. Only
  // once: live updates refetch the data, and that mustn't wipe what you've typed.
  useEffect(() => {
    const key = id ? `edit-${id}` : `new-${activeYear?.id}`;
    if (filledFor.current === key) return;
    if (id && existing) {
      filledFor.current = key;
      fillFrom(existing);
    } else if (!id && activeYear && incomeCategories.length) {
      filledFor.current = key;
      const today = todayIso();
      reset({
        date: isDateInTaxYear(today, activeYear) ? today : '',
        description: '',
        reference: '',
        paymentMethod: '',
        amount: '',
        categoryId: String(incomeCategories.find((c) => !c.isCustom && c.hmrcCode === 'turnover')?.id ?? ''),
        notes: '',
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, existing, activeYear?.id, incomeCategories.length]);

  const onSubmit = handleSubmit((values) => {
    if (!taxYear) return;
    const payload = {
      taxYearId: taxYear.id,
      date: values.date,
      description: values.description,
      // The source field is no longer shown; keep any value already stored.
      source: loaded?.source ?? null,
      reference: values.reference,
      paymentMethod: values.paymentMethod,
      amountPence: parsePoundsToPence(values.amount),
      categoryId: Number(values.categoryId),
      notes: values.notes,
      removeDocument: removeDoc,
      expectedUpdatedAt: id ? loaded?.updatedAt : undefined,
    };
    save.mutate(
      { id: id ?? undefined, form: transactionForm(payload, file) },
      {
        onSuccess: (saved) => navigate(`/incoming/${saved.id}`),
        onError: (err) => {
          // Someone else saved first: fetch their version so the form can offer it.
          if (err instanceof ApiError && err.status === 409) refetchExisting();
          if (err instanceof ApiError) {
            for (const d of err.details ?? []) {
              if (d.path === 'date') setError('date', { message: err.message });
            }
          }
        },
      },
    );
  });

  const title = id ? 'Edit incoming' : 'Add incoming';
  const backTo = id ? `/incoming/${id}` : '/incoming';

  if (yearLoading || (id && loadingExisting)) {
    return (
      <>
        <PageHeader title={title} />
        <Spinner />
      </>
    );
  }
  if (loadError) {
    return (
      <>
        <PageHeader title={title} />
        <PageBody>
          <Alert>{loadError.message}</Alert>
        </PageBody>
      </>
    );
  }
  if (!taxYear) {
    return (
      <>
        <PageHeader title={title} />
        <PageBody>
          <NoTaxYear />
        </PageBody>
      </>
    );
  }

  return (
    <>
      <PageHeader title={title} />
      <PageBody>
        <BackLink to={backTo}>Back</BackLink>
        {existing && loaded && existing.updatedAt !== loaded.updatedAt && (
          <div className="max-w-3xl">
            <ChangedElsewhere
              by={existing.updatedBy}
              onLoad={() => {
                fillFrom(existing);
                save.reset();
              }}
            />
          </div>
        )}
        <form onSubmit={onSubmit} noValidate>
          <Card className="max-w-3xl p-5 sm:p-6">
            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="Date" htmlFor="date" error={errors.date?.message} hint={yearRangeHint(taxYear)}>
                <input
                  id="date"
                  type="date"
                  className="field"
                  min={taxYear.startDate}
                  max={taxYear.endDate}
                  {...register('date', { validate: dateInYear(taxYear) })}
                />
              </Field>
              <Field label="Amount (£)" htmlFor="amount" error={errors.amount?.message}>
                <input
                  id="amount"
                  inputMode="decimal"
                  placeholder="0.00"
                  className="field tabular"
                  {...register('amount', {
                    validate: (v) => {
                      const pence = parsePoundsToPence(v);
                      return (pence !== null && pence > 0) || 'Enter an amount above £0.00, e.g. 12.50';
                    },
                  })}
                />
              </Field>
              <Field label="Description" htmlFor="description" error={errors.description?.message} className="sm:col-span-2">
                <input
                  id="description"
                  className="field"
                  {...register('description', { required: 'Description is required', maxLength: 500 })}
                />
              </Field>
              <Field label="Category" htmlFor="categoryId" error={errors.categoryId?.message}>
                <select id="categoryId" className="field" {...register('categoryId', { required: 'Choose a category' })}>
                  <option value="">Choose…</option>
                  <CategoryOptions categories={categories} type="INCOME" />
                </select>
              </Field>
              <Field label="Payment method" htmlFor="paymentMethod" error={errors.paymentMethod?.message}>
                <select id="paymentMethod" className="field" {...register('paymentMethod', { required: 'Choose a payment method' })}>
                  <PaymentMethodOptions />
                </select>
              </Field>
              <Field label="Reference" htmlFor="reference" hint="Optional, e.g. a payout or receipt number" className="sm:col-span-2">
                <input id="reference" className="field" {...register('reference', { maxLength: 100 })} />
              </Field>
              <Field label="Notes" htmlFor="notes" className="sm:col-span-2">
                <textarea id="notes" rows={3} className="field" {...register('notes', { maxLength: 2000 })} />
              </Field>
              <Field label="Document" className="sm:col-span-2">
                <DocumentField
                  current={existing?.documentFilename ?? null}
                  file={file}
                  remove={removeDoc}
                  onFile={setFile}
                  onRemove={setRemoveDoc}
                />
              </Field>
            </div>

            {save.error && (
              <div className="mt-5">
                <Alert>{save.error.message}</Alert>
              </div>
            )}

            <div className="mt-6 flex justify-end gap-3 border-t border-line pt-5">
              <Button type="button" variant="ghost" onClick={() => navigate(backTo)}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" busy={save.isPending}>
                {id ? 'Save changes' : 'Add incoming'}
              </Button>
            </div>
          </Card>
        </form>
      </PageBody>
    </>
  );
}
