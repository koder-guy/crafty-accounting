import { useEffect, useRef, useState, type DragEvent, type FormEvent, type ReactNode } from 'react';
import { ImagePlus, LoaderCircle, Trash2 } from 'lucide-react';
import { businessDetailsSchema, formatDisplayDate, type BusinessDetails, type BusinessResponse } from '@crafty/shared';
import { LOGO_ACCEPT, LogoError, prepareLogo } from '../lib/logo';
import { useSaveBusiness } from '../lib/queries';
import { DateInput } from './DateInput';
import { Alert, Button, Field } from './ui';

type Values = Record<keyof BusinessDetails, string>;

const EMPTY: Values = {
  ownerName: '',
  tradingName: '',
  description: '',
  addressLine1: '',
  addressLine2: '',
  town: '',
  county: '',
  postcode: '',
  email: '',
  phone: '',
  website: '',
  startDate: '',
  endDate: '',
  utr: '',
};

const toValues = (details: BusinessDetails | null): Values =>
  details ? (Object.fromEntries(Object.keys(EMPTY).map((k) => [k, details[k as keyof BusinessDetails] ?? ''])) as Values) : EMPTY;

type LogoChange = { kind: 'keep' } | { kind: 'new'; file: File; url: string } | { kind: 'remove' };

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <fieldset className="border-t border-line px-5 py-5 first:border-t-0 sm:px-6">
      <legend className="sr-only">{title}</legend>
      <h3 className="text-sm font-semibold text-white">{title}</h3>
      {description && <p className="mt-0.5 text-xs text-muted">{description}</p>}
      <div className="mt-4 grid gap-4 sm:grid-cols-2">{children}</div>
    </fieldset>
  );
}

/** The logo shown on dark and on white, as it will appear on screen and on paper. */
export function LogoPreview({ url, className = '' }: { url: string; className?: string }) {
  return (
    <div className={`grid grid-cols-2 gap-2 ${className}`}>
      {/* Block tiles with the image filling them (object-contain), not a flex item with max-height: 100%,
          which Safari can ignore, showing the logo at full size over the form. */}
      <div className="h-24 overflow-hidden rounded-lg border border-line bg-page p-3">
        <img src={url} alt="Logo on a dark background" className="block h-full w-full object-contain" />
      </div>
      <div className="h-24 overflow-hidden rounded-lg border border-line bg-white p-3">
        <img src={url} alt="Logo on a white background" className="block h-full w-full object-contain" />
      </div>
    </div>
  );
}

/**
 * The business details, used by Settings → Business Details and the setup screen of a new install.
 * Read-only for viewers. Saving sends the version it started from, so it won't save over someone else's change.
 */
