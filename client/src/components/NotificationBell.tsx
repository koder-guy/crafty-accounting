import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { Bell, Check, CheckCheck, CircleArrowUp, HardDrive, LockKeyhole, ScanText, type LucideIcon } from 'lucide-react';
import type { AppNotification, NotificationKind } from '@crafty/shared';
import { dismissWithoutClicking } from '../lib/menus';
import { useNotificationMutations, useNotifications } from '../lib/queries';

const ICONS: Record<NotificationKind, LucideIcon> = {
  update: CircleArrowUp,
  'low-space': HardDrive,
  'scans-read': ScanText,
  'certificate-expiry': LockKeyhole,
};

const ICON_TONES: Record<NotificationKind, string> = {
  update: 'bg-accent-bg text-accent-soft',
  'low-space': 'bg-warn-bg text-warn',
  'scans-read': 'bg-teal-bg text-teal',
  'certificate-expiry': 'bg-warn-bg text-warn',
};

const relative = new Intl.RelativeTimeFormat('en-GB', { numeric: 'auto' });

/** "just now", "5 minutes ago", "yesterday", or the date for anything over a week old. */
function timeAgo(iso: string, now = Date.now()): string {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  if (seconds > -60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes > -60) return relative.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (hours > -24) return relative.format(hours, 'hour');
  const days = Math.round(hours / 24);
  if (days > -7) return relative.format(days, 'day');
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function NotificationItem({ notification: n, onOpen }: { notification: AppNotification; onOpen: () => void }) {
  const { markRead } = useNotificationMutations();
  const Icon = ICONS[n.kind] ?? Bell;
  const text = (
    <>
      <span className="block text-sm font-semibold text-white">{n.title}</span>
      <span className="mt-0.5 block text-sm text-ink/90">{n.message}</span>
      <span className="mt-1 block text-xs text-muted">{timeAgo(n.createdAt)}</span>
    </>
  );
  return (
    <li className="flex items-start gap-3 rounded-lg px-3 py-3 hover:bg-surface-2">
      <span className={`mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full ${ICON_TONES[n.kind] ?? 'bg-surface-2 text-muted'}`}>
        <Icon className="size-4" aria-hidden />
      </span>
      {n.link ? (
        // Opening one takes you to where it can be dealt with; it stays unread until marked.
        <Link to={n.link} onClick={onOpen} className="min-w-0 flex-1 rounded focus-visible:outline-2 focus-visible:outline-accent-soft">
          {text}
        </Link>
      ) : (
        <div className="min-w-0 flex-1">{text}</div>
      )}
      <button
        type="button"
        title="Mark as read"
        aria-label={`Mark as read: ${n.title}`}
        onClick={() => markRead.mutate(n.id)}
        className="shrink-0 rounded-lg p-1.5 text-muted transition-colors hover:bg-accent-bg hover:text-accent-soft"
      >
        <Check className="size-4" aria-hidden />
      </button>
    </li>
  );
}

/**
 * The bell at the top right, left of the account menu: a badge with the number of unread
 * notifications, and a list of them to open or mark read. `compact` is for the phone top bar.
 */
export function NotificationBell({ compact = false }: { compact?: boolean }) {
  const { data } = useNotifications();
  const { markAllRead } = useNotificationMutations();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) dismissWithoutClicking(e, () => setOpen(false));
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const notifications = data?.notifications ?? [];
  const count = notifications.length;
  const label = count ? `Notifications: ${count} unread` : 'Notifications';

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => setOpen((v) => !v)}
        className={`relative flex items-center justify-center rounded-full text-muted transition-colors hover:bg-surface hover:text-ink ${
          compact ? 'size-10' : 'size-10 border border-line-strong'
        } ${open ? 'bg-surface text-ink' : ''}`}
      >
        <Bell className="size-5" aria-hidden />
        {count > 0 && (
          <span
            aria-hidden
            className="tabular absolute -top-1 -right-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-out px-1 text-[11px] leading-none font-semibold text-white ring-2 ring-page"
          >
            {count > 9 ? '9+' : count}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Notifications"
          className="fixed inset-x-4 top-[72px] z-40 flex max-h-[min(32rem,calc(100vh-6rem))] flex-col rounded-xl border border-line-strong bg-surface shadow-2xl sm:absolute sm:inset-x-auto sm:top-full sm:right-0 sm:mt-2 sm:w-96"
        >
          <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
            <h2 className="text-sm font-semibold text-white">Notifications</h2>
            {count > 0 && (
              <button
                type="button"
                onClick={() => markAllRead.mutate()}
                className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium text-accent-soft hover:bg-accent-bg"
              >
                <CheckCheck className="size-4" aria-hidden />
                Mark all as read
              </button>
            )}
          </div>
          {count ? (
            <ul className="overflow-y-auto p-1.5">
              {notifications.map((n) => (
                <NotificationItem key={n.id} notification={n} onOpen={() => setOpen(false)} />
              ))}
            </ul>
          ) : (
            <div className="flex flex-col items-center gap-2 px-4 py-10 text-center text-sm text-muted">
              <Bell className="size-6" aria-hidden />
              You're all caught up.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
