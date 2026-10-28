import { useState, type FormEvent } from 'react';
import { Pencil, Trash2, UserPlus, Users } from 'lucide-react';
import { formatDisplayDate, type User } from '@crafty/shared';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Alert, Badge, Button, Card, CardHeader, Field, IconButton, Spinner } from '../../components/ui';
import { useMe, useUserMutations, useUsers } from '../../lib/queries';
import { SettingsHeading } from './SettingsLayout';

/** Adds a person, or renames someone and optionally sets a new password. */
function PersonForm({ editing, onDone }: { editing: User | null; onDone: () => void }) {
  const { create, update } = useUserMutations();
  const { data: me } = useMe();
  const [name, setName] = useState(editing?.name ?? '');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const mutation = editing ? update : create;
  const isMe = editing?.id === me?.user?.id;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setError('Enter a name');
    if ((!editing || password) && password.length < 8) return setError('Use a password of at least 8 characters');
    setError(null);
    const onSuccess = () => {
      setName('');
      setPassword('');
      onDone();
    };
    if (editing) {
      update.mutate({ id: editing.id, name: name.trim(), ...(password ? { password } : {}) }, { onSuccess });
    } else {
      create.mutate({ name: name.trim(), password }, { onSuccess });
    }
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-4 px-5 pb-6 sm:px-6">
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Name" htmlFor="person-name" hint="What they type to sign in">
          <input
            id="person-name"
            className="field"
            maxLength={50}
            autoComplete="off"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field
          label={editing ? 'New password' : 'Password'}
          htmlFor="person-password"
          hint={editing ? `Leave blank to keep ${isMe ? 'your' : 'their'} current password` : 'At least 8 characters'}
        >
          <input
            id="person-password"
            type="password"
            className="field"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
      </div>
      {(error || mutation.error) && <Alert>{error ?? mutation.error?.message}</Alert>}
      <div className="flex gap-2">
        <Button type="submit" variant="primary" busy={mutation.isPending}>
          {editing ? 'Save changes' : 'Add person'}
        </Button>
        {editing && (
          <Button type="button" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

export function People() {
  const { data: users, isLoading, error } = useUsers();
  const { data: me } = useMe();
  const { remove } = useUserMutations();
  const [editing, setEditing] = useState<User | null>(null);
  const [toRemove, setToRemove] = useState<User | null>(null);

  return (
    <div className="space-y-6">
      <SettingsHeading
        title="People"
        description="Everyone who can sign in to these books. Each person has their own password and active tax year, and transactions show who added and last changed them."
      />

      {isLoading ? (
        <Spinner />
      ) : error ? (
        <Alert>{error.message}</Alert>
      ) : (
        <>
          <Card>
            <CardHeader
              icon={editing ? <Pencil className="size-5 text-accent-soft" /> : <UserPlus className="size-5 text-accent-soft" />}
              title={editing ? `Edit ${editing.name}` : 'Add a person'}
            />
            <PersonForm key={editing?.id ?? 'new'} editing={editing} onDone={() => setEditing(null)} />
          </Card>

          <Card>
            <CardHeader icon={<Users className="size-5 text-accent-soft" />} title="Who can sign in" />
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs tracking-wide text-muted uppercase">
                  <tr className="border-y border-line">
                    <th scope="col" className="px-4 py-3 text-left font-medium sm:pl-6">Name</th>
                    <th scope="col" className="px-4 py-3 text-left font-medium">Added</th>
                    <th scope="col" className="px-4 py-3 text-right font-medium sm:pr-6">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {(users ?? []).map((u) => {
                    const isMe = u.id === me?.user?.id;
                    return (
                      <tr key={u.id} className={editing?.id === u.id ? 'bg-surface-2/40' : ''}>
                        <td className="px-4 py-3 font-medium text-ink sm:pl-6">
                          {u.name}
                          {isMe && (
                            <span className="ml-2">
                              <Badge tone="accent">You</Badge>
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-muted">{formatDisplayDate(u.createdAt.slice(0, 10))}</td>
                        <td className="px-3 py-2 sm:pr-5">
                          <div className="flex justify-end gap-0.5">
                            <IconButton label={`Edit ${u.name}`} onClick={() => setEditing(u)}>
                              <Pencil className="size-4" />
                            </IconButton>
                            <IconButton
                              label={isMe ? "You can't remove yourself" : `Remove ${u.name}`}
                              tone="danger"
                              disabled={isMe}
                              onClick={() => setToRemove(u)}
                            >
                              <Trash2 className="size-4" />
                            </IconButton>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}

      <ConfirmDialog
        open={toRemove !== null}
        title={`Remove ${toRemove?.name ?? ''}?`}
        confirmLabel="Remove"
        onClose={() => setToRemove(null)}
        onConfirm={async () => {
          await remove.mutateAsync(toRemove!.id);
          if (editing?.id === toRemove!.id) setEditing(null);
        }}
      >
        <p>They'll be signed out straight away and won't be able to sign in again.</p>
        <p>The transactions they added stay, still showing their name.</p>
      </ConfirmDialog>
    </div>
  );
}
