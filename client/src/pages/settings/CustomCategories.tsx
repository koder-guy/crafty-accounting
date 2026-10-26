import { useState, type FormEvent } from 'react';
import { Pencil, Plus, Tags, Trash2 } from 'lucide-react';
import type { Category } from '@crafty/shared';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, Field, IconButton, Spinner } from '../../components/ui';
import { useCategories, useCategoryMutations } from '../../lib/queries';
import { SettingsHeading } from './SettingsLayout';

const usageLabel = (n: number) => (n === 0 ? 'Not used' : `${n} ${n === 1 ? 'use' : 'uses'}`);

function CategoryForm({
  standard,
  editing,
  onDone,
}: {
  standard: Category[];
  editing: Category | null;
  onDone: () => void;
}) {
  const { create, update } = useCategoryMutations();
  const mappedTo = editing ? standard.find((s) => s.type === editing.type && s.hmrcCode === editing.hmrcCode) : undefined;
  const [name, setName] = useState(editing?.name ?? '');
  const [mapsTo, setMapsTo] = useState(mappedTo ? String(mappedTo.id) : '');
  const [error, setError] = useState<string | null>(null);
  const mutation = editing ? update : create;
  const locked = Boolean(editing && editing.usageCount > 0);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setError('Enter a name');
    if (!mapsTo) return setError('Choose the MTD category it maps to');
    setError(null);
    const input = { name: name.trim(), mapsToCategoryId: Number(mapsTo) };
    const onSuccess = () => {
      setName('');
      setMapsTo('');
      onDone();
    };
    if (editing) update.mutate({ id: editing.id, ...input }, { onSuccess });
    else create.mutate(input, { onSuccess });
  };

  const group = (type: Category['type'], label: string) => (
    <optgroup label={label}>
      {standard
        .filter((s) => s.type === type)
        .map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
    </optgroup>
  );

  return (
    <form onSubmit={submit} noValidate className="space-y-4 px-5 pb-6 sm:px-6">
      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <Field label="Name" htmlFor="category-name">
          <input
            id="category-name"
            className="field"
            maxLength={60}
            placeholder="Printer filament"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field
          label="Maps to MTD category"
          htmlFor="category-maps-to"
          hint={locked ? `Used ${editing!.usageCount} times, so the MTD category can't change.` : undefined}
        >
          <select
            id="category-maps-to"
            className="field"
            value={mapsTo}
            disabled={locked}
            onChange={(e) => setMapsTo(e.target.value)}
          >
            <option value="">Choose…</option>
            {group('INCOME', 'Income')}
            {group('EXPENSE', 'Expenses')}
          </select>
        </Field>
      </div>
      {(error || mutation.error) && <Alert>{error ?? mutation.error?.message}</Alert>}
      <div className="flex gap-2">
        <Button type="submit" variant="primary" busy={mutation.isPending}>
          {editing ? 'Save changes' : 'Add category'}
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

export function CustomCategories() {
  const { data: categories, isLoading, error } = useCategories();
  const { remove } = useCategoryMutations();
  const [editing, setEditing] = useState<Category | null>(null);
  const [toDelete, setToDelete] = useState<Category | null>(null);

  const standard = (categories ?? []).filter((c) => !c.isCustom);
  const custom = (categories ?? []).filter((c) => c.isCustom);
  const standardFor = (c: Category) => standard.find((s) => s.type === c.type && s.hmrcCode === c.hmrcCode);

  return (
    <div className="space-y-6">
      <SettingsHeading
        title="Custom categories"
        description="Create your own categories, like “Printer filament”. Each one maps to a standard MTD category, so your MTD figures stay the same."
      />

      {isLoading ? (
        <Spinner />
      ) : error ? (
        <Alert>{error.message}</Alert>
      ) : (
        <>
          <Card>
            <CardHeader
              icon={editing ? <Pencil className="size-5 text-accent-soft" /> : <Plus className="size-5 text-accent-soft" />}
              title={editing ? `Edit “${editing.name}”` : 'Add a category'}
            />
            <CategoryForm key={editing?.id ?? 'new'} standard={standard} editing={editing} onDone={() => setEditing(null)} />
          </Card>

          <Card>
            <CardHeader icon={<Tags className="size-5 text-accent-soft" />} title="Your custom categories" />
            {custom.length === 0 ? (
              <EmptyState title="No custom categories yet">
                Add one above. It will appear in the category menus, grouped under the MTD category it maps to.
              </EmptyState>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-sm">
                  <thead className="text-xs tracking-wide text-muted uppercase">
                    <tr className="border-y border-line">
                      <th scope="col" className="px-4 py-3 text-left font-medium sm:pl-6">Name</th>
                      <th scope="col" className="px-4 py-3 text-left font-medium">Type</th>
                      <th scope="col" className="px-4 py-3 text-left font-medium">Maps to</th>
                      <th scope="col" className="px-4 py-3 text-left font-medium">Used</th>
                      <th scope="col" className="px-4 py-3 text-right font-medium sm:pr-6">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {custom.map((c) => (
                      <tr key={c.id} className={editing?.id === c.id ? 'bg-surface-2/40' : ''}>
                        <td className="px-4 py-3 font-medium text-ink sm:pl-6">{c.name}</td>
                        <td className="px-4 py-3">
                          <Badge tone={c.type === 'INCOME' ? 'ok' : 'out'}>{c.type === 'INCOME' ? 'Income' : 'Expense'}</Badge>
                        </td>
                        <td className="px-4 py-3 text-muted">
                          {standardFor(c)?.name} <span className="ml-1 font-mono text-xs text-faint">{c.hmrcCode}</span>
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-muted">{usageLabel(c.usageCount)}</td>
                        <td className="px-3 py-2 sm:pr-5">
                          <div className="flex justify-end gap-0.5">
                            <IconButton label={`Edit ${c.name}`} onClick={() => setEditing(c)}>
                              <Pencil className="size-4" />
                            </IconButton>
                            <IconButton label={`Delete ${c.name}`} tone="danger" onClick={() => setToDelete(c)}>
                              <Trash2 className="size-4" />
                            </IconButton>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}

      <ConfirmDialog
        open={toDelete !== null}
        title={`Delete “${toDelete?.name ?? ''}”?`}
        confirmLabel="Delete category"
        onClose={() => setToDelete(null)}
        onConfirm={async () => {
          await remove.mutateAsync(toDelete!.id);
          if (editing?.id === toDelete!.id) setEditing(null);
        }}
      >
        {toDelete &&
          (toDelete.usageCount > 0 ? (
            <>
              <p>
                It's used {toDelete.usageCount} {toDelete.usageCount === 1 ? 'time' : 'times'}. Those transactions will be moved to{' '}
                <strong className="text-ink">{standardFor(toDelete)?.name}</strong>.
              </p>
              <p>Your MTD totals won't change, but the custom name will no longer show on them.</p>
            </>
          ) : (
            <p>It isn't used by any transactions.</p>
          ))}
      </ConfirmDialog>
    </div>
  );
}
