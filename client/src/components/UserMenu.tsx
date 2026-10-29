import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { ChevronDown, KeyRound, LogOut } from 'lucide-react';
import { ROLE_LABELS } from '@crafty/shared';
import { dismissWithoutClicking } from '../lib/menus';
import { useLogout, useMe } from '../lib/queries';
import { Badge } from './ui';

/** "Jo Bloggs" → "JB", "admin" → "A". */
const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('');

function Avatar({ name }: { name: string }) {
  return (
    <span
      aria-hidden
      className="flex size-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-violet-500 to-indigo-500 text-xs font-semibold text-white"
    >
      {initials(name)}
    </span>
  );
}

/**
 * Who's signed in, and signing out, in one place at the top right: the
 * avatar and name open a menu with their access, a link to change their
 * password, and Sign out. `compact` shows just the avatar (phone top bar).
 */
export function UserMenu({ compact = false }: { compact?: boolean }) {
  const { data: me } = useMe();
  const logout = useLogout();
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

  const user = me?.user;
  if (!user) return null;

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account: ${user.name}`}
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex items-center gap-2 rounded-full text-sm text-ink transition-colors hover:bg-surface ${
          compact ? 'p-1' : 'border border-line-strong py-1 pr-3 pl-1'
        } ${open ? 'bg-surface' : ''}`}
      >
        <Avatar name={user.name} />
        {!compact && (
          <>
            <span className="max-w-40 truncate font-medium">{user.name}</span>
            <ChevronDown className={`size-4 text-muted transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden />
          </>
        )}
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Account"
          className="absolute top-full right-0 z-40 mt-2 w-64 rounded-xl border border-line-strong bg-surface p-1.5 shadow-2xl"
        >
          <div className="flex items-center gap-3 px-3 py-2.5">
            <Avatar name={user.name} />
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-white">{user.name}</div>
              <div className="mt-0.5">
                <Badge tone={user.role === 'viewer' ? 'warn' : 'neutral'}>{ROLE_LABELS[user.role]}</Badge>
              </div>
            </div>
          </div>
          <div className="my-1 h-px bg-line" />
          <Link
            role="menuitem"
            to="/settings/people"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-ink hover:bg-surface-2"
          >
            <KeyRound className="size-4 text-muted" aria-hidden />
            Change password
          </Link>
          <button
            role="menuitem"
            type="button"
            disabled={logout.isPending}
            onClick={() => logout.mutate()}
            className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm text-ink hover:bg-surface-2"
          >
            <LogOut className="size-4 text-muted" aria-hidden />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
