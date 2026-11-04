import { useEffect, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Clock, Download, History, Trash2 } from 'lucide-react';
import { diskSize, lowSpaceThreshold, type AutoBackupStatus, type DiskSpace } from '@crafty/shared';

type AutoBackupFile = AutoBackupStatus['backups'][number];
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Alert, Button, buttonClasses, Card, CardHeader, Field, IconButton, Spinner } from '../../components/ui';
import { api } from '../../lib/api';
import { useAutoBackup, useAutoBackupMutations } from '../../lib/queries';


const SHOWN_BACKUPS = 10;

const dateTime = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

const fileSize = (bytes: number) =>
  bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** Free space on a disk, flagged when it's under 1 GB or too little for three more backups like the newest. */
function FreeSpace({ space, backupBytes }: { space: DiskSpace | null; backupBytes: number }) {
  if (!space) return <span className="text-muted">Can't be read</span>;
  const low = space.freeBytes < lowSpaceThreshold(backupBytes);
  return (
    <span className={low ? 'text-out-soft' : undefined}>
      {diskSize(space.freeBytes)} free of {diskSize(space.totalBytes)}
      {low && ', running low'}
    </span>
  );
}

function LastRun({ status }: { status: AutoBackupStatus }) {
  const last = status.lastRun;
  if (!last) return <span className="text-muted">No backups yet</span>;
  if (last.status === 'failed') return <span className="text-out-soft">Failed on {dateTime(last.at)}: {last.error}</span>;
  if (last.status === 'skipped') return <span>{dateTime(last.at)}, skipped because nothing had changed</span>;
  return <span>{dateTime(last.at)}</span>;
}

