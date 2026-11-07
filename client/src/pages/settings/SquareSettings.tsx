import { useState, type FormEvent } from 'react';
import { KeyRound, Tags } from 'lucide-react';
import { formatDisplayDate, SQUARE_ENVIRONMENTS, squareFeeCategory, squareIncomeCategory, type SquareEnvironment, type SquareStatus } from '@crafty/shared';
import { CategoryOptions } from '../../components/CategoryOptions';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Alert, Badge, Button, Card, CardHeader, Field, Spinner } from '../../components/ui';
import { useCanEdit, useCategories, useSquare, useSquareMutations } from '../../lib/queries';
import { SettingsHeading } from './SettingsLayout';

/** The fees category's choice when none is saved. */
const AUTOMATIC = 'automatic';
const DEVELOPER_APPS = 'https://developer.squareup.com/apps';
const ENVIRONMENT_LABELS: Record<SquareEnvironment, string> = { production: 'Production', sandbox: 'Sandbox (for testing)' };

/** Entering a token: Square checks it before it's saved, and it's never shown again in full. */
function TokenForm({ status, replacing, onDone }: { status: SquareStatus; replacing: boolean; onDone: () => void }) {
  const { save } = useSquareMutations();
  const [token, setToken] = useState('');
  const [environment, setEnvironment] = useState<SquareEnvironment>(status.configured ? status.environment : 'production');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!token.trim()) return;
    save.mutate({ accessToken: token.trim(), environment }, { onSuccess: () => { setToken(''); onDone(); } });
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <ol className="list-decimal space-y-1 pl-5 text-sm text-muted">
        <li>
          Sign in to the{' '}
          <a href={DEVELOPER_APPS} target="_blank" rel="noreferrer" className="text-accent-soft underline-offset-2 hover:underline">
            Square Developer Dashboard
          </a>{' '}
          with your Square account and create an application (any name will do).
        </li>
        <li>Open it, switch to Production at the top, and copy the Production Access token from its Credentials page.</li>
        <li>Paste it here. It can read your Square account, so keep it to yourself.</li>
      </ol>
      <fieldset className="space-y-2">
        <legend className="mb-1.5 text-sm font-medium text-ink">Environment</legend>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          {SQUARE_ENVIRONMENTS.map((env) => (
            <label key={env} className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="radio"
                name="square-environment"
                value={env}
                checked={environment === env}
                onChange={() => setEnvironment(env)}
                className="size-4 accent-[var(--color-accent)]"
              />
              {ENVIRONMENT_LABELS[env]}
            </label>
          ))}
        </div>
      </fieldset>
      <Field label={replacing ? 'New access token' : 'Square access token'} htmlFor="square-token" error={save.error?.message}>
        <input
          id="square-token"
          type="password"
          className="field font-mono"
          value={token}
          placeholder="EAAA…"
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setToken(e.target.value)}
        />
      </Field>
      <div className="flex flex-wrap gap-3">
        <Button type="submit" variant="primary" busy={save.isPending} disabled={!token.trim()}>
          {save.isPending ? 'Checking token…' : 'Save token'}
        </Button>
        {replacing && (
          <Button type="button" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

function TokenCard({ status, canEdit }: { status: SquareStatus; canEdit: boolean }) {
  const { removeToken } = useSquareMutations();
  const [replacing, setReplacing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [saved, setSaved] = useState(false);

  return (
    <Card>
      <CardHeader
        icon={<KeyRound className="size-5 text-accent-soft" />}
        title="Access token"
        action={
          status.configured ? (
            <Badge tone="ok">{status.environment === 'sandbox' ? 'Connected to the sandbox' : 'Connected'}</Badge>
          ) : (
            <Badge>Not set</Badge>
          )
        }
      />
      <div className="space-y-5 px-5 pb-6 sm:px-6">
        {status.configured && (
          <dl className="grid gap-3 text-sm sm:grid-cols-[160px_1fr]">
            {status.merchantName && (
              <>
                <dt className="text-muted">Square account</dt>
                <dd>{status.merchantName}</dd>
              </>
            )}
            <dt className="text-muted">Token</dt>
            <dd className="font-mono break-all">{status.tokenHint}</dd>
            {status.tokenAddedAt && (
              <>
                <dt className="text-muted">Added</dt>
                <dd>
                  {formatDisplayDate(status.tokenAddedAt.slice(0, 10))}
                  {status.tokenAddedBy && ` by ${status.tokenAddedBy}`}
                </dd>
              </>
            )}
          </dl>
        )}

        {saved && (
          <Alert tone="success" onDismiss={() => setSaved(false)}>
            Token checked with Square and saved. Import from Square now shows on the Income page.
          </Alert>
        )}

        {!canEdit ? (
          !status.configured && <p className="text-sm text-muted">Ask an editor to add an access token.</p>
        ) : !status.configured || replacing ? (
          <TokenForm
            status={status}
            replacing={replacing}
            onDone={() => {
              setSaved(true);
              setReplacing(false);
            }}
          />
        ) : (
          <div className="flex flex-wrap gap-3">
            <Button type="button" onClick={() => { setSaved(false); setReplacing(true); }}>
              Replace token
            </Button>
            <Button type="button" variant="softDanger" onClick={() => setConfirmRemove(true)}>
              Remove token
            </Button>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirmRemove}
        title="Remove the access token?"
        confirmLabel="Remove"
        onClose={() => setConfirmRemove(false)}
        onConfirm={async () => {
          setSaved(false);
          await removeToken.mutateAsync();
        }}
      >
        <p>
          Import from Square won’t be offered until a token is added again. What’s already imported stays in your books. The token still works at Square; delete the
          application in the Square Developer Dashboard if you no longer need it.
        </p>
      </ConfirmDialog>
    </Card>
  );
}

function CategoriesCard({ status, canEdit }: { status: SquareStatus; canEdit: boolean }) {
  const { data: categories } = useCategories();
  const { save } = useSquareMutations();
  // Shows a choice straight away while it saves.
  const savingIncome = save.isPending && save.variables?.incomeCategoryId !== undefined;
  const incomeChoice = savingIncome
    ? (save.variables!.incomeCategoryId ?? AUTOMATIC)
    : status.incomeCategoryAutomatic
      ? AUTOMATIC
      : status.incomeCategoryId;
  // What Automatic picks for sales: a custom category named for Square's sales, else Turnover.
  const automaticIncome =
    categories && (squareIncomeCategory(categories) ?? categories.find((c) => c.type === 'INCOME' && !c.isCustom && c.hmrcCode === 'turnover'));
  const savingFee = save.isPending && save.variables?.feeCategoryId !== undefined;
  const feeChoice = savingFee ? (save.variables!.feeCategoryId ?? AUTOMATIC) : status.feeCategoryAutomatic ? AUTOMATIC : status.feeCategoryId;
  const feeCategories = (categories ?? []).filter((c) => c.hmrcCode !== 'depreciation');
  // What Automatic picks: a custom category named for Square's fees, else the standard one.
  const automaticFee =
    categories && (squareFeeCategory(categories) ?? categories.find((c) => c.type === 'EXPENSE' && !c.isCustom && c.hmrcCode === 'financeCharges'));

  return (
    <Card>
      <CardHeader icon={<Tags className="size-5 text-accent-soft" />} title="Categories" />
      <div className="space-y-4 px-5 pb-6 sm:px-6">
        <p className="text-sm text-muted">
          Each payout Square makes to your bank is imported as one income of that day’s card sales, before Square’s fees and less any refunds, and one expense
          for the fees, both dated the day of the sales. Together they come to what reached the bank.
        </p>
        {!categories ? (
          <Spinner />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Sales go under"
              htmlFor="square-income-category"
              hint="Automatic uses a custom category named for Square, such as “Square sales”, or else one for card sales, such as “Card sales”."
            >
              <select
                id="square-income-category"
                className="field"
                value={incomeChoice}
                disabled={!canEdit || save.isPending}
                onChange={(e) => save.mutate({ incomeCategoryId: e.target.value === AUTOMATIC ? null : Number(e.target.value) })}
              >
                <option value={AUTOMATIC}>Automatic{automaticIncome ? `: ${automaticIncome.name}` : ''}</option>
                <CategoryOptions categories={categories} type="INCOME" />
              </select>
            </Field>
            <Field
              label="Square’s fees go under"
              htmlFor="square-fee-category"
              hint="Automatic uses a custom category named for Square’s fees, such as “Square fees”, or else one for card fees, such as “Card fees”."
            >
              <select
                id="square-fee-category"
                className="field"
                value={feeChoice}
                disabled={!canEdit || save.isPending}
                onChange={(e) => save.mutate({ feeCategoryId: e.target.value === AUTOMATIC ? null : Number(e.target.value) })}
              >
                <option value={AUTOMATIC}>Automatic{automaticFee ? `: ${automaticFee.name}` : ''}</option>
                <CategoryOptions categories={feeCategories} type="EXPENSE" />
              </select>
            </Field>
          </div>
        )}
        {save.error && !save.variables?.accessToken && <Alert>{save.error.message}</Alert>}
      </div>
    </Card>
  );
}

export function SquareSettings() {
  const { data: status, isLoading, error } = useSquare();
  const canEdit = useCanEdit();
  return (
    <div className="space-y-6">
      <SettingsHeading
        title="Square Integration"
        description="Import the card sales Square pays into your bank as income, with Square’s fees as an expense."
      />
      {isLoading ? (
        <Spinner />
      ) : error || !status ? (
        <Alert>{error?.message ?? 'Could not load the Square Integration settings'}</Alert>
      ) : (
        <>
          <TokenCard status={status} canEdit={canEdit} />
          <CategoriesCard status={status} canEdit={canEdit} />
        </>
      )}
    </div>
  );
}
