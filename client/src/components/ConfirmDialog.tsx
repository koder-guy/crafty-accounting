import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Send, TriangleAlert } from 'lucide-react';
import { Alert, Button } from './ui';

interface Props {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  /** If set, the user must type this text before the confirm button enables. */
  requireText?: string;
  onConfirm: () => Promise<unknown> | void;
  onClose: () => void;
  /** "send" for an action that isn't destructive but can't be taken back, like sending to HMRC. */
  tone?: 'danger' | 'send';
  wide?: boolean;
}

/** A modal warning shown before destructive actions. */
export function ConfirmDialog({ open, title, children, confirmLabel, requireText, onConfirm, onClose, tone = 'danger', wide }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      setTyped('');
      setError(null);
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const blocked = requireText !== undefined && typed.trim() !== requireText;

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
      className={`m-auto w-[calc(100%-32px)] ${wide ? 'max-w-xl' : 'max-w-md'} rounded-[var(--radius-card)] border border-line bg-surface p-0 text-ink shadow-2xl backdrop:bg-black/70 backdrop:backdrop-blur-sm`}
    >
      <div className="p-6">
        <div className="flex gap-4">
          <div
            className={`flex size-10 shrink-0 items-center justify-center rounded-full ${
              tone === 'send' ? 'bg-accent-bg text-accent-soft' : 'bg-out-bg text-out-soft'
            }`}
          >
            {tone === 'send' ? <Send className="size-5" aria-hidden /> : <TriangleAlert className="size-5" aria-hidden />}
          </div>
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-base font-semibold">
              {title}
            </h2>
            <div className="mt-2 space-y-2 text-sm text-muted">{children}</div>
          </div>
        </div>

        {requireText !== undefined && (
          <div className="mt-5">
            <label htmlFor={`${titleId}-confirm`} className="mb-1.5 block text-sm text-muted">
              Type <span className="font-semibold text-ink">{requireText}</span> to confirm
            </label>
            <input
              id={`${titleId}-confirm`}
              className="field"
              value={typed}
              autoComplete="off"
              onChange={(e) => setTyped(e.target.value)}
            />
          </div>
        )}

        {error && (
          <div className="mt-4">
            <Alert>{error}</Alert>
          </div>
        )}

        <div className="mt-6 flex justify-end gap-3">
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" variant={tone === 'send' ? 'primary' : 'danger'} onClick={confirm} busy={busy} disabled={blocked}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </dialog>
  );
}
