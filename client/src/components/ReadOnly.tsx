import type { ReactNode } from 'react';
import { useCanEdit } from '../lib/queries';
import { PageBody, PageHeader } from './PageHeader';
import { Alert } from './ui';

export function ReadOnlyNotice({ children }: { children?: ReactNode }) {
  return (
    <Alert tone="warning">{children ?? 'Your account is read-only, so you can view and export the books but not change them.'}</Alert>
  );
}

/** Wraps a page only editors can use (add and edit forms, backups); read-only people see a notice instead. */
export function EditorOnly({ title, children }: { title: string; children: ReactNode }) {
  if (useCanEdit()) return children;
  return (
    <>
      <PageHeader title={title} />
      <PageBody>
        <ReadOnlyNotice>Your account is read-only, so you can't use this page. Ask an editor to make changes.</ReadOnlyNotice>
      </PageBody>
    </>
  );
}
