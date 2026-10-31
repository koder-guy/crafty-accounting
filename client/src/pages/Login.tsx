import { useState, type FormEvent } from 'react';
import { LockKeyhole, UserRound, Wallet } from 'lucide-react';
import { APP_NAME } from '@crafty/shared';
import { Alert, Button } from '../components/ui';
import { useLogin } from '../lib/queries';

export function Login() {
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const login = useLogin();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim() && password) login.mutate({ name: name.trim(), password });
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <form onSubmit={submit} className="card w-full max-w-sm p-8">
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="mb-4 flex size-14 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-500 to-indigo-500 shadow-lg shadow-indigo-900/40">
            <Wallet className="size-7 text-white" aria-hidden />
          </div>
          <h1 className="text-xl font-bold text-white">{APP_NAME}</h1>
          <p className="mt-1 text-sm text-muted">Sign in to your books</p>
        </div>
        <label htmlFor="username" className="mb-1.5 block text-sm font-medium">
          Username
        </label>
        <div className="relative mb-4">
          <UserRound className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" aria-hidden />
          <input
            id="username"
            autoComplete="username"
            autoCapitalize="none"
            autoFocus
            className="field pl-9"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <label htmlFor="password" className="mb-1.5 block text-sm font-medium">
          Password
        </label>
        <div className="relative">
          <LockKeyhole className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" aria-hidden />
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            className="field pl-9"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {login.error && (
          <div className="mt-4">
            <Alert>{login.error.message}</Alert>
          </div>
        )}
        <Button type="submit" variant="primary" className="mt-6 w-full" busy={login.isPending} disabled={!name.trim() || !password}>
          Sign in
        </Button>
      </form>
    </div>
  );
}
