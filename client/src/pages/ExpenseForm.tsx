import { useEffect, useRef, useState } from 'react';
import { useFieldArray, useForm, useWatch } from 'react-hook-form';
import { useNavigate, useParams } from 'react-router';
import { Plus, Trash2 } from 'lucide-react';
import {
  formatGBP,
  isDateInTaxYear,
  parsePoundsToPence,
  penceToPounds,
  todayIso,
  type ExpenseWithLineItems,
  type PaymentMethod,
} from '@crafty/shared';
import { CategoryOptions } from '../components/CategoryOptions';
import { BackLink, ChangedElsewhere, dateInYear, yearRangeHint } from '../components/FormShell';
import { NoTaxYear } from '../components/NoTaxYear';
import { PageBody, PageHeader } from '../components/PageHeader';
import { DocumentField, PaymentMethodOptions } from '../components/transactions';
import { Alert, Button, Card, CardHeader, Field, IconButton, Spinner } from '../components/ui';
import { ApiError, transactionForm } from '../lib/api';
import { useActiveTaxYear, useCategories, useExpense, useSaveTransaction, useTaxYears } from '../lib/queries';

interface LineValues {
  /** Database id for existing line items; useFieldArray reserves "id". */
  lineId?: number;
  description: string;
  amount: string;
  categoryId: string;
  disallowable: boolean;
}

interface Values {
  date: string;
  payee: string;
  invoiceNumber: string;
  orderNumber: string;
  description: string;
  paymentMethod: PaymentMethod | '';
  total: string;
  notes: string;
  lineItems: LineValues[];
}

const emptyLine = (categoryId = ''): LineValues => ({ description: '', amount: '', categoryId, disallowable: false });

const validAmount = (v: string) => {
  const pence = parsePoundsToPence(v);
  return (pence !== null && pence > 0) || 'Enter an amount above £0.00';
};

