import { PageBody, PageHeader } from '../components/PageHeader';
import { ButtonLink, Card, EmptyState } from '../components/ui';

export function NotFound() {
  return (
    <>
      <PageHeader title="Page not found" subtitle="That page doesn't exist." />
      <PageBody>
        <Card>
          <EmptyState title="Nothing here">
            <ButtonLink to="/" variant="primary" className="mt-4">
              Go to the dashboard
            </ButtonLink>
          </EmptyState>
        </Card>
      </PageBody>
    </>
  );
}