export function AutoBackupCard() {
  const { data: status, isLoading, error } = useAutoBackup();
  const { save, runNow, remove } = useAutoBackupMutations();
  const [enabled, setEnabled] = useState(true);
  const [time, setTime] = useState('02:00');
  const [keep, setKeep] = useState('30');
  const [saved, setSaved] = useState(false);
  const qc = useQueryClient();
  const [restoring, setRestoring] = useState<AutoBackupFile | null>(null);
  const [restored, setRestored] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<AutoBackupFile | null>(null);

  const restore = async () => {
    const backup = restoring!;
    await api.post(`/backup/auto/files/${encodeURIComponent(backup.name)}/restore`);
    setRestored(dateTime(backup.createdAt));
    await qc.invalidateQueries();
  };

  useEffect(() => {
    if (!status) return;
    setEnabled(status.enabled);
    setTime(status.time);
    setKeep(String(status.keep));
  }, [status?.enabled, status?.time, status?.keep]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSaved(false);
    save.mutate({ enabled, time, keep: Number(keep) }, { onSuccess: () => setSaved(true) });
  };

  return (
    <>
      <Card>
        <CardHeader icon={<Clock className="size-5 text-accent-soft" />} title="Automatic backups" />
        <div className="space-y-5 px-5 pb-6 sm:px-6">
          {isLoading ? (
            <Spinner />
          ) : error || !status ? (
            <Alert>{error?.message ?? 'Could not load the automatic backup settings'}</Alert>
          ) : (
            <>
              <p className="text-sm text-muted">
                A full backup (.zip with documents) is saved to the backup folder once a day. If nothing has changed since the last one,
                that day is skipped. Older backups are deleted once there are more than you keep.
              </p>

              {!status.folderWritable && (
                <Alert>
                  The backup folder <code>{status.folder}</code> can't be written to, so automatic backups can't be saved. Check the folder
                  exists and its permissions (see the README). Until then you can{' '}
                  <a href="/api/backup.zip" download className="font-medium underline">
                    download a full backup
                  </a>{' '}
                  instead.
                </Alert>
              )}

              <form onSubmit={submit} noValidate className="space-y-4">
                <label className="flex items-center gap-3 text-sm text-ink">
                  <input
                    type="checkbox"
                    className="size-4 accent-[var(--color-accent)]"
                    checked={enabled}
                    onChange={(e) => setEnabled(e.target.checked)}
                  />
                  Back up automatically every day
                </label>
                <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
                  <Field label="Time of day" htmlFor="backup-time" className="sm:w-40">
                    <input
                      id="backup-time"
                      type="time"
                      className="field"
                      value={time}
                      disabled={!enabled}
                      onChange={(e) => setTime(e.target.value)}
                    />
                  </Field>
                  <Field label="Backups to keep" htmlFor="backup-keep" className="sm:w-40">
                    <input
                      id="backup-keep"
                      type="number"
                      min={1}
                      max={365}
                      className="field"
                      value={keep}
                      onChange={(e) => setKeep(e.target.value)}
                    />
                  </Field>
                  <Button type="submit" variant="primary" busy={save.isPending}>
                    Save
                  </Button>
                </div>
                {save.error && <Alert>{save.error.message}</Alert>}
                {saved && !save.error && <Alert tone="success">Settings saved.</Alert>}
              </form>

              <dl className="grid gap-3 border-t border-line pt-5 text-sm sm:grid-cols-[160px_1fr]">
                <dt className="text-muted">Last backup</dt>
                <dd>
                  <LastRun status={status} />
                </dd>
                <dt className="text-muted">Next backup</dt>
                <dd>{status.nextRunAt ? dateTime(status.nextRunAt) : <span className="text-muted">Automatic backups are off</span>}</dd>
                <dt className="text-muted">Backup folder</dt>
                <dd className="break-all">
                  <code>{status.folder}</code>
                </dd>
                <dt className="text-muted">{status.storage.sameDisk ? 'Free space' : 'Free space for data'}</dt>
                <dd>
                  <FreeSpace space={status.storage.data} backupBytes={status.backups[0]?.sizeBytes ?? 0} />
                </dd>
                {!status.storage.sameDisk && (
                  <>
                    <dt className="text-muted">Free space for backups</dt>
                    <dd>
                      <FreeSpace space={status.storage.backups} backupBytes={status.backups[0]?.sizeBytes ?? 0} />
                    </dd>
                  </>
                )}
              </dl>

              <div className="flex flex-wrap items-center gap-3">
                <Button onClick={() => runNow.mutate()} busy={runNow.isPending} disabled={!status.folderWritable}>
                  Back up now
                </Button>
                {runNow.error && <span className="text-sm text-out-soft">{runNow.error.message}</span>}
              </div>

              {status.backups.length > 0 && (
                <div>
                  <h3 className="eyebrow mb-2">
                    Saved backups ({status.backups.length} of up to {status.keep})
                  </h3>
                  <ul className="divide-y divide-line rounded-lg border border-line text-sm">
                    {status.backups.slice(0, SHOWN_BACKUPS).map((b) => (
                      <li key={b.name} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2.5">
                      <div className="min-w-0">
                        <div className="truncate text-ink">{dateTime(b.createdAt)}</div>
                        <div className="truncate text-xs text-faint">
                          {b.name} · {fileSize(b.sizeBytes)}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <a
                          href={`/api/backup/auto/files/${encodeURIComponent(b.name)}`}
                          download={b.name}
                          className={buttonClasses()}
                        >
                          <Download className="size-4" aria-hidden />
                          Download
                        </a>
                        <Button
                          variant="softDanger"
                          onClick={() => {
                            setRestored(null);
                            setRestoring(b);
                          }}
                        >
                          <History className="size-4" aria-hidden />
                          Restore…
                        </Button>
                        <IconButton
                          label="Delete"
                          tone="danger"
                          className="ml-2"
                          aria-label={`Delete the backup from ${dateTime(b.createdAt)}`}
                          onClick={() => {
                            setRestored(null);
                            setDeleting(b);
                          }}
                        >
                          <Trash2 className="size-4" aria-hidden />
                        </IconButton>
                      </div>
                    </li>
                    ))}
                  </ul>
                  {status.backups.length > SHOWN_BACKUPS && (
                    <p className="mt-2 text-xs text-muted">
                      {status.backups.length - SHOWN_BACKUPS} older backups are in the backup folder.
                    </p>
                  )}
                  {restored && (
                    <div className="mt-3">
                      <Alert tone="success">Restored the backup from {restored}.</Alert>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </Card>

      <ConfirmDialog
        open={restoring !== null}
        title="Replace all data with this backup?"
        confirmLabel="Restore backup"
        requireText="RESTORE"
        onClose={() => setRestoring(null)}
        onConfirm={restore}
      >
        <p>
          Everything currently in the app, including all attached documents, will be replaced by the backup from{' '}
          <strong className="text-ink">{restoring && dateTime(restoring.createdAt)}</strong>.
        </p>
        <p>
          Later backups stay in the backup folder. Use Back up now first if you might need the current data, as it may not be in a
          saved backup yet.
        </p>
      </ConfirmDialog>

      <ConfirmDialog
        open={deleting !== null}
        title="Delete this backup?"
        confirmLabel="Delete backup"
        onClose={() => setDeleting(null)}
        onConfirm={() => remove.mutateAsync(deleting!.name)}
      >
        <p>
          The backup from <strong className="text-ink">{deleting && dateTime(deleting.createdAt)}</strong> will be deleted from the backup
          folder. This can't be undone.
        </p>
        {deleting?.name === status?.backups[0]?.name && (
          <p>It's the newest backup, so the next daily backup will be made even if nothing has changed.</p>
        )}
      </ConfirmDialog>
    </>
  );
}
