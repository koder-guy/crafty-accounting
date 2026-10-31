import { useState, type FormEvent } from 'react';
import { KeyRound, Pencil, Trash2, UserPlus, Users } from 'lucide-react';
import { formatDisplayDate, ROLE_DESCRIPTIONS, ROLE_LABELS, ROLES, type Role, type User } from '@crafty/shared';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Alert, Badge, Button, Card, CardHeader, Field, IconButton, Spinner } from '../../components/ui';
import { useCanEdit, useMe, useUserMutations, useUsers } from '../../lib/queries';
import { SettingsHeading } from './SettingsLayout';

function RoleChoice({
  value,
  onChange,
  mustStayEditor,
}: {
  value: Role;
  onChange: (role: Role) => void;
  /** The person is the only editor, so they can't be made read-only. */
  mustStayEditor: boolean;
}) {
  return (
    <fieldset className="md:col-span-2">
      <legend className="mb-1.5 text-sm font-medium">Access</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        {ROLES.map((role) => {
          const disabled = mustStayEditor && role === 'viewer';
          return (
            <label
              key={role}
              className={`flex gap-3 rounded-lg border p-3 text-sm transition-colors ${
                disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'
              } ${value === role ? 'border-accent/60 bg-accent-bg' : `border-line ${disabled ? '' : 'hover:border-line-strong'}`}`}
            >
              <input
                type="radio"
                name="person-role"
                value={role}
                aria-label={ROLE_LABELS[role]}
                className="mt-0.5 accent-indigo-500"
                checked={value === role}
                disabled={disabled}
                onChange={() => onChange(role)}
              />
              <span>
                <span className="font-medium text-ink">{ROLE_LABELS[role]}</span>
                <span className="mt-0.5 block text-xs text-muted">{ROLE_DESCRIPTIONS[role]}</span>
              </span>
            </label>
          );
        })}
      </div>
      {mustStayEditor && (
        <p className="mt-1.5 text-xs text-muted">This is the only editor, and there must always be one. Make someone else an editor first.</p>
      )}
    </fieldset>
  );
}

/** Adds a person, or edits someone: username, access and optionally a new password. */
function PersonForm({ editing, editorCount, onDone }: { editing: User | null; editorCount: number; onDone: () => void }) {
  const { create, update } = useUserMutations();
  const { data: me } = useMe();
  const [name, setName] = useState(editing?.name ?? '');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>(editing?.role ?? 'editor');
  const [error, setError] = useState<string | null>(null);
  const mutation = editing ? update : create;
  const isMe = editing?.id === me?.user?.id;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setError('Enter a username');
    if ((!editing || password) && password.length < 8) return setError('Use a password of at least 8 characters');
    setError(null);
    const onSuccess = () => {
      setName('');
      setPassword('');
      setRole('editor');
      onDone();
    };
    if (editing) {
      update.mutate({ id: editing.id, name: name.trim(), role, ...(password ? { password } : {}) }, { onSuccess });
    } else {
      create.mutate({ name: name.trim(), password, role }, { onSuccess });
    }
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-4 px-5 pb-6 sm:px-6">
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Username" htmlFor="person-name" hint="What they type to sign in">
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
        <RoleChoice value={role} onChange={setRole} mustStayEditor={editing?.role === 'editor' && editorCount === 1} />
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

/** For read-only people, who can change their own password but nothing else. */
function OwnPasswordForm({ me }: { me: User }) {
  const { update } = useUserMutations();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setDone(false);
    if (password.length < 8) return setError('Use a password of at least 8 characters');
    setError(null);
    update.mutate(
      { id: me.id, password },
      {
        onSuccess: () => {
          setPassword('');
          setDone(true);
        },
      },
    );
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-4 px-5 pb-6 sm:px-6">
      <Field label="New password" htmlFor="own-password" hint="At least 8 characters">
        <div className="flex flex-wrap gap-3">
          <input
            id="own-password"
            type="password"
            className="field w-64"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <Button type="submit" variant="primary" busy={update.isPending}>
            Change password
          </Button>
        </div>
      </Field>
      {(error || update.error) && <Alert>{error ?? update.error?.message}</Alert>}
      {done && <Alert tone="success">Your password has been changed.</Alert>}
    </form>
  );
}

export function People() {
  const { data: users, isLoading, error } = useUsers();
  const { data: me } = useMe();
  const canEdit = useCanEdit();
  const { remove } = useUserMutations();
  const [editing, setEditing] = useState<User | null>(null);
  const [toRemove, setToRemove] = useState<User | null>(null);

  return (
    <div className="space-y-6">
      <SettingsHeading
        title="People"
        description="Everyone who can sign in to these books. Each person has their own password and active tax year, and transactions show who added and last changed them. Editors can change anything; read-only people can view, export and print."
      />

      {isLoading ? (
        <Spinner />
      ) : error ? (
        <Alert>{error.message}</Alert>
      ) : (
        <>
          {canEdit ? (
            <Card>
              <CardHeader
                icon={editing ? <Pencil className="size-5 text-accent-soft" /> : <UserPlus className="size-5 text-accent-soft" />}
                title={editing ? `Edit ${editing.name}` : 'Add a person'}
              />
              <PersonForm
                key={editing?.id ?? 'new'}
                editing={editing}
                editorCount={(users ?? []).filter((u) => u.role === 'editor').length}
                onDone={() => setEditing(null)}
              />
            </Card>
          ) : (
            me?.user && (
              <Card>
                <CardHeader icon={<KeyRound className="size-5 text-accent-soft" />} title="Change your password" />
                <OwnPasswordForm me={me.user} />
              </Card>
            )
          )}

          <Card>
            <CardHeader icon={<Users className="size-5 text-accent-soft" />} title="Who can sign in" />
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs tracking-wide text-muted uppercase">
                  <tr className="border-y border-line">
                    <th scope="col" className="px-4 py-3 text-left font-medium sm:pl-6">Username</th>
                    <th scope="col" className="px-4 py-3 text-left font-medium">Access</th>
                    <th scope="col" className="px-4 py-3 text-left font-medium">Added</th>
                    {canEdit && <th scope="col" className="px-4 py-3 text-right font-medium sm:pr-6">Actions</th>}
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
                        <td className="px-4 py-3 whitespace-nowrap">
                          <Badge tone={u.role === 'viewer' ? 'warn' : 'neutral'}>{ROLE_LABELS[u.role]}</Badge>
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-muted">{formatDisplayDate(u.createdAt.slice(0, 10))}</td>
                        {canEdit && (
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
                        )}
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
        <p>The transactions they added stay, still showing their username.</p>
      </ConfirmDialog>
    </div>
  );
}
