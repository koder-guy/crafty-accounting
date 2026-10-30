import { useState, type FormEvent } from 'react';
import { KeyRound, LockKeyhole } from 'lucide-react';
import { APP_NAME } from '@crafty/shared';
import { Alert, Button } from '../components/ui';
import { useChooseNewPassword, useLogout, useMe } from '../lib/queries';

/** Shown instead of the app to someone who signed in with the default password, until they choose their own. */
export function ChooseNewPassword() {
  const { data: me } = useMe();
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const choose = useChooseNewPassword();
  const logout = useLogout();

  const tooShort = password.length > 0 && password.length < 8;
  const mismatch = again.length > 0 && again !== password;
  const ready = password.length >= 8 && again === password;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (ready && me?.user) choose.mutate({ id: me.user.id, password });
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <form onSubmit={submit} className="card w-full max-w-sm p-8">
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="mb-4 flex size-14 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-500 to-indigo-500 shadow-lg shadow-indigo-900/40">
            <KeyRound className="size-7 text-white" aria-hidden />
          </div>
          <h1 className="text-xl font-bold text-white">Choose a new password</h1>
          <p className="mt-2 text-sm text-muted">
            Welcome to {APP_NAME}, {me?.user?.name}. You signed in with the default password, so choose your own before carrying on.
          </p>
        </div>
        <label htmlFor="new-password" className="mb-1.5 block text-sm font-medium">
          New password
        </label>
        <div className="relative">
          <LockKeyhole className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" aria-hidden />
          <input
            id="new-password"
            type="password"
            autoComplete="new-password"
            autoFocus
            className="field pl-9"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <p className={`mt-1.5 text-xs ${tooShort ? 'text-out-soft' : 'text-faint'}`}>At least 8 characters.</p>
        <label htmlFor="new-password-again" className="mt-4 mb-1.5 block text-sm font-medium">
          New password again
        </label>
        <div className="relative">
          <LockKeyhole className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" aria-hidden />
          <input
            id="new-password-again"
            type="password"
            autoComplete="new-password"
            className="field pl-9"
            value={again}
            onChange={(e) => setAgain(e.target.value)}
          />
        </div>
        {mismatch && <p className="mt-1.5 text-xs text-out-soft">The passwords don’t match.</p>}
        {choose.error && (
          <div className="mt-4">
            <Alert>{choose.error.message}</Alert>
          </div>
        )}
        <Button type="submit" variant="primary" className="mt-6 w-full" busy={choose.isPending} disabled={!ready}>
          Save and continue
        </Button>
        <Button type="button" variant="ghost" className="mt-2 w-full" onClick={() => logout.mutate()}>
          Sign out
        </Button>
      </form>
    </div>
  );
}
