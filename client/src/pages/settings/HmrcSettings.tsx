import { useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { Landmark, Link2, ShieldCheck, Unlink } from 'lucide-react';
import { formatDisplayDate, type HmrcBusiness, type HmrcFraudHeaderCheck, type HmrcStatus } from '@crafty/shared';
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

const businessLabel = (b: HmrcBusiness) => (b.tradingName ? `${b.tradingName} (${b.businessId})` : b.businessId);

/** The self-employment business at HMRC that updates go to, found by asking HMRC. */
function BusinessRow({ status, canEdit }: { status: HmrcStatus; canEdit: boolean }) {
  const { findBusiness, chooseBusiness } = useHmrcMutations();
  const found = findBusiness.data?.businesses;
  const error = findBusiness.error ?? chooseBusiness.error;
  return (
    <>
      <dt className="text-muted">Business</dt>
      <dd className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          {status.business ? (
            <span>{businessLabel(status.business)}</span>
          ) : (
            <span className="text-muted">Not found yet</span>
          )}
          {canEdit && (
            <Button onClick={() => findBusiness.mutate()} busy={findBusiness.isPending} disabled={!status.nino}>
              {status.business ? 'Check again' : 'Find my business'}
            </Button>
          )}
        </div>
        {!status.nino && canEdit && <p className="text-xs text-muted">Save the National Insurance number first.</p>}
        {found && found.length === 0 && (
          <Alert tone="warning">HMRC has no self-employment business for this National Insurance number.</Alert>
        )}
        {found && found.length > 1 && (
          <fieldset className="space-y-2">
            <legend className="mb-1 text-xs text-muted">HMRC has several self-employment businesses. Choose the one for these books:</legend>
            {found.map((b) => (
              <label key={b.businessId} className="flex items-center gap-3">
                <input
                  type="radio"
                  name="hmrc-business"
                  className="size-4 accent-[var(--color-accent)]"
                  checked={status.business?.businessId === b.businessId}
                  onChange={() => chooseBusiness.mutate(b)}
                />
                {businessLabel(b)}
              </label>
            ))}
          </fieldset>
        )}
        {error && <Alert>{error.message}</Alert>}
      </dd>
    </>
  );
}

const CHECK_OUTCOME: Record<string, { tone: 'success' | 'warning' | 'error'; label: string }> = {
  VALID_HEADERS: { tone: 'success', label: 'All headers look valid' },
  POTENTIALLY_INVALID_HEADERS: { tone: 'warning', label: 'Some headers may be wrong' },
  INVALID_HEADERS: { tone: 'error', label: 'Some headers are missing or wrong' },
};

function CheckResult({ check }: { check: HmrcFraudHeaderCheck }) {
  const outcome = CHECK_OUTCOME[check.code] ?? { tone: 'warning' as const, label: check.code };
  const items = [
    ...check.errors.map((e) => ({ ...e, kind: 'Error' })),
    ...check.warnings.map((w) => ({ ...w, kind: 'Advisory' })),
  ];
  return (
    <div className="space-y-3">
      <Alert tone={outcome.tone}>
        <strong>{outcome.label}.</strong> {check.message}
      </Alert>
      {items.length > 0 && (
        <ul className="divide-y divide-line rounded-lg border border-line text-sm">
          {items.map((item, i) => (
            <li key={i} className="space-y-1 px-4 py-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={item.kind === 'Error' ? 'out' : 'warn'}>{item.kind}</Badge>
                <code className="text-xs text-faint">{item.headers.join(', ')}</code>
              </div>
              <p className="text-ink">{item.message}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Sends this browser's fraud prevention headers to HMRC's sandbox test API. */
function FraudHeadersCard() {
  const { checkFraudHeaders } = useHmrcMutations();
  return (
    <Card>
      <CardHeader icon={<ShieldCheck className="size-5 text-accent-soft" />} title="Fraud prevention headers" />
      <div className="space-y-4 px-5 pb-6 sm:px-6">
        <p className="text-sm text-muted">
          HMRC requires details of your browser, device and network with every Making Tax Digital call. Check what this browser sends
          with HMRC’s test service. The app must be subscribed to the Test Fraud Prevention Headers API.
        </p>
        <Button onClick={() => checkFraudHeaders.mutate()} busy={checkFraudHeaders.isPending}>
          Check with HMRC
        </Button>
        {checkFraudHeaders.error && <Alert>{checkFraudHeaders.error.message}</Alert>}
        {checkFraudHeaders.data && <CheckResult check={checkFraudHeaders.data} />}
      </div>
    </Card>
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
                        <BusinessRow status={status} canEdit={canEdit} />
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

        {status?.environment === 'sandbox' && status.configured && <FraudHeadersCard />}
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
