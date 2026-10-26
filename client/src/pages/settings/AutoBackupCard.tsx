import { useEffect, useState, type FormEvent } from 'react';
import { Clock, Download } from 'lucide-react';
import type { AutoBackupStatus } from '@crafty/shared';
import { Alert, Button, Card, CardHeader, Field, Spinner } from '../../components/ui';
import { useAutoBackup, useAutoBackupMutations } from '../../lib/queries';

const SHOWN_BACKUPS = 10;

const dateTime = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

const fileSize = (bytes: number) =>
  bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

function LastRun({ status }: { status: AutoBackupStatus }) {
  const last = status.lastRun;
  if (!last) return <span className="text-muted">No backups yet</span>;
  if (last.status === 'failed') return <span className="text-out-soft">Failed on {dateTime(last.at)}: {last.error}</span>;
  if (last.status === 'skipped') return <span>{dateTime(last.at)}, skipped because nothing had changed</span>;
  return <span>{dateTime(last.at)}</span>;
}

export function AutoBackupCard() {
  const { data: status, isLoading, error } = useAutoBackup();
  const { save, runNow } = useAutoBackupMutations();
  const [enabled, setEnabled] = useState(true);
  const [time, setTime] = useState('02:00');
  const [keep, setKeep] = useState('30');
  const [saved, setSaved] = useState(false);

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
                exists and its permissions (see the README).
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
                    <li key={b.name} className="flex items-center justify-between gap-4 px-4 py-2.5">
                      <div className="min-w-0">
                        <div className="truncate text-ink">{dateTime(b.createdAt)}</div>
                        <div className="truncate text-xs text-faint">
                          {b.name} · {fileSize(b.sizeBytes)}
                        </div>
                      </div>
                      <a
                        href={`/api/backup/auto/files/${encodeURIComponent(b.name)}`}
                        download={b.name}
                        aria-label={`Download ${b.name}`}
                        title="Download"
                        className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-accent-bg hover:text-accent-soft"
                      >
                        <Download className="size-4" aria-hidden />
                      </a>
                    </li>
                  ))}
                </ul>
                {status.backups.length > SHOWN_BACKUPS && (
                  <p className="mt-2 text-xs text-muted">
                    {status.backups.length - SHOWN_BACKUPS} older backups are in the backup folder.
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </Card>
  );
}
