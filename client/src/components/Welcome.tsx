import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { Layers, Sparkles, Wallet } from 'lucide-react';
import { APP_NAME } from '@crafty/shared';
import { useCanEdit, useLoadSampleData, useSampleData } from '../lib/queries';
import { Alert, Button, ButtonLink, Card } from './ui';

function Option({ icon, title, children, action }: { icon: ReactNode; title: string; children: ReactNode; action: ReactNode }) {
  return (
    <div className="flex flex-col rounded-xl border border-line bg-page/40 p-5">
      <div className="mb-3 flex size-10 items-center justify-center rounded-xl bg-accent-bg text-accent-soft">{icon}</div>
      <h3 className="font-semibold text-white">{title}</h3>
      <div className="mt-1.5 flex-1 text-sm text-muted">{children}</div>
      <div className="mt-5">{action}</div>
    </div>
  );
}

/** Shown on the dashboard when there are no tax years yet. */
export function Welcome() {
  const canEdit = useCanEdit();
  const load = useLoadSampleData();
  const { data: sample } = useSampleData();

  if (!canEdit) {
    return (
      <Card className="p-6 sm:p-8">
        <h2 className="text-xl font-bold text-white">Welcome to {APP_NAME}</h2>
        <p className="mt-1 text-sm text-muted">There are no tax years yet. Once an editor sets up the books, they'll appear here.</p>
      </Card>
    );
  }

  return (
    <Card className="p-6 sm:p-8">
      <div className="flex items-center gap-3">
        <div className="flex size-11 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-indigo-500">
          <Wallet className="size-6 text-white" aria-hidden />
        </div>
        <div>
          <h2 className="text-xl font-bold text-white">Welcome to {APP_NAME}</h2>
          <p className="text-sm text-muted">There are no tax years yet. How would you like to start?</p>
        </div>
      </div>

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <Option
          icon={<Layers className="size-5" aria-hidden />}
          title="Start your books"
          action={
            <ButtonLink to="/settings/tax-years" variant="primary">
              Create a tax year
            </ButtonLink>
          }
        >
          Create a UK tax year (6 April to 5 April), then add your incoming and outgoing transactions.
        </Option>
        <Option
          icon={<Sparkles className="size-5" aria-hidden />}
          title="Explore with sample data"
          action={
            <Button onClick={() => load.mutate()} busy={load.isPending} disabled={sample?.canLoad === false}>
              Load sample data
            </Button>
          }
        >
          Fill the app with two tax years of made-up craft fair sales, purchases, documents and custom categories, so you can try
          everything out. Clear it afterwards from{' '}
          <Link to="/settings/backup" className="text-accent-soft hover:underline">
            Settings → Backup and restore
          </Link>
          .
        </Option>
      </div>

      {load.error && (
        <div className="mt-5">
          <Alert>{load.error.message}</Alert>
        </div>
      )}
    </Card>
  );
}

/** Reminder on the dashboard while the sample data is in use. */
export function SampleDataNotice() {
  const { data } = useSampleData();
  if (!data?.loaded) return null;
  return (
    <Alert tone="warning">
      You're looking at <strong>sample data</strong>. When you're ready for your own books, clear it with{' '}
      <Link to="/settings/backup" className="font-medium underline">
        Start again with an empty database
      </Link>{' '}
      in Settings → Backup and restore.
    </Alert>
  );
}
