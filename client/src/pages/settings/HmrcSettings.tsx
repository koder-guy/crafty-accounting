import { useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { Landmark, Link2, Unlink } from 'lucide-react';
import { formatDisplayDate, type HmrcStatus } from '@crafty/shared';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Alert, Badge, Button, Card, CardHeader, Field, Spinner } from '../../components/ui';
import { useCanEdit, useHmrc, useHmrcMutations } from '../../lib/queries';
import { SettingsHeading } from './SettingsLayout';

/** QQ123456C → QQ 12 34 56 C, the way HMRC prints it. */
const spacedNino = (nino: string) => nino.replace(/^(..)(..)(..)(..)(.)$/, '$1 $2 $3 $4 $5');

const day = (iso: string) => formatDisplayDate(iso.slice(0, 10));

function SetupSteps({ status }: { status: HmrcStatus }) {
  return (
    <div className="space-y-3 text-sm text-muted">
      <p>To connect, the app needs its own application on HMRC’s Developer Hub:</p>
      <ol className="list-decimal space-y-1.5 pl-5">
        <li>
          Sign in at{' '}
          <a className="text-accent-soft hover:underline" href="https://developer.service.hmrc.gov.uk" target="_blank" rel="noreferrer">
            developer.service.hmrc.gov.uk
          </a>{' '}
          and add a sandbox application.
        </li>
        <li>Subscribe it to the Business Details, Obligations and Self Employment Business APIs.</li>
        <li>
          Add this redirect URI to it: <code className="break-all text-ink">{status.redirectUri}</code>
        </li>
        <li>
          Set <code>HMRC_CLIENT_ID</code> and <code>HMRC_CLIENT_SECRET</code> on the server (see the README) and restart it.
        </li>
      </ol>
    </div>
  );
}

function NinoForm({ status, canEdit }: { status: HmrcStatus; canEdit: boolean }) {
  const { saveNino } = useHmrcMutations();
  const [nino, setNino] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => setNino(status.nino ? spacedNino(status.nino) : ''), [status.nino]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSaved(false);
    saveNino.mutate(nino.trim() ? nino : null, { onSuccess: () => setSaved(true) });
  };

  if (!canEdit) {
    return (
      <dl className="grid gap-3 text-sm sm:grid-cols-[200px_1fr]">
        <dt className="text-muted">National Insurance number</dt>
        <dd>{status.nino ? spacedNino(status.nino) : <span className="text-muted">Not set</span>}</dd>
      </dl>
    );
  }
  return (
    <form onSubmit={submit} noValidate className="space-y-3">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <Field
          label="National Insurance number"
          htmlFor="hmrc-nino"
          className="sm:w-64"
          error={saveNino.error?.message}
          hint={status.environment === 'sandbox' ? 'Your sandbox test user’s, not your real one.' : 'Whose books these are.'}
        >
          <input
            id="hmrc-nino"
            className="field uppercase"
            value={nino}
            placeholder="QQ 12 34 56 C"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setNino(e.target.value)}
          />
        </Field>
        <Button type="submit" variant="primary" busy={saveNino.isPending} className="sm:mt-7">
          Save
        </Button>
      </div>
      {saved && !saveNino.error && <Alert tone="success">National Insurance number saved.</Alert>}
    </form>
  );
}

export function HmrcSettings() {
  const { data: status, isLoading, error } = useHmrc();
  const { connect, disconnect } = useHmrcMutations();
  const canEdit = useCanEdit();
  const [params, setParams] = useSearchParams();
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  // HMRC sends the browser back here with the outcome; show it once.
  const [outcome] = useState(() => ({ connected: params.get('connected') === '1', error: params.get('error') }));
  useEffect(() => {
    if (params.has('connected') || params.has('error')) setParams({}, { replace: true });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <div className="space-y-6">
        <SettingsHeading
          title="HMRC"
          description="Connect to HMRC so the app can send your quarterly updates through Making Tax Digital."
        />
        {outcome.connected && <Alert tone="success">Connected to HMRC.</Alert>}
        {outcome.error && <Alert>{outcome.error}</Alert>}

        <Card>
          <CardHeader
            icon={<Landmark className="size-5 text-accent-soft" />}
            title="HMRC connection"
            action={
              status && (
                <Badge tone={status.environment === 'sandbox' ? 'warn' : 'ok'}>
                  {status.environment === 'sandbox' ? 'Sandbox (test service)' : 'Live service'}
                </Badge>
              )
            }
          />
          <div className="space-y-5 px-5 pb-6 sm:px-6">
            {isLoading ? (
              <Spinner />
            ) : error || !status ? (
              <Alert>{error?.message ?? 'Could not load the HMRC settings'}</Alert>
            ) : (
              <>
                {status.environment === 'sandbox' && (
                  <p className="text-sm text-muted">
                    This uses HMRC’s sandbox, a test service with made-up taxpayers. Nothing sent from here reaches your real tax
                    account.
                  </p>
                )}

                <NinoForm status={status} canEdit={canEdit} />

                <div className="space-y-4 border-t border-line pt-5">
                  {!status.configured ? (
                    <SetupSteps status={status} />
                  ) : status.connection ? (
                    <>
                      <dl className="grid gap-3 text-sm sm:grid-cols-[200px_1fr]">
                        <dt className="text-muted">Status</dt>
                        <dd>
                          <Badge tone="ok">Connected</Badge>
                        </dd>
                        <dt className="text-muted">Connected by</dt>
                        <dd>
                          {status.connection.connectedBy} on {day(status.connection.connectedAt)}
                        </dd>
                        <dt className="text-muted">Connect again by</dt>
                        <dd>{day(status.connection.expiresAt)}</dd>
                      </dl>
                      {canEdit && (
                        <div className="flex flex-wrap gap-3">
                          <Button onClick={() => connect.mutate()} busy={connect.isPending}>
                            <Link2 className="size-4" aria-hidden />
                            Connect again
                          </Button>
                          <Button variant="softDanger" onClick={() => setConfirmingDisconnect(true)}>
                            <Unlink className="size-4" aria-hidden />
                            Disconnect
                          </Button>
                        </div>
                      )}
                    </>
                  ) : (
                    <>
                      <p className="text-sm text-muted">
                        Not connected. Connecting takes you to HMRC to sign in with the Government Gateway user ID
                        {status.environment === 'sandbox' ? ' of your sandbox test user' : ''} and give this app authority to read and send
                        your Self Assessment figures. You’ll need to connect again every 18 months.
                      </p>
                      {canEdit && (
                        <Button variant="primary" onClick={() => connect.mutate()} busy={connect.isPending}>
                          <Link2 className="size-4" aria-hidden />
                          Connect to HMRC
                        </Button>
                      )}
                    </>
                  )}
                  {connect.error && <Alert>{connect.error.message}</Alert>}
                  {status.configured && (
                    <p className="text-xs text-faint">
                      Redirect URI registered with HMRC: <code className="break-all">{status.redirectUri}</code>
                    </p>
                  )}
                </div>
              </>
            )}
          </div>
        </Card>
      </div>

      <ConfirmDialog
        open={confirmingDisconnect}
        title="Disconnect from HMRC?"
        confirmLabel="Disconnect"
        onClose={() => setConfirmingDisconnect(false)}
        onConfirm={async () => {
          await disconnect.mutateAsync();
          setConfirmingDisconnect(false);
        }}
      >
        The app forgets its HMRC sign-in and can’t send updates until someone connects again. To remove the app’s authority at HMRC
        as well, do it in your HMRC online account.
      </ConfirmDialog>
    </>
  );
}
