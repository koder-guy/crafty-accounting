import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Controller, useFieldArray, useForm, useWatch } from 'react-hook-form';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { BadgePercent, ExternalLink, Plus, Split, Trash2 } from 'lucide-react';
import {
  CASH_BASIS_UNUSED_CODE,
  discountProblems,
  formatGBP,
  isPercentage,
  parseDiscountAmount,
  splitDiscount,
  displayTaxYear,
  isNeverAllowable,
  formatDisplayDate,
  invoiceFilename,
  isDateInTaxYear,
  parsePoundsToPence,
  penceToPounds,
  todayIso,
  MAX_DOCUMENTS,
  type ExpenseWithLineItems,
  type InvoiceReading,
  type PaymentMethod,
} from '@crafty/shared';
import { CategoryOptions } from '../components/CategoryOptions';
import { DiscountSummary } from '../components/DiscountSummary';
import { BackLink, ChangedElsewhere, CopiedFrom, dateInYear, duplicateDate, useLeaveGuard, yearRangeHint } from '../components/FormShell';
import { NoTaxYear } from '../components/NoTaxYear';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { DuplicateNotice, nextScanToCheck, scanCheckUrl } from './ScanDocuments';
import { PageBody, PageHeader } from '../components/PageHeader';
import { DateInput } from '../components/DateInput';
import { DocumentField, renamedDocuments, type DocumentRenames, PaymentMethodPicker, tableUrl } from '../components/transactions';
import { SubmittedFiguresNotice } from '../components/SubmittedFiguresNotice';
import { Alert, Button, Card, CardHeader, Field, IconButton, Spinner } from '../components/ui';
import { ApiError, transactionForm } from '../lib/api';
import { openDocumentWindow } from '../lib/documentWindow';
import { scanFileUrl, useActiveTaxYear, useCategories, useExpense, useAi, useSaveTransaction, useScanMutations, useScans, useTaxYears } from '../lib/queries';

interface LineValues {
  /** Database id for existing line items; useFieldArray reserves "id". */
  lineId?: number;
  description: string;
  amount: string;
  categoryId: string;
  disallowable: boolean;
  /** A discount or promotion: `amount` is what's taken off, as an amount or a percentage ("10%"), saved as a minus amount. */
  discount: boolean;
}

interface Values {
  date: string;
  payee: string;
  invoiceNumber: string;
  orderNumber: string;
  paymentMethod: PaymentMethod | '';
  notes: string;
  lineItems: LineValues[];
}

const emptyLine = (categoryId = ''): LineValues => ({ description: '', amount: '', categoryId, disallowable: false, discount: false });

/** A saved or read line as the form holds it: discounts show what's taken off. */
const lineValues = (li: { amountPence: number; categoryId: number | null; description: string; disallowable?: boolean }): LineValues => ({
  description: li.description,
  amount: penceToPounds(Math.abs(li.amountPence)),
  categoryId: li.categoryId === null ? '' : String(li.categoryId),
  disallowable: li.disallowable ?? false,
  discount: li.amountPence < 0,
});

const validAmount = (v: string) => {
  const pence = parsePoundsToPence(v);
  return (pence !== null && pence > 0) || 'Enter an amount above £0.00';
};

interface PricedLine {
  description: string;
  categoryId: string;
  discount: boolean;
  /** As it will be saved: always for entertainment and depreciation, and a discount's follows its category's items. */
  disallowable: boolean;
  /** A discount whose category has both allowable and disallowable items, so it's chosen. */
  choosable: boolean;
  /** Signed: a discount is minus. Null when the amount isn't valid. */
  pence: number | null;
}

/**
 * Each line's amount in pence and how it will be saved. A discount given as a percentage is worked out
 * from the items in its category (allowable or not, like it), to the nearest penny.
 */
