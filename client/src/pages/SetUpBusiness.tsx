import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Briefcase, Sparkles, Upload } from 'lucide-react';
import { APP_NAME, type BusinessResponse } from '@crafty/shared';
import { BusinessDetailsForm } from '../components/BusinessDetailsForm';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Alert, Button } from '../components/ui';
import { api } from '../lib/api';
import { useCanEdit, useLoadSampleData, useLogout, useMe, useSampleData, useTaxYears } from '../lib/queries';

function Badge() {
  return (
    <div className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-500 to-indigo-500 shadow-lg shadow-indigo-900/40">
      <Briefcase className="size-6 text-white" aria-hidden />
    </div>
  );
}

/**
 * Shown instead of the app until the business details are saved (the server refuses other changes until then).
 * Editors fill them in, restore a backup that has them, or load the sample data's made-up business.
 */
export function SetUpBusiness({ business }: { business: BusinessResponse }) {
  const canEdit = useCanEdit();
  const { data: me } = useMe();
  const logout = useLogout();
  const qc = useQueryClient();
  const { data: sample } = useSampleData();
  const { data: years } = useTaxYears();
  const load = useLoadSampleData();
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const hasBooks = (years?.taxYears.length ?? 0) > 0;

  const restore = async (chosen: File) => {
    const form = new FormData();
    form.append('file', chosen, chosen.name);
    await api.post('/restore', form);
    setFile(null);
    await qc.invalidateQueries();
  };

  const restoreNow = async (chosen: File) => {
    setRestoreError(null);
    setRestoring(true);
    try {
      await restore(chosen);
    } catch (err) {
      setRestoreError((err as Error).message);
    } finally {
      setRestoring(false);
    }
  };

  const signOut = (
    <Button type="button" variant="ghost" onClick={() => logout.mutate()}>
      Sign out
    </Button>
  );

  if (!canEdit) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <div className="card w-full max-w-sm p-8 text-center">
          <div className="mb-4 flex justify-center">
            <Badge />
          </div>
          <h1 className="text-xl font-bold text-white">Not set up yet</h1>
          <p className="mt-2 text-sm text-muted">
            {APP_NAME} needs the business details before it can be used. Ask an editor to sign in and fill them in.
          </p>
          <div className="mt-6">{signOut}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen px-4 py-10">
      <div className="mx-auto max-w-3xl space-y-6">
        <div className="flex items-center gap-4">
          <Badge />
          <div>
            <h1 className="text-xl font-bold text-white">Set up your business</h1>
            <p className="mt-1 text-sm text-muted">
              Welcome to {APP_NAME}{me?.user ? `, ${me.user.name}` : ''}.{' '}
              {hasBooks
                ? 'Your books are safe: the app now keeps your business details too, so add them before carrying on.'
                : 'Before adding any income or expenses, tell the app about your business.'}{' '}
              Only the fields not marked optional are needed now; the rest can be added later in Settings → Business Details.
            </p>
          </div>
        </div>

        <div className="card">
          <BusinessDetailsForm business={business} submitLabel="Save and continue" extraActions={signOut} />
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="card flex flex-col p-5">
            <div className="mb-2 flex items-center gap-2 font-semibold text-white">
              <Upload className="size-4 text-accent-soft" aria-hidden />
              Moving from another install?
            </div>
            <p className="flex-1 text-sm text-muted">Restore a backup (.zip or .sql). Its business details come with it.</p>
            <input
              ref={fileInput}
              type="file"
              accept=".zip,.sql"
              className="hidden"
              onChange={(e) => {
                const chosen = e.target.files?.[0];
                e.target.value = '';
                if (!chosen) return;
                // Restoring replaces the books, so ask first if there are any.
                if (hasBooks) setFile(chosen);
                else void restoreNow(chosen);
              }}
            />
            <div className="mt-4">
              <Button type="button" busy={restoring} onClick={() => fileInput.current?.click()}>
                Restore a backup…
              </Button>
            </div>
            {restoreError && (
              <div className="mt-3">
                <Alert>{restoreError}</Alert>
              </div>
            )}
          </div>
          {sample?.canLoad && (
            <div className="card flex flex-col p-5">
              <div className="mb-2 flex items-center gap-2 font-semibold text-white">
                <Sparkles className="size-4 text-accent-soft" aria-hidden />
                Just looking around?
              </div>
              <p className="flex-1 text-sm text-muted">
                Load the sample data: a made-up craft business with five years of books. Clearing it later brings you back here.
              </p>
              <div className="mt-4">
                <Button type="button" busy={load.isPending} onClick={() => load.mutate()}>
                  Load sample data
                </Button>
              </div>
              {load.error && (
                <div className="mt-3">
                  <Alert>{load.error.message}</Alert>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={file !== null}
        title="Replace all data with this backup?"
        confirmLabel="Restore backup"
        requireText="RESTORE"
        onClose={() => setFile(null)}
        onConfirm={() => restore(file!)}
      >
        <p>
          Everything currently in the app will be replaced by <strong className="break-words text-ink">{file?.name}</strong>.
        </p>
      </ConfirmDialog>
    </div>
  );
}
