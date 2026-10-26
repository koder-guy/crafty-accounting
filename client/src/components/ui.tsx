import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Link, type LinkProps } from 'react-router';
import { CircleCheck, LoaderCircle, TriangleAlert } from 'lucide-react';
import { PAYMENT_METHOD_LABELS, type PaymentMethod } from '@crafty/shared';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

const variants: Record<Variant, string> = {
  primary: 'bg-accent text-white hover:bg-accent-strong border border-accent',
  secondary: 'bg-surface-2 text-ink border border-line-strong hover:border-accent-soft/60 hover:text-white',
  ghost: 'text-muted hover:text-ink hover:bg-surface-2 border border-transparent',
  danger: 'bg-out text-white hover:bg-red-700 border border-out',
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

export function Card({ className = '', children }: { className?: string; children: ReactNode }) {
  return <section className={`card ${className}`}>{children}</section>;
}

export function CardHeader({ icon, title, action }: { icon?: ReactNode; title: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-5 pt-5 pb-4 sm:px-6">
      <h2 className="flex items-center gap-2.5 text-base font-semibold text-ink">
        {icon}
        {title}
      </h2>
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

export function Alert({ tone = 'error', children }: { tone?: 'error' | 'warning' | 'success'; children: ReactNode }) {
  const styles = {
    error: 'border-out/40 bg-out-bg text-red-200',
    warning: 'border-warn/40 bg-warn-bg text-amber-100',
    success: 'border-ok/40 bg-ok/10 text-emerald-100',
  }[tone];
  const Icon = tone === 'success' ? CircleCheck : TriangleAlert;
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={`flex gap-3 rounded-lg border px-4 py-3 text-sm ${styles}`}>
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0">{children}</div>
    </div>
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

export function Badge({ tone = 'neutral', children }: { tone?: 'neutral' | 'accent' | 'out' | 'teal'; children: ReactNode }) {
  const styles = {
    neutral: 'bg-surface-2 text-muted border-line-strong',
    accent: 'bg-accent-bg text-accent-soft border-accent/30',
    out: 'bg-out-bg text-out-soft border-out/30',
    teal: 'bg-teal-bg text-teal border-teal/30',
  }[tone];
  return <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${styles}`}>{children}</span>;
}

const PAYMENT_STYLES: Record<PaymentMethod, string> = {
  cash: 'bg-amber-400/10 text-amber-300 border-amber-400/30',
  card: 'bg-teal-bg text-teal border-teal/30',
  bank_transfer: 'bg-indigo-400/10 text-indigo-300 border-indigo-400/30',
};

/** Payment method label, coloured per method (cash amber, card teal, bank transfer indigo). */
export function PaymentBadge({ method }: { method: PaymentMethod }) {
  return (
    <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium whitespace-nowrap ${PAYMENT_STYLES[method]}`}>
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