export function BusinessDetailsForm({
  business,
  readOnly = false,
  submitLabel = 'Save',
  onReload,
  extraActions,
}: {
  business: BusinessResponse;
  readOnly?: boolean;
  submitLabel?: string;
  /** Loads the saved version again, after a 409. */
  onReload?: () => void;
  extraActions?: ReactNode;
}) {
  const [values, setValues] = useState<Values>(() => toValues(business.details));
  const [errors, setErrors] = useState<Partial<Record<keyof Values, string>>>({});
  const [logo, setLogo] = useState<LogoChange>({ kind: 'keep' });
  const [preparing, setPreparing] = useState(false);
  const [logoError, setLogoError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [saved, setSaved] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const save = useSaveBusiness();

  useEffect(() => () => {
    if (logo.kind === 'new') URL.revokeObjectURL(logo.url);
  }, [logo]);

  const set = (key: keyof Values) => (value: string) => {
    setValues((v) => ({ ...v, [key]: value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
    setSaved(false);
  };

  const chooseLogo = async (file: File | undefined) => {
    if (!file) return;
    setLogoError(null);
    setPreparing(true);
    try {
      const prepared = await prepareLogo(file);
      setLogo({ kind: 'new', file: prepared, url: URL.createObjectURL(prepared) });
      setSaved(false);
    } catch (err) {
      setLogoError(err instanceof LogoError ? err.message : 'That file couldn’t be used as a logo. Try a PNG, JPEG or PDF.');
    } finally {
      setPreparing(false);
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (!readOnly) void chooseLogo(e.dataTransfer.files[0]);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = businessDetailsSchema.safeParse(values);
    if (!parsed.success) {
      const found: Partial<Record<keyof Values, string>> = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0] as keyof Values;
        found[key] ??= issue.message;
      }
      setErrors(found);
      document.getElementById(`business-${Object.keys(found)[0]}`)?.focus();
      return;
    }
    save.mutate(
      {
        details: parsed.data,
        expectedUpdatedAt: business.updatedAt,
        removeLogo: logo.kind === 'remove',
        logo: logo.kind === 'new' ? logo.file : null,
      },
      {
        onSuccess: (data) => {
          setValues(toValues(data.details));
          setLogo({ kind: 'keep' });
          setSaved(true);
        },
      },
    );
  };

  const text = (key: keyof Values, label: string, options: { hint?: ReactNode; required?: boolean; type?: string; autoComplete?: string; className?: string; mono?: boolean } = {}) => (
    <Field label={`${label}${options.required ? '' : ' (optional)'}`} htmlFor={`business-${key}`} error={errors[key]} hint={options.hint} className={options.className}>
      <input
        id={`business-${key}`}
        type={options.type ?? 'text'}
        className={`field ${options.mono ? 'tabular' : ''}`}
        value={values[key]}
        autoComplete={options.autoComplete ?? 'off'}
        readOnly={readOnly}
        aria-invalid={!!errors[key]}
        onChange={(e) => set(key)(e.target.value)}
      />
    </Field>
  );

  const logoUrl = logo.kind === 'new' ? logo.url : logo.kind === 'remove' ? null : (business.logo?.url ?? null);

  return (
    <form onSubmit={submit} noValidate>
      <Section title="You and your business" description="As a sole trader, the business is you: HMRC knows it by your name.">
        {text('ownerName', 'Your full name', { required: true, autoComplete: 'name' })}
        {text('tradingName', 'Trading name', { hint: 'The name you sell under, if it isn’t your own.', autoComplete: 'organization' })}
        <Field
          label="What the business does"
          htmlFor="business-description"
          error={errors.description}
          hint="A short description, as asked for on your Self Assessment return. For example: handmade jewellery sold at craft fairs."
          className="sm:col-span-2"
        >
          <input
            id="business-description"
            className="field"
            value={values.description}
            readOnly={readOnly}
            aria-invalid={!!errors.description}
            onChange={(e) => set('description')(e.target.value)}
          />
        </Field>
      </Section>

      <Section title="Business address" description="Where the business is run from. For many sole traders that’s home.">
        {text('addressLine1', 'Address line 1', { autoComplete: 'address-line1' })}
        {text('addressLine2', 'Address line 2', { autoComplete: 'address-line2' })}
        {text('town', 'Town or city', { autoComplete: 'address-level2' })}
        {text('county', 'County', { autoComplete: 'address-level1' })}
        {text('postcode', 'Postcode', { required: true, autoComplete: 'postal-code', hint: 'Asked for on your Self Assessment return.' })}
      </Section>

      <Section title="Contact details">
        {text('email', 'Email', { type: 'email', autoComplete: 'email' })}
        {text('phone', 'Phone', { type: 'tel', autoComplete: 'tel' })}
        {text('website', 'Website', { autoComplete: 'url' })}
      </Section>

      <Section title="Dates and tax reference">
        <Field label="Date the business started (optional)" htmlFor="business-startDate" error={errors.startDate} hint="Needed on your return for the year it started.">
          {readOnly ? (
            <input id="business-startDate" className="field" readOnly value={values.startDate ? formatDisplayDate(values.startDate) : ''} />
          ) : (
            <DateInput id="business-startDate" value={values.startDate} onChange={set('startDate')} />
          )}
        </Field>
        <Field label="Date the business stopped (optional)" htmlFor="business-endDate" error={errors.endDate} hint="Only if it has stopped trading.">
          {readOnly ? (
            <input id="business-endDate" className="field" readOnly value={values.endDate ? formatDisplayDate(values.endDate) : ''} />
          ) : (
            <DateInput id="business-endDate" value={values.endDate} onChange={set('endDate')} min={values.startDate || undefined} />
          )}
        </Field>
        {text('utr', 'Unique Taxpayer Reference (UTR)', {
          mono: true,
          hint: 'The 10-digit number on letters from HMRC about Self Assessment.',
        })}
      </Section>

      <fieldset className="border-t border-line px-5 py-5 sm:px-6">
        <legend className="sr-only">Logo</legend>
        <h3 className="text-sm font-semibold text-white">Logo (optional)</h3>
        <p className="mt-0.5 text-xs text-muted">
          A PNG, JPEG, WebP, GIF, SVG or PDF (its first page). It’s trimmed, scaled down and made smaller if needed, and shown on printed reports.
        </p>
        <div
          className={`mt-4 rounded-xl border border-dashed p-4 transition-colors ${dragging ? 'border-accent bg-accent-bg' : 'border-line-strong'}`}
          onDragOver={(e) => {
            if (readOnly) return;
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          {logoUrl ? (
            <LogoPreview url={logoUrl} className="max-w-md" />
          ) : (
            <p className="py-4 text-center text-sm text-muted">{readOnly ? 'No logo.' : 'No logo yet. Choose a file, or drop one here.'}</p>
          )}
          {!readOnly && (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <input
                ref={fileInput}
                type="file"
                accept={LOGO_ACCEPT}
                className="hidden"
                onChange={(e) => {
                  void chooseLogo(e.target.files?.[0]);
                  e.target.value = '';
                }}
              />
              <Button type="button" onClick={() => fileInput.current?.click()} disabled={preparing}>
                {preparing ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : <ImagePlus className="size-4" aria-hidden />}
                {preparing ? 'Preparing logo…' : logoUrl ? 'Replace logo' : 'Choose logo'}
              </Button>
              {logoUrl && (
                <Button
                  type="button"
                  variant="softDanger"
                  onClick={() => {
                    setLogo(business.logo ? { kind: 'remove' } : { kind: 'keep' });
                    setSaved(false);
                  }}
                >
                  <Trash2 className="size-4" aria-hidden />
                  Remove logo
                </Button>
              )}
              {logo.kind !== 'keep' && <span className="text-xs text-muted">Saved when you press {submitLabel}.</span>}
            </div>
          )}
          {logoError && (
            <div className="mt-3">
              <Alert>{logoError}</Alert>
            </div>
          )}
        </div>
      </fieldset>

      {!readOnly && (
        <div className="space-y-3 border-t border-line px-5 py-5 sm:px-6">
          {save.error && (
            <Alert>
              {save.error.message}
              {(save.error as { status?: number }).status === 409 && onReload && (
                <Button type="button" className="mt-2 block" onClick={onReload}>
                  Load their version
                </Button>
              )}
            </Alert>
          )}
          {saved && !save.error && <Alert tone="success">Business details saved.</Alert>}
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" variant="primary" busy={save.isPending} disabled={preparing}>
              {submitLabel}
            </Button>
            {extraActions}
          </div>
        </div>
      )}
    </form>
  );
}
