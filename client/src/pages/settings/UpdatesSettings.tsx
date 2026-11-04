import { useEffect, useState } from 'react';
import { CircleArrowUp, Copy, ExternalLink, RefreshCw } from 'lucide-react';
import { APP_VERSION, type UpdateStatus } from '@crafty/shared';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Alert, Button, Card, CardHeader, Spinner } from '../../components/ui';
import { useCanEdit, useUpdateMutations, useUpdates } from '../../lib/queries';
import { SettingsHeading } from './SettingsLayout';

const SHOWN_CHANGES = 25;

const dateTime = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

function CopyableCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  // The clipboard is only offered over HTTPS or on localhost; the command can still be selected.
  const canCopy = typeof navigator.clipboard?.writeText === 'function';
  return (
    <div className="flex items-start gap-2">
      <code className="min-w-0 flex-1 select-all break-all rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-ink">{command}</code>
      {canCopy && (
        <Button
          onClick={() => void navigator.clipboard.writeText(command).then(() => setCopied(true))}
          aria-label="Copy the command"
        >
          <Copy className="size-4" aria-hidden />
          {copied ? 'Copied' : 'Copy'}
        </Button>
      )}
    </div>
  );
}

/** How to get the new version, which depends on how this copy was installed. */
function HowToUpdate({ status, version }: { status: UpdateStatus; version: string }) {
  const canEdit = useCanEdit();
  const { apply } = useUpdateMutations();
  const [confirming, setConfirming] = useState(false);

  if (status.install === 'docker') {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted">
          This copy runs in Docker, which it can't update from inside. On the computer Docker runs on, run the installer again. It keeps
          your books and settings, and takes a few minutes.
        </p>
        <CopyableCommand command={`${status.installDir ?? '~/crafty-accounting'}/install-docker.sh`} />
        {!status.installDir && <p className="text-xs text-faint">If you installed it somewhere else, use the install-docker.sh in that folder.</p>}
      </div>
    );
  }

  if (status.install === 'manual') {
    return (
      <p className="text-sm text-muted">
        This copy wasn't set up with the installer, so it can't update itself. Update it the way you set it up: for a copy of the source
        code, get version {version} (for example <code>git pull</code>), then <code>npm ci</code>, <code>npm run build</code> and restart
        it.
      </p>
    );
  }

  if (!canEdit) return <p className="text-sm text-muted">Someone who can edit the books can install it here.</p>;

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" onClick={() => setConfirming(true)} disabled={!!status.applying}>
          <CircleArrowUp className="size-4" aria-hidden />
          Update to version {version}
        </Button>
        <span className="text-sm text-muted">Saves a backup first. Takes a few minutes.</span>
      </div>
      <ConfirmDialog
        open={confirming}
        title={`Update to version ${version}?`}
        confirmLabel="Update"
        tone="send"
        onConfirm={() => apply.mutateAsync(version)}
        onClose={() => setConfirming(false)}
      >
        <p>
          A backup of your books is saved first. The new version is then downloaded and built, which takes a few minutes; the app keeps
          working meanwhile.
        </p>
        <p className="mt-3">
          At the end the app restarts, which takes a few seconds, and this page reloads by itself. If anything goes wrong before then,
          version {APP_VERSION} keeps running.
        </p>
      </ConfirmDialog>
    </>
  );
}

