import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { BellRing, History, RotateCcw, Upload } from 'lucide-react';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Alert, Button, Card, CardHeader, dismissedNoticeCount, showDismissedNotices } from '../../components/ui';
import { api } from '../../lib/api';
import { AutoBackupCard } from './AutoBackupCard';
import { SettingsHeading } from './SettingsLayout';

export function BackupSettings() {
  const qc = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [resetDone, setResetDone] = useState(false);
  const [dismissedCount, setDismissedCount] = useState(dismissedNoticeCount);
  const [noticesShown, setNoticesShown] = useState(false);

  const reset = async () => {
    await api.post('/reset', { confirm: 'RESET' });
    setResetDone(true);
    // Back to a clean slate everywhere (including remembered UI state), staying signed in.
    await qc.resetQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
  };

  const restore = async () => {
    const form = new FormData();
    form.append('file', file!, file!.name);
    await api.post('/restore', form);
    setFile(null);
    if (inputRef.current) inputRef.current.value = '';
    setDone(true);
    await qc.invalidateQueries();
  };

  const isZip = file?.name.toLowerCase().endsWith('.zip');

  return (
    <>
      <div className="space-y-6">
        <SettingsHeading
          title="Backup and Restore"
          description="Back up your books, restore from an earlier backup, or start again with an empty database."
        />
        <AutoBackupCard />

        <Card>
          <CardHeader icon={<Upload className="size-5 text-accent-soft" />} title="Restore from a backup file" />
          <div className="space-y-4 px-5 pb-6 sm:px-6">
            <Alert tone="warning">
              Restoring <strong>replaces all current data</strong> with the backup. A .zip backup also replaces all attached documents; a .sql
              backup leaves the documents folder as it is. The previous database is kept on the server as <code>crafty.pre-restore.db</code>.
            </Alert>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <input
                ref={inputRef}
                id="restore-file"
                type="file"
                accept=".sql,.zip"
                className="sr-only"
                onChange={(e) => {
                  setDone(false);
                  setFile(e.target.files?.[0] ?? null);
                }}
              />
              <label
                htmlFor="restore-file"
                className="inline-flex cursor-pointer items-center justify-center rounded-lg border border-line-strong bg-surface-2 px-3.5 py-2 text-sm font-medium hover:border-accent-soft/60"
              >
                Choose backup file
              </label>
              <span className="min-w-0 flex-1 truncate text-sm text-muted">{file ? file.name : 'No file chosen'}</span>
              <Button variant="softDanger" disabled={!file} onClick={() => setConfirming(true)}>
                <History className="size-4" aria-hidden />
                Restore…
              </Button>
            </div>
            {done && <Alert tone="success">Backup restored.</Alert>}
          </div>
        </Card>

        <Card>
          <CardHeader icon={<BellRing className="size-5 text-accent-soft" />} title="Dismissed notices" />
          <div className="space-y-4 px-5 pb-6 sm:px-6">
            <p className="text-sm text-muted">
              Notices you close, such as the warnings on Mileage and Use of Home, stay closed in this browser only. Restoring or
              resetting doesn't bring them back; this does, for this browser.{' '}
              {dismissedCount === 0
                ? 'None are dismissed here at the moment.'
                : `${dismissedCount} ${dismissedCount === 1 ? 'is' : 'are'} dismissed here.`}
            </p>
            <Button
              disabled={dismissedCount === 0}
              onClick={() => {
                showDismissedNotices();
                setDismissedCount(dismissedNoticeCount());
                setNoticesShown(true);
              }}
            >
              Show dismissed notices again
            </Button>
            {noticesShown && <Alert tone="success">Dismissed notices will show again in this browser.</Alert>}
          </div>
        </Card>

        <Card className="border-out/40">
          <CardHeader icon={<RotateCcw className="size-5 text-out-soft" />} title="Start again with an empty database" />
          <div className="space-y-4 px-5 pb-6 sm:px-6">
            <p className="text-sm text-muted">
              Deletes all tax years, income and expense transactions, attached documents, custom categories and MTD submission
              records. The standard MTD categories and your sign-in password stay. A copy of the old data is kept on the server as{' '}
              <code>crafty.pre-reset.db</code> and <code>uploads.pre-reset</code> until the next reset.
            </p>
            <Button
              variant="danger"
              onClick={() => {
                setResetDone(false);
                setConfirmingReset(true);
              }}
            >
              Reset everything…
            </Button>
            {resetDone && <Alert tone="success">Everything has been reset. Create a tax year to start again.</Alert>}
          </div>
        </Card>
      </div>

      <ConfirmDialog
        open={confirming}
        title="Replace all data with this backup?"
        confirmLabel="Restore backup"
        requireText="RESTORE"
        onClose={() => setConfirming(false)}
        onConfirm={restore}
      >
        <p>
          Everything currently in the app will be replaced by <strong className="text-ink break-all">{file?.name}</strong>
          {isZip ? ', including all attached documents' : ''}.
        </p>
        <p>Use Back up now first if you might need the current data.</p>
      </ConfirmDialog>

      <ConfirmDialog
        open={confirmingReset}
        title="Delete everything and start again?"
        confirmLabel="Reset everything"
        requireText="RESET"
        onClose={() => setConfirmingReset(false)}
        onConfirm={reset}
      >
        <p>
          All tax years, transactions, documents, custom categories and MTD submission records will be deleted, leaving an empty
          database.
        </p>
        <p>Use Back up now first if you might need any of it.</p>
      </ConfirmDialog>
    </>
  );
}
