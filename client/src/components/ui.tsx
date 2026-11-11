import { useState, type ButtonHTMLAttributes, type ReactNode, type Ref } from 'react';
import { Link, type LinkProps } from 'react-router';
import { CircleCheck, Info, LoaderCircle, TriangleAlert, X } from 'lucide-react';
import { PAYMENT_METHOD_LABELS, type PaymentMethod } from '@crafty/shared';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'softDanger';

/** Red text on a very light red background with a faint red border: Delete and Remove buttons that open a confirmation or can be undone. */
export const SOFT_DANGER =
  'border border-out/40 bg-out-bg text-out-soft hover:border-out/70 hover:bg-out/20 hover:text-red-300';

const variants: Record<Variant, string> = {
  primary: 'bg-accent text-white hover:bg-accent-strong border border-accent',
  secondary: 'bg-surface-2 text-ink border border-line-strong hover:border-accent-soft/60 hover:text-white',
  ghost: 'text-muted hover:text-ink hover:bg-surface-2 border border-transparent',
  danger: 'bg-out text-white hover:bg-red-700 border border-out',
  softDanger: SOFT_DANGER,
};

const base =
  'inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 whitespace-nowrap';

export function Button({
  variant = 'secondary',
  busy,
  className = '',
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; busy?: boolean }) {
  return (
    <button {...props} disabled={props.disabled || busy} className={`${base} ${variants[variant]} ${className}`}>
      {busy && <LoaderCircle className="size-4 animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

/** A button's classes, for elements that can't be a Button or ButtonLink, such as a download link. */
export const buttonClasses = (variant: Variant = 'secondary') => `${base} ${variants[variant]}`;

export function ButtonLink({ variant = 'secondary', className = '', ...props }: LinkProps & { variant?: Variant }) {
  return <Link {...props} className={`${base} ${variants[variant]} ${className}`} />;
}

export function IconButton({
  label,
  tone = 'default',
  className = '',
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; tone?: 'default' | 'danger' }) {
  const toneClass =
    tone === 'danger' ? 'text-out-soft hover:text-red-300 hover:bg-out-bg' : 'text-muted hover:text-accent-soft hover:bg-accent-bg';
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      {...props}
      className={`inline-flex size-8 items-center justify-center rounded-md transition-colors disabled:pointer-events-none disabled:opacity-40 ${toneClass} ${className}`}
    >
      {children}
    </button>
  );
}

export function Card({ className = '', ref, children }: { className?: string; ref?: Ref<HTMLElement>; children: ReactNode }) {
  return (
    <section ref={ref} className={`card ${className}`}>
      {children}
    </section>
  );
}

export function CardHeader({
  icon,
  title,
  tools,
  action,
}: {
  icon?: ReactNode;
  title: ReactNode;
  /** Buttons beside the title, after a divider. */
  tools?: ReactNode;
  action?: ReactNode;
}) {
  const heading = (
    <h2 className="flex items-center gap-2.5 text-base font-semibold text-ink">
      {icon}
      {title}
    </h2>
  );
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 px-5 pt-5 pb-4 sm:px-6">
      {tools ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {heading}
          <span className="hidden h-6 w-px bg-line-strong sm:block" aria-hidden />
          <div className="flex items-center gap-2 print:hidden">{tools}</div>
        </div>
      ) : (
        heading
      )}
      {action}
    </div>
  );
}

export function Field({
  label,
  htmlFor,
  error,
  hint,
  className = '',
  children,
}: {
  label: string;
  htmlFor?: string;
  error?: string;
  hint?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={className}>
      <label htmlFor={htmlFor} className="mb-1.5 block text-sm font-medium text-ink">
        {label}
      </label>
      {children}
      {error ? (
        <p className="mt-1.5 text-xs text-out-soft">{error}</p>
      ) : hint ? (
        <p className="mt-1.5 text-xs text-muted">{hint}</p>
      ) : null}
    </div>
  );
}