/** Minutes and seconds since the update started, ticking. */
function useElapsed(since: string) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const seconds = Math.max(0, Math.floor((now - Date.parse(since)) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** At the top of the page while an update runs, so it's clear something is happening. */
function UpdateProgress({ applying, restarting }: { applying: NonNullable<UpdateStatus['applying']>; restarting: boolean }) {
  const elapsed = useElapsed(applying.startedAt);
  return (
    <div role="status" className="flex gap-4 rounded-xl border border-accent/40 bg-accent-bg px-5 py-4">
      <RefreshCw className="mt-0.5 size-6 shrink-0 animate-spin text-accent-soft" aria-hidden />
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-medium text-ink">
          {restarting ? 'Restarting with' : 'Updating to'} version {applying.version}…
          <span className="ml-2 font-normal tabular-nums text-muted">{elapsed}</span>
        </p>
        <p className="mt-1 text-muted">
          {restarting
            ? "The app is restarting, which takes a few seconds. This page reloads by itself once the new version answers."
            : `Started ${dateTime(applying.startedAt)}. Downloading and building the new version takes a few minutes; you can keep working meanwhile. The page reloads by itself once it's running.`}
        </p>
      </div>
    </div>
  );
}

export function UpdatesSettings() {
  const { data: status, isLoading, error, failureCount } = useUpdates();
  const { check } = useUpdateMutations();
  const canEdit = useCanEdit();

  const available = status?.available;
  const changes = available?.changes ?? [];

  return (
    <div className="space-y-6">
      <SettingsHeading title="Updates" description="New versions of Crafty Accounting, and how to install them." />

      {/* While the server restarts, requests fail and the last status (still applying) is kept. */}
      {status?.applying && <UpdateProgress applying={status.applying} restarting={failureCount > 0} />}

      <Card>
        <CardHeader icon={<RefreshCw className="size-5 text-accent-soft" />} title="This version" />
        <div className="space-y-5 px-5 pb-6 sm:px-6">
          {isLoading ? (
            <Spinner />
          ) : error || !status ? (
            <Alert>{error?.message ?? 'Could not load the update status'}</Alert>
          ) : (
            <>
              <dl className="grid gap-3 text-sm sm:grid-cols-[160px_1fr]">
                <dt className="text-muted">Running</dt>
                <dd>Version {status.currentVersion}</dd>
                <dt className="text-muted">Last checked</dt>
                <dd>
                  {status.checkedAt ? dateTime(status.checkedAt) : <span className="text-muted">Not yet</span>}
                  <span className="block text-xs text-faint">
                    {status.autoCheck
                      ? 'Checks GitHub for new versions twice a day.'
                      : "Doesn't check by itself (UPDATE_CHECK is off), only when you choose Check now."}
                  </span>
                </dd>
              </dl>
              {status.checkError && <Alert tone="warning">{status.checkError}</Alert>}
              {status.checkedAt && !status.checkError && !available && <Alert tone="success">This is the newest version.</Alert>}
              {canEdit && (
                <div className="flex flex-wrap items-center gap-3">
                  <Button onClick={() => check.mutate()} busy={check.isPending} disabled={!!status.applying}>
                    Check now
                  </Button>
                  {check.error && <span className="text-sm text-out-soft">{check.error.message}</span>}
                </div>
              )}
            </>
          )}
        </div>
      </Card>

      {status?.failed && (
        <Alert>
          <p>
            The update to version {status.failed.version} on {dateTime(status.failed.at)} didn't finish, so version {status.currentVersion}{' '}
            is still running. The end of its log:
          </p>
          {status.failed.log && (
            <pre className="mt-3 max-h-72 overflow-auto rounded-lg bg-black/30 p-3 text-xs whitespace-pre-wrap">{status.failed.log}</pre>
          )}
        </Alert>
      )}

      {status && available && (
        <Card>
          <CardHeader
            icon={<CircleArrowUp className="size-5 text-accent-soft" />}
            title={`Version ${available.version} is available`}
            action={
              <a href={available.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-sm text-accent-soft hover:underline">
                On GitHub
                <ExternalLink className="size-3.5" aria-hidden />
              </a>
            }
          />
          <div className="space-y-5 px-5 pb-6 sm:px-6">
            {changes.length > 0 && (
              <div>
                <h3 className="eyebrow mb-2">What's changed</h3>
                <ul className="list-disc space-y-1 pl-5 text-sm">
                  {changes.slice(0, SHOWN_CHANGES).map((change, i) => (
                    <li key={i}>{change}</li>
                  ))}
                </ul>
                {changes.length > SHOWN_CHANGES && (
                  <p className="mt-2 text-sm text-muted">
                    And {changes.length - SHOWN_CHANGES} more; see them on GitHub.
                  </p>
                )}
              </div>
            )}

            {!status.applying && <HowToUpdate status={status} version={available.version} />}
          </div>
        </Card>
      )}
    </div>
  );
}
