import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { DatabaseBackup, Download, FileArchive, FileCode, Upload } from 'lucide-react';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Alert, Button, Card, CardHeader } from '../../components/ui';
import { api } from '../../lib/api';
import { SettingsHeading } from './SettingsLayout';

function DownloadTile({ href, icon, title, children }: { href: string; icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      download
      className="group flex gap-4 rounded-xl border border-line bg-page/40 p-5 transition-colors hover:border-accent/50 hover:bg-surface-2"
    >
      <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-accent-bg text-accent-soft">{icon}</div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 font-medium text-ink">
          {title}
          <Download className="size-4 text-faint group-hover:text-accent-soft" aria-hidden />
        </div>
        <p className="mt-1 text-sm text-muted">{children}</p>
      </div>
    </a>
  );
}

export function BackupSettings() {
  const qc = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState(false);

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
        <SettingsHeading title="Backup and restore" description="Download a copy of your books, or restore from an earlier backup." />
        <Card>
          <CardHeader icon={<DatabaseBackup className="size-5 text-accent-soft" />} title="Download a backup" />
          <div className="grid gap-4 px-5 pb-6 sm:px-6 lg:grid-cols-2">
            <DownloadTile href="/api/backup.zip" icon={<FileArchive className="size-5" />} title="Full backup (.zip)">
              The database plus every attached document. Use this to move the app or recover everything.
            </DownloadTile>
            <DownloadTile href="/api/backup.sql" icon={<FileCode className="size-5" />} title="Database only (.sql)">
              A readable SQL dump of all tax years, transactions and categories. Documents are not included.
            </DownloadTile>
          </div>
        </Card>

        <Card>
          <CardHeader icon={<Upload className="size-5 text-accent-soft" />} title="Restore from a backup" />
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
              <Button variant="danger" disabled={!file} onClick={() => setConfirming(true)}>
                Restore…
              </Button>
            </div>
            {done && <Alert tone="success">Backup restored.</Alert>}
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
        <p>Download a backup of the current data first if you might need it.</p>
      </ConfirmDialog>
    </>
  );
}