function pricedLines(lines: (LineValues | undefined)[], neverAllowable: (categoryId: string | undefined) => boolean): PricedLine[] {
  const itemDisallowable = (l: LineValues) => !!l.disallowable || neverAllowable(l.categoryId);
  const items = lines.filter((l): l is LineValues => !!l && !l.discount);
  const itemPence = (l: LineValues) => {
    const pence = parsePoundsToPence(l.amount ?? '');
    return pence !== null && pence > 0 ? pence : null;
  };
  return lines.map((l) => {
    if (!l) return { description: '', categoryId: '', discount: false, disallowable: false, choosable: false, pence: null };
    const base = { description: l.description ?? '', categoryId: l.categoryId ?? '' };
    if (!l.discount) return { ...base, discount: false, disallowable: itemDisallowable(l), choosable: false, pence: itemPence(l) };
    const kinds = new Set(items.filter((i) => i.categoryId === l.categoryId).map(itemDisallowable));
    const choosable = kinds.size > 1 && !neverAllowable(l.categoryId);
    const disallowable = neverAllowable(l.categoryId) || (kinds.size === 1 ? [...kinds][0]! : !!l.disallowable);
    const cost = items
      .filter((i) => i.categoryId === l.categoryId && itemDisallowable(i) === disallowable)
      .reduce((acc, i) => acc + (itemPence(i) ?? 0), 0);
    const off = parseDiscountAmount(l.amount ?? '', cost);
    return { ...base, discount: true, disallowable, choosable, pence: off === null ? null : -off };
  });
}

// Whether it can be read; a percentage of what its items cost is checked when saving.
const validDiscount = (v: string) =>
  parseDiscountAmount(v, isPercentage(v) ? 100_000_000 : 0) !== null || 'Enter an amount above £0.00, or a percentage such as 10%';

/** Checking scanned documents moves from one to the next on this page, so each starts afresh. */
export function ExpenseForm() {
  const [searchParams] = useSearchParams();
  return <ExpenseFormPage key={searchParams.get('scan') ?? ''} />;
}

