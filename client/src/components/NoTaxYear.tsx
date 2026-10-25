import { Layers } from 'lucide-react';
import { ButtonLink, Card, EmptyState } from './ui';

export function NoTaxYear() {
  return (
    <Card>
      <EmptyState icon={<Layers className="size-10" />} title="No tax year yet">
        <p>Create a UK tax year (6 April to 5 April) to start recording transactions.</p>
        <ButtonLink to="/tax-years" variant="primary" className="mt-5">
          Manage tax years
        </ButtonLink>
      </EmptyState>
    </Card>
  );
}