export function ExpenseForm() {
  const params = useParams();
  const id = params.id ? Number(params.id) : null;
  const navigate = useNavigate();
  const { data: existing, isLoading: loadingExisting, error: loadError, refetch: refetchExisting } = useExpense(id);
  const { data: years } = useTaxYears();
  const { taxYear: activeYear, isLoading: yearLoading } = useActiveTaxYear();
  const { data: categories = [] } = useCategories();
  const expenseCategories = categories.filter((c) => c.type === 'EXPENSE');
  const defaultCategory = String(expenseCategories.find((c) => !c.isCustom && c.hmrcCode === 'costOfGoods')?.id ?? '');
  const save = useSaveTransaction<ExpenseWithLineItems>('expenses');

  const taxYear = id ? (years?.taxYears.find((y) => y.id === existing?.taxYearId) ?? null) : activeYear;

  const [file, setFile] = useState<File | null>(null);
  const [removeDoc, setRemoveDoc] = useState(false);

  const {
    register,
    control,
    handleSubmit,
    reset,
    setError,
    setValue,
    formState: { errors, isSubmitted },
  } = useForm<Values>({
    defaultValues: {
      date: '',
      payee: '',
      invoiceNumber: '',
      orderNumber: '',
      description: '',
      paymentMethod: '',
      total: '',
      notes: '',
      lineItems: [emptyLine()],
    },
  });
  const { fields, append, remove } = useFieldArray({ control, name: 'lineItems' });

  // The version of the record the form was filled from; saving is refused if it has changed since.
  const [loaded, setLoaded] = useState<ExpenseWithLineItems | null>(null);
  const filledFor = useRef<string | null>(null);
  const fillFrom = (record: ExpenseWithLineItems) => {
    reset({
      date: record.date,
      payee: record.payee,
      invoiceNumber: record.invoiceNumber ?? '',
      orderNumber: record.orderNumber ?? '',
      description: record.description ?? '',
      paymentMethod: record.paymentMethod,
      total: penceToPounds(record.totalPence),
      notes: record.notes ?? '',
      lineItems: record.lineItems.map((li) => ({
        lineId: li.id,
        description: li.description,
        amount: penceToPounds(li.amountPence),
        categoryId: String(li.categoryId),
        disallowable: li.disallowable,
      })),
    });
    setLoaded(record);
  };

  // Fill the form once: live updates refetch the data, and that mustn't wipe what you've typed.
  useEffect(() => {
    const key = id ? `edit-${id}` : `new-${activeYear?.id}`;
    if (filledFor.current === key) return;
    if (id && existing) {
      filledFor.current = key;
      fillFrom(existing);
    } else if (!id && activeYear && expenseCategories.length) {
      filledFor.current = key;
      const today = todayIso();
      reset({
        date: isDateInTaxYear(today, activeYear) ? today : '',
        payee: '',
        invoiceNumber: '',
        orderNumber: '',
        description: '',
        paymentMethod: '',
        total: '',
        notes: '',
        lineItems: [emptyLine(defaultCategory)],
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, existing, activeYear?.id, expenseCategories.length]);

  const watchedLines = useWatch({ control, name: 'lineItems' });
  const watchedTotal = useWatch({ control, name: 'total' });
  const linePence = (watchedLines ?? []).map((li) => parsePoundsToPence(li?.amount ?? ''));
  const linesValid = linePence.every((p) => p !== null && p > 0);
  const lineSum = linePence.reduce<number>((acc, p) => acc + (p ?? 0), 0);
  const totalPence = parsePoundsToPence(watchedTotal ?? '');
  const disallowableSum = (watchedLines ?? []).reduce(
    (acc, li, i) => acc + (li?.disallowable ? (linePence[i] ?? 0) : 0),
    0,
  );
  const difference = totalPence !== null ? totalPence - lineSum : null;
  const matches = difference === 0 && linesValid;

  const onSubmit = handleSubmit((values) => {
    if (!taxYear || !matches) return;
    const payload = {
      taxYearId: taxYear.id,
      date: values.date,
      payee: values.payee,
      invoiceNumber: values.invoiceNumber,
      orderNumber: values.orderNumber,
      description: values.description,
      paymentMethod: values.paymentMethod,
      totalPence: parsePoundsToPence(values.total),
      notes: values.notes,
      removeDocument: removeDoc,
      expectedUpdatedAt: id ? loaded?.updatedAt : undefined,
      lineItems: values.lineItems.map((li) => ({
        id: li.lineId,
        description: li.description,
        amountPence: parsePoundsToPence(li.amount),
        categoryId: Number(li.categoryId),
        disallowable: li.disallowable,
      })),
    };
    save.mutate(
      { id: id ?? undefined, form: transactionForm(payload, file) },
      {
        onSuccess: (saved) => navigate(`/outgoing/${saved.id}`),
        onError: (err) => {
          // Someone else saved first: fetch their version so the form can offer it.
          if (err instanceof ApiError && err.status === 409) refetchExisting();
          if (err instanceof ApiError && err.details?.some((d) => d.path === 'date')) {
            setError('date', { message: err.message });
          }
        },
      },
    );
  });

  const title = id ? 'Edit outgoing' : 'Add outgoing';
  const backTo = id ? `/outgoing/${id}` : '/outgoing';

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
          <ChangedElsewhere
            by={existing.updatedBy}
            onLoad={() => {
              fillFrom(existing);
              save.reset();
            }}
          />
        )}
        <form onSubmit={onSubmit} noValidate className="space-y-6">
          <Card className="p-5 sm:p-6">
            <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
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
              <Field label="Payee" htmlFor="payee" error={errors.payee?.message}>
                <input
                  id="payee"
                  className="field"
                  placeholder="Bead World Ltd"
                  {...register('payee', { required: 'Payee is required', maxLength: 200 })}
                />
              </Field>
              <Field label="Invoice number" htmlFor="invoiceNumber" hint="Optional">
                <input id="invoiceNumber" className="field" {...register('invoiceNumber', { maxLength: 100 })} />
              </Field>
              <Field label="Order number" htmlFor="orderNumber" hint="Optional">
                <input id="orderNumber" className="field" {...register('orderNumber', { maxLength: 100 })} />
              </Field>
              <Field label="Transaction amount (£)" htmlFor="total" error={errors.total?.message} hint="The invoice total">
                <input
                  id="total"
                  inputMode="decimal"
                  placeholder="0.00"
                  className="field tabular"
                  {...register('total', { validate: validAmount })}
                />
              </Field>
              <Field label="Payment method" htmlFor="paymentMethod" error={errors.paymentMethod?.message}>
                <select id="paymentMethod" className="field" {...register('paymentMethod', { required: 'Choose a payment method' })}>
                  <PaymentMethodOptions />
                </select>
              </Field>
              <Field label="Description" htmlFor="description" hint="Optional" className="sm:col-span-2">
                <input id="description" className="field" {...register('description', { maxLength: 500 })} />
              </Field>
            </div>
          </Card>

          <Card>
            <CardHeader
              title="Line items"
              action={
                <Button type="button" onClick={() => append(emptyLine(defaultCategory))}>
                  <Plus className="size-4" aria-hidden />
                  Add line item
                </Button>
              }
            />
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-sm">
                <thead className="text-xs tracking-wide text-muted uppercase">
                  <tr className="border-y border-line">
                    <th scope="col" className="px-4 py-3 text-left font-medium">
                      Description
                    </th>
                    <th scope="col" className="w-[30%] px-4 py-3 text-left font-medium">
                      Category
                    </th>
                    <th scope="col" className="w-36 px-4 py-3 text-right font-medium">
                      Amount (£)
                    </th>
                    <th scope="col" className="w-28 px-4 py-3 text-center font-medium" title="Not allowable for tax, e.g. personal use">
                      Disallowable
                    </th>
                    <th scope="col" className="w-14 px-4 py-3">
                      <span className="sr-only">Delete</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {fields.map((field, index) => {
                    const lineErrors = errors.lineItems?.[index];
                    return (
                      <tr key={field.id} className="align-top">
                        <td className="px-4 py-3">
                          <input
                            aria-label={`Line ${index + 1} description`}
                            className="field"
                            placeholder="What was bought"
                            {...register(`lineItems.${index}.description`, { required: 'Required', maxLength: 500 })}
                          />
                          {lineErrors?.description && <p className="mt-1 text-xs text-out-soft">{lineErrors.description.message}</p>}
                        </td>
                        <td className="px-4 py-3">
                          <select
                            aria-label={`Line ${index + 1} category`}
                            className="field"
                            {...register(`lineItems.${index}.categoryId`, { required: 'Choose a category' })}
                          >
                            <option value="">Choose…</option>
                            <CategoryOptions categories={categories} type="EXPENSE" />
                          </select>
                          {lineErrors?.categoryId && <p className="mt-1 text-xs text-out-soft">{lineErrors.categoryId.message}</p>}
                        </td>
                        <td className="px-4 py-3">
                          <input
                            aria-label={`Line ${index + 1} amount`}
                            inputMode="decimal"
                            placeholder="0.00"
                            className="field tabular text-right"
                            {...register(`lineItems.${index}.amount`, { validate: validAmount })}
                          />
                          {lineErrors?.amount && <p className="mt-1 text-xs text-out-soft">{lineErrors.amount.message}</p>}
                        </td>
                        <td className="px-4 py-3 text-center">
                          <input
                            type="checkbox"
                            aria-label={`Line ${index + 1} disallowable`}
                            className="mt-2.5 size-4 accent-[var(--color-accent)]"
                            {...register(`lineItems.${index}.disallowable`)}
                          />
                        </td>
                        <td className="px-2 py-3 text-center">
                          <IconButton
                            label={`Delete line ${index + 1}`}
                            tone="danger"
                            className="mt-1"
                            disabled={fields.length === 1}
                            onClick={() => remove(index)}
                          >
                            <Trash2 className="size-4" />
                          </IconButton>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t border-line-strong">
                    <td colSpan={2} className="px-4 py-3 text-right text-muted">
                      Line items total
                      {disallowableSum > 0 && <span className="text-faint"> (incl. {formatGBP(disallowableSum)} disallowable)</span>}
                    </td>
                    <td className="tabular px-4 py-3 text-right font-semibold text-ink">{formatGBP(lineSum)}</td>
                    <td colSpan={2} />
                  </tr>
                </tfoot>
              </table>
            </div>
            <div className="border-t border-line px-5 py-4 sm:px-6">
              {matches ? (
                <p className="text-sm text-ok">The line items add up to the transaction amount.</p>
              ) : (
                <div className="flex flex-wrap items-center gap-3">
                  <p className={`text-sm ${isSubmitted ? 'text-out-soft' : 'text-warn'}`}>
                    {totalPence === null || totalPence <= 0
                      ? 'Enter the transaction amount above.'
                      : !linesValid
                        ? 'Enter an amount for every line item.'
                        : `The line items are ${formatGBP(Math.abs(difference!))} ${difference! > 0 ? 'less' : 'more'} than the transaction amount of ${formatGBP(totalPence)}.`}
                  </p>
                  {linesValid && lineSum > 0 && (
                    <Button
                      type="button"
                      variant="ghost"
                      className="px-2 py-1 text-accent-soft"
                      onClick={() => setValue('total', penceToPounds(lineSum), { shouldValidate: isSubmitted })}
                    >
                      Set amount to {formatGBP(lineSum)}
                    </Button>
                  )}
                </div>
              )}
            </div>
          </Card>

          <Card className="p-5 sm:p-6">
            <div className="grid gap-5">
              <Field label="Notes" htmlFor="notes">
                <textarea id="notes" rows={3} className="field" {...register('notes', { maxLength: 2000 })} />
              </Field>
              <Field label="Document">
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
                {id ? 'Save changes' : 'Add outgoing'}
              </Button>
            </div>
          </Card>
        </form>
      </PageBody>
    </>
  );
}