function ExpenseFormPage() {
  const params = useParams();
  const id = params.id ? Number(params.id) : null;
  const navigate = useNavigate();
  const { data: existing, isLoading: loadingExisting, error: loadError, refetch: refetchExisting } = useExpense(id);
  // Duplicating: /expenses/new?copy=<id> fills the new form from that transaction.
  const [searchParams] = useSearchParams();
  const copyId = id ? null : Number(searchParams.get('copy')) || null;
  const { data: original, isLoading: loadingOriginal, error: originalError } = useExpense(copyId);
  // Checking a scanned document: /expenses/new?scan=<id> fills the new form from what the AI read.
  const scanId = id || copyId ? null : Number(searchParams.get('scan')) || null;
  const { data: scanList, isLoading: loadingScans, error: scansError } = useScans(scanId !== null);
  const scan = scanList?.scans.find((s) => s.id === scanId) ?? null;
  const scanChecked = scan?.status === 'ready' || scan?.status === 'failed';
  const nextScan = scanList && scanId ? nextScanToCheck(scanList.scans, scanId) : null;
  const scanMutations = useScanMutations();
  const qc = useQueryClient();
  const [scanFile, setScanFile] = useState<File | null>(null);
  const [scanFileError, setScanFileError] = useState<string | null>(null);
  const [confirmSkip, setConfirmSkip] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const { data: years } = useTaxYears();
  const { taxYear: activeYear, isLoading: yearLoading } = useActiveTaxYear();
  const { data: categories = [], isLoading: loadingCategories, error: categoriesError } = useCategories();
  const expenseCategories = categories.filter((c) => c.type === 'EXPENSE');
  // Depreciation isn't offered, but a line already using it (or a custom category mapped to it) keeps it.
  const lineCategories = (current: string | undefined) => {
    const usesIt = categories.some((c) => String(c.id) === current && c.hmrcCode === CASH_BASIS_UNUSED_CODE);
    return usesIt ? categories : categories.filter((c) => c.hmrcCode !== CASH_BASIS_UNUSED_CODE);
  };
  const neverAllowable = (categoryId: string | undefined) =>
    expenseCategories.some((c) => String(c.id) === categoryId && isNeverAllowable(c.hmrcCode));
  const defaultCategory = String(expenseCategories.find((c) => !c.isCustom && c.hmrcCode === 'costOfGoods')?.id ?? '');
  const save = useSaveTransaction<ExpenseWithLineItems>('expenses');

  // A scanned document goes into the year its date falls in, whichever year is active.
  const scanDate = scan?.reading?.date ?? null;
  const scanYear = scanDate ? (years?.taxYears.find((y) => isDateInTaxYear(scanDate, y)) ?? null) : null;
  const taxYear = id ? (years?.taxYears.find((y) => y.id === existing?.taxYearId) ?? null) : (scanYear ?? activeYear);

  // New documents to add, and attached ones to remove, when the form is saved.
  const [files, setFiles] = useState<File[]>([]);
  const [removeIds, setRemoveIds] = useState<number[]>([]);
  const [renames, setRenames] = useState<DocumentRenames>({});
  const [preparingPhoto, setPreparingPhoto] = useState(false);
  const [badDocumentNames, setBadDocumentNames] = useState(false);
  const { data: ai } = useAi();
  // The scanned document, attached with the expense.
  const readFile = useRef<File | null>(null);

  // The scanned file, to attach as if it had been chosen here.
  useEffect(() => {
    if (!scan || !scanChecked || scanFile) return;
    let cancelled = false;
    fetch(scanFileUrl(scan.id), { credentials: 'same-origin' })
      .then((res) => {
        if (!res.ok) throw new Error(res.status === 404 ? 'The scanned file is missing from storage.' : `The scanned file couldn't be loaded (${res.status}).`);
        return res.blob();
      })
      .then((blob) => !cancelled && setScanFile(new File([blob], scan.originalName, { type: blob.type })))
      .catch((err: Error) => !cancelled && setScanFileError(err.message));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scan?.id, scanChecked]);

  const {
    register,
    control,
    handleSubmit,
    reset,
    getValues,
    setError,
    formState: { errors, isDirty },
  } = useForm<Values>({
    defaultValues: {
      date: '',
      payee: '',
      invoiceNumber: '',
      orderNumber: '',
      paymentMethod: '',
      notes: '',
      lineItems: [emptyLine()],
    },
  });
  const { fields, append, remove, insert } = useFieldArray({ control, name: 'lineItems' });

  // The version of the record the form was filled from; saving is refused if it has changed since.
  const [loaded, setLoaded] = useState<ExpenseWithLineItems | null>(null);
  const filledFor = useRef<string | null>(null);
  const fillFrom = (record: ExpenseWithLineItems) => {
    reset({
      date: record.date,
      payee: record.payee,
      invoiceNumber: record.invoiceNumber ?? '',
      orderNumber: record.orderNumber ?? '',
      paymentMethod: record.paymentMethod,
      notes: record.notes ?? '',
      lineItems: record.lineItems.map((li) => ({ ...lineValues(li), lineId: li.id })),
    });
    setLoaded(record);
    setRemoveIds([]);
    setRenames({});
  };

  // Fill the form once: live updates refetch the data, and that mustn't wipe what you've typed.
  useEffect(() => {
    const key = id ? `edit-${id}` : scanId ? `scan-${scanId}` : `new-${activeYear?.id}-${copyId}`;
    if (filledFor.current === key) return;
    if (scanId) {
      if (!scan || !scanFile || !taxYear || !expenseCategories.length) return;
      filledFor.current = key;
      reset({ date: '', payee: '', invoiceNumber: '', orderNumber: '', paymentMethod: '', notes: '', lineItems: [emptyLine(defaultCategory)] });
      if (scan.reading) fillFromInvoice(scan.reading, scanFile);
      else {
        readFile.current = scanFile;
        setFiles([scanFile]);
      }
      return;
    }
    // Wait for the categories every time, or the category menus can't show the choices.
    if (id && existing && expenseCategories.length) {
      filledFor.current = key;
      fillFrom(existing);
    } else if (copyId && original && activeYear && expenseCategories.length) {
      // Invoice and order numbers and the document belong to the original, so they aren't copied.
      filledFor.current = key;
      reset({
        date: duplicateDate(original.date, activeYear),
        payee: original.payee,
        invoiceNumber: '',
        orderNumber: '',
        paymentMethod: original.paymentMethod,
        notes: original.notes ?? '',
        lineItems: original.lineItems.map(lineValues),
      });
    } else if (!id && !copyId && activeYear && expenseCategories.length) {
      filledFor.current = key;
      const today = todayIso();
      reset({
        date: isDateInTaxYear(today, activeYear) ? today : '',
        payee: '',
        invoiceNumber: '',
        orderNumber: '',
        paymentMethod: '',
        notes: '',
        lineItems: [emptyLine(defaultCategory)],
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, existing, copyId, original, activeYear?.id, expenseCategories.length, scan?.id, scanFile, taxYear?.id]);

  // Fills the form from what the AI read from a scanned document. The reading becomes what the form was loaded with,
  // as the document stays to be checked if you leave, so only changes made here count.
  const fillFromInvoice = (reading: InvoiceReading, picked: File) => {
    const current = getValues();
    // Named by the pattern in Settings → AI Document Scanning, from what was read.
    const amountPence = reading.totalPence ?? (reading.lineItems.reduce((sum, li) => sum + li.amountPence, 0) || null);
    const largest = reading.lineItems.reduce<(typeof reading.lineItems)[number] | null>((a, b) => (a && a.amountPence >= b.amountPence ? a : b), null);
    const extension = /\.[^.]+$/.exec(picked.name)?.[0] ?? '';
    const name = invoiceFilename(
      {
        date: reading.date,
        payee: reading.payee,
        invoiceNumber: reading.invoiceNumber,
        orderNumber: reading.orderNumber,
        amountPence,
        paymentMethod: reading.paymentMethod,
        category: categories.find((c) => c.id === largest?.categoryId)?.name ?? null,
        description: reading.lineItems[0]?.description ?? null,
      },
      extension,
      ai?.filenamePattern,
    );
    const file = name ? new File([picked], name, { type: picked.type, lastModified: picked.lastModified }) : picked;
    reset({
      ...current,
      date: reading.date ?? current.date,
      payee: reading.payee || current.payee,
      invoiceNumber: reading.invoiceNumber,
      orderNumber: reading.orderNumber,
      paymentMethod: reading.paymentMethod ?? '',
      lineItems: reading.lineItems.length ? reading.lineItems.map(lineValues) : current.lineItems,
    });
    setFiles((prev) => {
      const others = prev.filter((f) => f !== readFile.current);
      if (others.length >= MAX_DOCUMENTS || others.some((f) => f.name === file.name)) return others;
      readFile.current = file;
      return [...others, file];
    });
  };

  const watchedLines = useWatch({ control, name: 'lineItems' });
  const watchedDate = useWatch({ control, name: 'date' });
  const priced = pricedLines(watchedLines ?? [], neverAllowable);
  const linePence = priced.map((l) => l.pence);
  const lineSum = linePence.reduce<number>((acc, p) => acc + (p ?? 0), 0);
  const disallowableSum = priced.reduce((acc, l) => acc + (l.disallowable ? (l.pence ?? 0) : 0), 0);
  const categoryName = (categoryId: number) => categories.find((c) => c.id === categoryId)?.name ?? 'that category';
  // The lines that can be checked: an amount and a category each.
  const complete = priced.flatMap((l, index) =>
    l.pence !== null && l.categoryId ? [{ index, amountPence: l.pence, categoryId: Number(l.categoryId), disallowable: l.disallowable, description: l.description }] : [],
  );
  const hasDiscounts = priced.some((l) => l.discount);
  const lineProblems = hasDiscounts
    ? discountProblems(complete, categoryName).map((p) => ({ ...p, index: p.index === null ? null : complete[p.index]!.index }))
    : [];
  // The categories a discount can be taken off: those the items use.
  const itemCategories = [...new Set(priced.filter((l) => !l.discount && l.categoryId).map((l) => l.categoryId))];
  const discountCategories = (current: string | undefined) =>
    expenseCategories.filter((c) => itemCategories.includes(String(c.id)) || String(c.id) === current);
  const itemGroups = new Set(priced.filter((l) => !l.discount && l.categoryId).map((l) => `${l.categoryId}:${l.disallowable}`));

  /** Replaces a discount on several categories with one per category, in proportion to what their items cost. */
  const splitAt = (index: number) => {
    const line = getValues(`lineItems.${index}`);
    const pence = priced[index]?.pence;
    if (pence === null || pence === undefined) return;
    // In proportion to what each category has left after its other discounts, so a free delivery isn't taken off again.
    const left = complete.filter((l) => l.index !== index).map((l) => ({ ...l }));
    for (const off of left.filter((l) => l.amountPence < 0)) {
      for (const item of left.filter((l) => l.amountPence > 0 && l.categoryId === off.categoryId && l.disallowable === off.disallowable)) {
        const taken = Math.min(item.amountPence, -off.amountPence);
        item.amountPence -= taken;
        off.amountPence += taken;
      }
    }
    const shares = splitDiscount(left.filter((l) => l.amountPence > 0), -pence);
    if (shares.length === 0) return;
    remove(index);
    insert(
      index,
      shares.map((share) => ({
        description: line.description,
        amount: penceToPounds(share.amountPence),
        categoryId: String(share.categoryId),
        disallowable: share.disallowable,
        discount: true,
      })),
    );
  };

  const onSubmit = handleSubmit((values) => {
    if (!taxYear) return;
    const lines = pricedLines(values.lineItems, neverAllowable);
    const unpriced = lines.findIndex((l) => l.pence === null);
    if (unpriced >= 0) {
      setError(`lineItems.${unpriced}.amount`, { message: 'Its items cost nothing yet, so there is nothing to take a percentage of' });
      return;
    }
    const problems = discountProblems(
      lines.map((l) => ({ amountPence: l.pence ?? 0, categoryId: Number(l.categoryId), disallowable: l.disallowable })),
      categoryName,
    );
    if (problems.length) {
      setError('root.lines', { message: problems[0]!.message });
      return;
    }
    const payload = {
      taxYearId: taxYear.id,
      date: values.date,
      payee: values.payee,
      invoiceNumber: values.invoiceNumber,
      orderNumber: values.orderNumber,
      paymentMethod: values.paymentMethod,
      notes: values.notes,
      removeDocumentIds: removeIds,
      renameDocuments: renamedDocuments(existing?.documents ?? [], renames),
      expectedUpdatedAt: id ? loaded?.updatedAt : undefined,
      scanId: scanId ?? undefined,
      lineItems: values.lineItems.map((li, i) => ({
        id: li.lineId,
        description: li.description,
        amountPence: lines[i]!.pence,
        categoryId: Number(li.categoryId),
        disallowable: lines[i]!.disallowable,
      })),
    };
    save.mutate(
      { id: id ?? undefined, form: transactionForm(payload, files) },
      {
        onSuccess: () => {
          if (scanId) qc.invalidateQueries({ queryKey: ['scans'] });
          leave(scanId ? afterScan : tableUrl('/expenses'));
        },
        onError: (err) => {
          // Someone else saved first: fetch their version so the form can offer it.
          if (err instanceof ApiError && err.status === 409) refetchExisting();
          if (err instanceof ApiError && err.details?.some((d) => d.path === 'date')) {
            setError('date', { message: err.message });
          }
          // A discount the server refused: shown on its line.
          for (const detail of err instanceof ApiError ? (err.details ?? []) : []) {
            const line = /^lineItems\.(\d+)\.amountPence$/.exec(detail.path);
            if (line) setError(`lineItems.${Number(line[1])}.amount`, { message: detail.message });
          }
        },
      },
    );
  });

  const title = id ? 'Edit expense' : copyId ? 'Duplicate expense' : scanId ? 'Check scanned document' : 'Add expense';
  const backTo = id ? `/expenses/${id}` : copyId ? `/expenses/${copyId}` : scanId ? '/expenses/scans' : tableUrl('/expenses');
  // Where checking goes after this document: the next one to check, else back to the list.
  const afterScan = nextScan ? scanCheckUrl(nextScan.id) : '/expenses/scans';
  // The scanned file is attached from the start, so it isn't a change made here.
  const addedFiles = scanId ? files.filter((f) => f !== readFile.current) : files;
  const formDirty = isDirty || addedFiles.length > 0;
  const { guard, leave } = useLeaveGuard({
    dirty: isDirty || addedFiles.length > 0 || removeIds.length > 0 || renamedDocuments(existing?.documents ?? [], renames).length > 0,
    busy: save.isPending || preparingPhoto,
    onCancel: () => navigate(backTo),
  });

  if (yearLoading || loadingCategories || (id && loadingExisting) || (copyId && loadingOriginal) || (scanId && loadingScans)) {
    return (
      <>
        <PageHeader title={title} />
        <Spinner />
      </>
    );
  }
  if (loadError || originalError || categoriesError || scansError) {
    return (
      <>
        <PageHeader title={title} />
        <PageBody>
          <Alert>{(loadError ?? originalError ?? categoriesError ?? scansError)!.message}</Alert>
        </PageBody>
      </>
    );
  }
  if (scanId && (!scan || !scanChecked || scanFileError || !scanFile)) {
    return (
      <>
        <PageHeader title={title} />
        <PageBody>
          <BackLink to="/expenses/scans" escape={false}>Scanned documents</BackLink>
          {!scan ? (
            <Alert tone="info">This document has already been saved or discarded, perhaps in another window.</Alert>
          ) : scanFileError ? (
            <Alert>{scanFileError}</Alert>
          ) : (
            <Spinner label={scanChecked ? 'Loading…' : 'This document is still being read…'} />
          )}
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
            ? `${existing.payee} · ${formatDisplayDate(existing.date)}`
            : original
              ? `Copy of ${original.payee}`
              : scan && scanList
                ? `${scan.originalName} · in tax year ${displayTaxYear(taxYear.label)}`
                : `In tax year ${displayTaxYear(taxYear.label)}`
        }
      />
      <PageBody>
        <BackLink to={backTo} escape={false}>Back</BackLink>
        {guard}
        {original && (
          <div className="max-w-[876px]">
            <CopiedFrom
              what={original.payee}
              date={original.date}
              notCopied="The invoice and order numbers and any attached document aren't copied."
            />
          </div>
        )}
        {existing && loaded && existing.updatedAt !== loaded.updatedAt && (
          <div className="max-w-[876px]">
            <ChangedElsewhere
              by={existing.updatedBy}
              onLoad={() => {
                fillFrom(existing);
                save.reset();
              }}
            />
          </div>
        )}
        <form onSubmit={onSubmit} noValidate className="max-w-[876px] space-y-6">
          {scan && (
            <Card className="p-4 sm:p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold text-ink">Approval decision</h2>
                  <p className="mt-0.5 text-sm text-muted">{scanProgress(scanList!.scans.filter((s) => s.id !== scan.id).length)}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button type="button" variant="softDanger" onClick={() => setConfirmDiscard(true)}>
                    <Trash2 className="size-4" aria-hidden />
                    Discard document
                  </Button>
                  {nextScan ? (
                    <Button type="button" variant="secondary" onClick={() => (formDirty ? setConfirmSkip(true) : leave(afterScan))}>
                      Skip for now
                    </Button>
                  ) : (
                    <Button type="button" variant="secondary" onClick={() => navigate(backTo)}>
                      Cancel
                    </Button>
                  )}
                  <Button type="button" onClick={() => openDocumentWindow(scanFileUrl(scan.id))}>
                    <ExternalLink className="size-4" aria-hidden />
                    Open document
                  </Button>
                  <Button type="submit" variant="primary" busy={save.isPending || preparingPhoto} disabled={badDocumentNames}>
                    {nextScan ? 'Add and check next' : 'Add expense'}
                  </Button>
                </div>
              </div>
              <DuplicateNotice duplicates={scan.duplicates} />
              <ScanProblems reading={scan.reading} error={scan.error} />
              {save.error && (
                <div className="mt-4">
                  <Alert>{save.error.message}</Alert>
                </div>
              )}
            </Card>
          )}
          <Card className="p-5 sm:p-6">
            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="Date" htmlFor="date" error={errors.date?.message} hint={yearRangeHint(taxYear)}>
                <Controller
                  control={control}
                  name="date"
                  rules={{ validate: dateInYear(taxYear) }}
                  render={({ field }) => (
                    <DateInput id="date" min={taxYear.startDate} max={taxYear.endDate} value={field.value} onChange={field.onChange} onBlur={field.onBlur} ref={field.ref} />
                  )}
                />
              </Field>
              <Field label="Payee" htmlFor="payee" error={errors.payee?.message}>
                <input
                  id="payee"
                  className="field"
                  placeholder="Acme Supplies Ltd"
                  {...register('payee', { required: 'Payee is required', maxLength: 200 })}
                />
              </Field>
              <Field label="Invoice number" htmlFor="invoiceNumber" hint="Optional">
                <input id="invoiceNumber" className="field" {...register('invoiceNumber', { maxLength: 100 })} />
              </Field>
              <Field label="Order number" htmlFor="orderNumber" hint="Optional">
                <input id="orderNumber" className="field" {...register('orderNumber', { maxLength: 100 })} />
              </Field>
              <Field label="Payment method" htmlFor="paymentMethod" error={errors.paymentMethod?.message}>
                <Controller
                  control={control}
                  name="paymentMethod"
                  rules={{ required: 'Choose a payment method' }}
                  render={({ field }) => (
                    <PaymentMethodPicker
                      id="paymentMethod"
                      value={field.value}
                      onChange={field.onChange}
                      onBlur={field.onBlur}
                      ref={field.ref}
                      invalid={!!errors.paymentMethod}
                    />
                  )}
                />
              </Field>
            </div>
          </Card>

          <Card>
            <CardHeader
              title="Line items"
              action={
                <div className="flex flex-wrap gap-2">
                  <Button type="button" onClick={() => append(emptyLine(defaultCategory))}>
                    <Plus className="size-4" aria-hidden />
                    Add line item
                  </Button>
                  <Button
                    type="button"
                    onClick={() =>
                      append({ ...emptyLine(itemCategories[0] ?? ''), discount: true }, { focusName: `lineItems.${fields.length}.description` })
                    }
                  >
                    <BadgePercent className="size-4" aria-hidden />
                    Add discount
                  </Button>
                </div>
              }
            />
            {/* relative: keeps the table's hidden Delete label inside the scroll area, or the page scrolls sideways. */}
            <div className="relative overflow-x-auto">
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
                    <th scope="col" className="w-20 px-4 py-3">
                      <span className="sr-only">Delete</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {fields.map((field, index) => {
                    const lineErrors = errors.lineItems?.[index];
                    // Whether it's a discount comes from the field, which has it from the start: the watched values
                    // catch up a render later, and switching row kinds then would lose the category chosen for it.
                    if (field.discount) {
                      const line = priced[index] ?? { discount: true, disallowable: false, choosable: false, pence: null };
                      const problem = lineProblems.find((p) => p.index === index)?.message;
                      const splittable = itemGroups.size > 1 && line.pence !== null;
                      return (
                        <tr key={field.id} className="align-top bg-ok/5">
                          <td className="px-4 py-3">
                            <input
                              aria-label={`Line ${index + 1} discount description`}
                              className="field"
                              placeholder="Promotion or discount"
                              {...register(`lineItems.${index}.description`, { required: 'Required', maxLength: 500 })}
                            />
                            {lineErrors?.description && <p className="mt-1 text-xs text-out-soft">{lineErrors.description.message}</p>}
                          </td>
                          <td className="px-4 py-3">
                            <select
                              aria-label={`Line ${index + 1} discount category`}
                              title="The category it's taken off: one the items use"
                              className="field"
                              {...register(`lineItems.${index}.categoryId`, { required: 'Choose a category' })}
                            >
                              <option value="">Choose…</option>
                              <CategoryOptions categories={discountCategories(watchedLines?.[index]?.categoryId)} type="EXPENSE" />
                            </select>
                            {lineErrors?.categoryId && <p className="mt-1 text-xs text-out-soft">{lineErrors.categoryId.message}</p>}
                          </td>
                          <td className="px-4 py-3">
                            <div className="relative">
                              <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ok" aria-hidden>
                                −
                              </span>
                              <input
                                aria-label={`Line ${index + 1} discount amount or percentage`}
                                inputMode="decimal"
                                placeholder="0.00 or 10%"
                                className="field tabular pl-6 text-right text-ok"
                                {...register(`lineItems.${index}.amount`, { validate: validDiscount })}
                              />
                            </div>
                            {lineErrors?.amount ? (
                              <p className="mt-1 text-xs text-out-soft">{lineErrors.amount.message}</p>
                            ) : problem ? (
                              <p className="mt-1 text-xs text-out-soft">{problem}</p>
                            ) : (
                              isPercentage(watchedLines?.[index]?.amount ?? '') &&
                              line.pence !== null && <p className="tabular mt-1 text-right text-xs text-muted">= −{formatGBP(-line.pence)}</p>
                            )}
                          </td>
                          <td className="px-4 py-3 text-center">
                            {line.choosable ? (
                              <input
                                key="chosen"
                                type="checkbox"
                                aria-label={`Line ${index + 1} disallowable`}
                                title="Take it off the disallowable items in this category"
                                className="mt-2.5 size-4 accent-[var(--color-accent)]"
                                {...register(`lineItems.${index}.disallowable`)}
                              />
                            ) : (
                              <input
                                key="follows"
                                type="checkbox"
                                aria-label={`Line ${index + 1} disallowable`}
                                title="Follows the items in its category"
                                className="mt-2.5 size-4 accent-[var(--color-accent)]"
                                checked={line.disallowable}
                                disabled
                                readOnly
                              />
                            )}
                          </td>
                          <td className="px-2 py-3">
                            <div className="flex items-center justify-center gap-1">
                              {splittable && (
                                <IconButton
                                  label={`Split discount ${index + 1} across the items' categories`}
                                  title="Split across the items' categories, in proportion to what they cost"
                                  className="mt-1"
                                  onClick={() => splitAt(index)}
                                >
                                  <Split className="size-4" />
                                </IconButton>
                              )}
                              <IconButton label={`Delete line ${index + 1}`} tone="danger" className="mt-1" onClick={() => remove(index)}>
                                <Trash2 className="size-4" />
                              </IconButton>
                            </div>
                          </td>
                        </tr>
                      );
                    }
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
                            <CategoryOptions categories={lineCategories(watchedLines?.[index]?.categoryId)} type="EXPENSE" />
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
                          {neverAllowable(watchedLines?.[index]?.categoryId) ? (
                            <input
                              key="never"
                              type="checkbox"
                              aria-label={`Line ${index + 1} disallowable`}
                              title="HMRC never allows this category"
                              className="mt-2.5 size-4 accent-[var(--color-accent)]"
                              checked
                              disabled
                              readOnly
                            />
                          ) : (
                            <input
                              key="chosen"
                              type="checkbox"
                              aria-label={`Line ${index + 1} disallowable`}
                              className="mt-2.5 size-4 accent-[var(--color-accent)]"
                              {...register(`lineItems.${index}.disallowable`)}
                            />
                          )}
                        </td>
                        <td className="px-2 py-3 text-center">
                          <IconButton
                            label={`Delete line ${index + 1}`}
                            tone="danger"
                            className="mt-1"
                            disabled={priced.filter((l) => !l.discount).length === 1}
                            onClick={() => remove(index)}
                          >
                            <Trash2 className="size-4" />
                          </IconButton>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-baseline justify-end gap-x-3 border-t border-line-strong px-5 py-4 text-sm sm:px-6">
              <p className="text-muted">
                Transaction total
                {disallowableSum > 0 && <span className="text-faint"> (incl. {formatGBP(disallowableSum)} disallowable)</span>}
              </p>
              <p className="tabular font-semibold text-ink">{formatGBP(lineSum)}</p>
            </div>
            {(errors.root?.lines || lineProblems.some((p) => p.index === null)) && (
              <div className="px-5 pb-4 sm:px-6">
                <Alert>{lineProblems.find((p) => p.index === null)?.message ?? errors.root?.lines?.message}</Alert>
              </div>
            )}
            <DiscountSummary
              className="border-t border-line px-5 py-4 sm:px-6"
              lines={complete}
              categoryName={categoryName}
            />
          </Card>

          <Card className="p-5 sm:p-6">
            <div className="grid gap-5">
              <Field label="Notes" htmlFor="notes">
                <textarea id="notes" rows={3} className="field" {...register('notes', { maxLength: 2000 })} />
              </Field>
              <Field label="Documents">
                <DocumentField
                  current={existing?.documents ?? []}
                  files={files}
                  removeIds={removeIds}
                  renames={renames}
                  onFiles={setFiles}
                  onRemoveIds={setRemoveIds}
                  onRenames={setRenames}
                  onPreparing={setPreparingPhoto}
                  onBadNames={setBadDocumentNames}
                />
              </Field>
            </div>

            <SubmittedFiguresNotice className="mt-5" taxYearId={taxYear.id} dates={[watchedDate, existing?.date]} />

            {/* Checking a scanned document, the buttons are at the top, so moving on needs no scrolling. */}
            {!scanId && (
              <>
                {save.error && (
                  <div className="mt-5">
                    <Alert>{save.error.message}</Alert>
                  </div>
                )}
                <div className="mt-6 flex flex-wrap justify-end gap-3 border-t border-line pt-5">
                  <Button type="button" variant="ghost" onClick={() => navigate(backTo)}>
                    Cancel
                  </Button>
                  <Button type="submit" variant="primary" busy={save.isPending || preparingPhoto} disabled={badDocumentNames}>
                    {id ? 'Save changes' : 'Add expense'}
                  </Button>
                </div>
              </>
            )}
          </Card>
        </form>
        {scanId && (
          <>
            <ConfirmDialog
              open={confirmSkip}
              title="Discard your changes?"
              confirmLabel="Discard changes"
              cancelLabel="Keep editing"
              onConfirm={() => leave(afterScan)}
              onClose={() => setConfirmSkip(false)}
            >
              <p>The changes you made here aren't saved. The document stays to be checked later, as it was read.</p>
            </ConfirmDialog>
            <ConfirmDialog
              open={confirmDiscard}
              title="Discard this document?"
              confirmLabel="Discard"
              onConfirm={async () => {
                await scanMutations.discard.mutateAsync(scanId);
                leave(afterScan);
              }}
              onClose={() => setConfirmDiscard(false)}
            >
              <p>{scan?.originalName} is removed from the documents to check, and its file is deleted. Nothing is added to the books.</p>
            </ConfirmDialog>
          </>
        )}
      </PageBody>
    </>
  );
}

const scanProgress = (left: number) => (left === 0 ? 'The last document to check' : `${left} more to check after this one`);

/** Under the buttons while checking a scanned document: only what the AI flagged, or why it couldn't be read. */
function ScanProblems({ reading, error }: { reading: InvoiceReading | null; error: string | null }) {
  if (reading && !reading.warnings.length) return null;
  return (
    <div className="mt-4">
      <Alert tone={reading ? 'warning' : 'error'}>
        {reading ? (
          <ul className="list-disc pl-5">
            {reading.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        ) : (
          <p>{error ?? "This document couldn't be read, so fill it in yourself."}</p>
        )}
      </Alert>
    </div>
  );
}
