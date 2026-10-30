import { useEffect, useRef, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { displayTaxYear, formatDisplayDate, isDateInTaxYear, parsePoundsToPence, penceToPounds, todayIso, type Income, type PaymentMethod } from '@crafty/shared';
import { CategoryOptions } from '../components/CategoryOptions';
import { BackLink, ChangedElsewhere, CopiedFrom, dateInYear, duplicateDate, yearRangeHint } from '../components/FormShell';
import { NoTaxYear } from '../components/NoTaxYear';
import { PageBody, PageHeader } from '../components/PageHeader';
import { DocumentField, PaymentMethodPicker } from '../components/transactions';
import { SentQuarterNotice } from '../components/SentQuarterNotice';
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
  // Duplicating: /incoming/new?copy=<id> fills the new form from that transaction.
  const [searchParams] = useSearchParams();
  const copyId = id ? null : Number(searchParams.get('copy')) || null;
  const { data: original, isLoading: loadingOriginal, error: originalError } = useIncome(copyId);
  const { data: years } = useTaxYears();
  const { taxYear: activeYear, isLoading: yearLoading } = useActiveTaxYear();
  const { data: categories = [] } = useCategories();
  const incomeCategories = categories.filter((c) => c.type === 'INCOME');
  const save = useSaveTransaction<Income>('incomes');

  const taxYear = id ? (years?.taxYears.find((y) => y.id === existing?.taxYearId) ?? null) : activeYear;

  // New documents to add, and attached ones to remove, when the form is saved.
  const [files, setFiles] = useState<File[]>([]);
  const [removeIds, setRemoveIds] = useState<number[]>([]);
  const [preparingPhoto, setPreparingPhoto] = useState(false);

  const {
    register,
    handleSubmit,
    reset,
    setError,
    control,
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
  const watchedDate = useWatch({ control, name: 'date' });

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
    setRemoveIds([]);
  };

  // Fill the form once the record (edit) or the defaults (new) are known. Only
  // once: live updates refetch the data, and that mustn't wipe what you've typed.
  useEffect(() => {
    const key = id ? `edit-${id}` : `new-${activeYear?.id}-${copyId}`;
    if (filledFor.current === key) return;
    if (id && existing) {
      filledFor.current = key;
      fillFrom(existing);
    } else if (copyId && original && activeYear && incomeCategories.length) {
      // Wait for the categories too, or the category menus can't show the copied choice.
      // The reference and document belong to the original, so they aren't copied.
      filledFor.current = key;
      reset({
        date: duplicateDate(original.date, activeYear),
        description: original.description,
        reference: '',
        paymentMethod: original.paymentMethod,
        amount: penceToPounds(original.amountPence),
        categoryId: String(original.categoryId),
        notes: original.notes ?? '',
      });
    } else if (!id && !copyId && activeYear && incomeCategories.length) {
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
  }, [id, existing, copyId, original, activeYear?.id, incomeCategories.length]);

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
      removeDocumentIds: removeIds,
      expectedUpdatedAt: id ? loaded?.updatedAt : undefined,
    };
    save.mutate(
      { id: id ?? undefined, form: transactionForm(payload, files) },
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

  const title = id ? 'Edit incoming' : copyId ? 'Duplicate incoming' : 'Add incoming';
  const backTo = id ? `/incoming/${id}` : copyId ? `/incoming/${copyId}` : '/incoming';

  if (yearLoading || (id && loadingExisting) || (copyId && loadingOriginal)) {
    return (
      <>
        <PageHeader title={title} />
        <Spinner />
      </>
    );
  }
  if (loadError || originalError) {
    return (
      <>
        <PageHeader title={title} />
        <PageBody>
          <Alert>{(loadError ?? originalError)!.message}</Alert>
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
      <PageHeader
        title={title}
        subtitle={
          existing
            ? `${existing.description} · ${formatDisplayDate(existing.date)}`
            : original
              ? `Copy of ${original.description}`
              : `In tax year ${displayTaxYear(taxYear.label)}`
        }
      />
      <PageBody>
        <BackLink to={backTo}>Back</BackLink>
        {original && (
          <div className="max-w-3xl">
            <CopiedFrom what={original.description} date={original.date} notCopied="The reference and any attached document aren't copied." />
          </div>
        )}
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
                <PaymentMethodPicker registration={register('paymentMethod', { required: 'Choose a payment method' })} />
              </Field>
              <Field label="Reference" htmlFor="reference" hint="Optional, e.g. a payout or receipt number" className="sm:col-span-2">
                <input id="reference" className="field" {...register('reference', { maxLength: 100 })} />
              </Field>
              <Field label="Notes" htmlFor="notes" className="sm:col-span-2">
                <textarea id="notes" rows={3} className="field" {...register('notes', { maxLength: 2000 })} />
              </Field>
              <Field label="Documents" className="sm:col-span-2" hint="Receipts, invoices or delivery notes: PDF or images">
                <DocumentField
                  current={existing?.documents ?? []}
                  files={files}
                  removeIds={removeIds}
                  onFiles={setFiles}
                  onRemoveIds={setRemoveIds}
                  onPreparing={setPreparingPhoto}
                />
              </Field>
            </div>

            <SentQuarterNotice className="mt-5" taxYearId={taxYear.id} dates={[watchedDate, existing?.date]} />

            {save.error && (
              <div className="mt-5">
                <Alert>{save.error.message}</Alert>
              </div>
            )}

            <div className="mt-6 flex justify-end gap-3 border-t border-line pt-5">
              <Button type="button" variant="ghost" onClick={() => navigate(backTo)}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" busy={save.isPending || preparingPhoto}>
                {id ? 'Save changes' : 'Add incoming'}
              </Button>
            </div>
          </Card>
        </form>
      </PageBody>
    </>
  );
}
