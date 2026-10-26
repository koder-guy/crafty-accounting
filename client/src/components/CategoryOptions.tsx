import type { Category, CategoryType } from '@crafty/shared';

/**
 * <option>s for a category dropdown. A standard MTD category that has custom
 * categories mapped to it becomes a group: the standard category first, then
 * its custom ones, so both stay selectable.
 */
export function CategoryOptions({ categories, type }: { categories: Category[]; type: CategoryType }) {
  const standard = categories.filter((c) => c.type === type && !c.isCustom);
  const custom = categories.filter((c) => c.type === type && c.isCustom);
  return (
    <>
      {standard.map((s) => {
        const mapped = custom.filter((c) => c.hmrcCode === s.hmrcCode);
        if (mapped.length === 0) {
          return (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          );
        }
        return (
          <optgroup key={s.id} label={s.name}>
            <option value={s.id}>{s.name}</option>
            {mapped.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </optgroup>
        );
      })}
    </>
  );
}