export function Alert({
  tone = 'error',
  onDismiss,
  children,
}: {
  tone?: 'error' | 'warning' | 'success' | 'info';
  /** Shows a close button in the top right corner. */
  onDismiss?: () => void;
  children: ReactNode;
}) {
  const styles = {
    error: 'border-out/40 bg-out-bg text-red-200',
    warning: 'border-warn/40 bg-warn-bg text-amber-100',
    success: 'border-ok/40 bg-ok/10 text-emerald-100',
    info: 'border-line bg-surface text-muted',
  }[tone];
  const Icon = tone === 'info' ? Info : tone === 'success' ? CircleCheck : TriangleAlert;
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={`flex gap-3 rounded-lg border px-4 py-3 text-sm ${styles}`}>
      <Icon className={`mt-0.5 size-4 shrink-0 ${tone === 'info' ? 'text-accent-soft' : ''}`} aria-hidden />
      <div className="min-w-0 flex-1">{children}</div>
      {onDismiss && (
        <button
          type="button"
          title="Dismiss"
          aria-label="Dismiss"
          onClick={onDismiss}
          className="-mt-1.5 -mr-2.5 inline-flex size-6 shrink-0 items-center justify-center rounded-md opacity-60 transition-opacity hover:bg-white/10 hover:opacity-100 print:hidden"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      )}
    </div>
  );
}

const DISMISSED_PREFIX = 'crafty.dismissed.';

/** The storage keys of notices dismissed in this browser. */
function dismissedKeys(): string[] {
  try {
    return Object.keys(localStorage).filter((k) => k.startsWith(DISMISSED_PREFIX));
  } catch {
    return [];
  }
}

/** How many notices have been dismissed in this browser. */
export function dismissedNoticeCount(): number {
  return dismissedKeys().length;
}

/** Brings back every notice dismissed in this browser. */
export function showDismissedNotices(): void {
  for (const key of dismissedKeys()) {
    try {
      localStorage.removeItem(key);
    } catch {
      // Nothing more to do.
    }
  }
}

/**
 * An Alert with a close button that stays closed in this browser (localStorage, under `id`),
 * so it comes back on another device or browser.
 */
export function DismissibleAlert({ id, tone = 'warning', children }: { id: string; tone?: 'error' | 'warning' | 'success' | 'info'; children: ReactNode }) {
  const key = DISMISSED_PREFIX + id;
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(key) === '1';
    } catch {
      return false;
    }
  });
  if (dismissed) return null;
  return (
    <Alert
      tone={tone}
      onDismiss={() => {
        try {
          localStorage.setItem(key, '1');
        } catch {
          // Storage unavailable (private window): it still closes until the page is reloaded.
        }
        setDismissed(true);
      }}
    >
      {children}
    </Alert>
  );
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted">
      <LoaderCircle className="size-5 animate-spin" aria-hidden />
      {label}
    </div>
  );
}

export function EmptyState({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center">
      {icon && <div className="mb-3 text-faint">{icon}</div>}
      <p className="font-medium text-ink">{title}</p>
      {children && <div className="mt-1.5 max-w-md text-sm text-muted">{children}</div>}
    </div>
  );
}

export type BadgeTone = 'neutral' | 'accent' | 'out' | 'teal' | 'warn' | 'ok';

export function Badge({ tone = 'neutral', children }: { tone?: BadgeTone; children: ReactNode }) {
  const styles = {
    neutral: 'bg-surface-2 text-muted border-line-strong',
    accent: 'bg-accent-bg text-accent-soft border-accent/30',
    out: 'bg-out-bg text-out-soft border-out/30',
    teal: 'bg-teal-bg text-teal border-teal/30',
    warn: 'bg-warn-bg text-warn border-warn/30',
    ok: 'bg-ok/10 text-ok border-ok/30',
  }[tone];
  return <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${styles}`}>{children}</span>;
}

const PAYMENT_STYLES: Record<PaymentMethod, string> = {
  cash: 'bg-amber-400/10 text-amber-300 border-amber-400/30',
  card: 'bg-teal-bg text-teal border-teal/30',
  bank_transfer: 'bg-indigo-400/10 text-indigo-300 border-indigo-400/30',
};

/**
 * Payment method label, coloured per method (cash amber, card teal, bank transfer indigo).
 * `lg` is 20% bigger, for a transaction's own page.
 */
export function PaymentBadge({ method, size = 'sm' }: { method: PaymentMethod; size?: 'sm' | 'lg' }) {
  const sizing = size === 'lg' ? 'px-2.5 py-[0.15rem] text-[0.9rem] leading-5' : 'px-2 py-0.5 text-xs';
  return (
    <span className={`inline-flex items-center rounded-md border font-medium whitespace-nowrap ${sizing} ${PAYMENT_STYLES[method]}`}>
      {PAYMENT_METHOD_LABELS[method]}
    </span>
  );
}

export function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 py-3 sm:grid-cols-[180px_1fr] sm:gap-4">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="min-w-0 break-words text-sm text-ink">{children ?? <span className="text-faint">—</span>}</dd>
    </div>
  );
}
