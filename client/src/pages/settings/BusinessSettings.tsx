import { Briefcase } from 'lucide-react';
import { formatDisplayDate } from '@crafty/shared';
import { BusinessDetailsForm } from '../../components/BusinessDetailsForm';
import { Alert, Card, CardHeader, Spinner } from '../../components/ui';
import { useBusiness, useCanEdit } from '../../lib/queries';
import { SettingsHeading } from './SettingsLayout';

export function BusinessSettings() {
  const canEdit = useCanEdit();
  const { data: business, refetch } = useBusiness();

  return (
    <div className="space-y-6">
      <SettingsHeading
        title="Business Details"
        description="Who you are and what your business does, for your Self Assessment return and the top of printed reports. No VAT number: the app is for businesses that aren’t VAT registered."
      />
      {!business ? (
        <Spinner />
      ) : (
        <>
          {business.isSample && (
            <Alert tone="warning">
              These are the sample data’s made-up details. Change them to your own, or clear the sample data from Settings → Backup and
              Restore, which clears these too.
            </Alert>
          )}
          <Card>
            <CardHeader
              icon={<Briefcase className="size-5 text-accent-soft" aria-hidden />}
              title="Your business"
              action={
                business.updatedAt && (
                  <p className="text-xs text-muted">
                    Last changed by {business.updatedBy} on {formatDisplayDate(business.updatedAt.slice(0, 10))}
                  </p>
                )
              }
            />
            {/* Remounted on every save, so it shows what was saved, including anyone else's change. */}
            <BusinessDetailsForm key={business.updatedAt ?? 'new'} business={business} readOnly={!canEdit} onReload={() => void refetch()} />
          </Card>
        </>
      )}
    </div>
  );
}
