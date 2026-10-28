import { useState, type FormEvent } from 'react';
import { Car, Gauge, Pencil, Plus, Route, Trash2 } from 'lucide-react';
import {
  formatDisplayDate,
  formatGBP,
  formatMiles,
  isDateInTaxYear,
  MILEAGE_RATE_LABELS,
  MILEAGE_RATES,
  parseMilesToTenths,
  tenthsToMiles,
  todayIso,
  VEHICLE_LABELS,
  VEHICLES,
  type MileageTrip,
  type TaxYear,
  type Vehicle,
} from '@crafty/shared';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ExportCsvButton } from '../components/transactions';
import { ChangedElsewhere, dateInYear, recordedBy, yearRangeHint } from '../components/FormShell';
import { NoTaxYear } from '../components/NoTaxYear';
import { PageBody, PageHeader } from '../components/PageHeader';
import { Alert, Button, Card, CardHeader, EmptyState, Field, IconButton, Spinner } from '../components/ui';
import { useActiveTaxYear, useMileage, useMileageMutations } from '../lib/queries';

function TripForm({ taxYear, editing, onDone }: { taxYear: TaxYear; editing: MileageTrip | null; onDone: () => void }) {
  const { save } = useMileageMutations();
  const today = todayIso();
  const [date, setDate] = useState(editing?.date ?? (isDateInTaxYear(today, taxYear) ? today : ''));
  const [miles, setMiles] = useState(editing ? tenthsToMiles(editing.distanceTenths) : '');
  const [vehicle, setVehicle] = useState<Vehicle>(editing?.vehicle ?? 'car');
  const [description, setDescription] = useState(editing?.description ?? '');
  const [notes, setNotes] = useState(editing?.notes ?? '');
  const [errors, setErrors] = useState<Partial<Record<'date' | 'miles' | 'description', string>>>({});

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const distanceTenths = parseMilesToTenths(miles);
    const dateCheck = dateInYear(taxYear)(date);
    const found = {
      date: dateCheck === true ? undefined : dateCheck,
      miles: distanceTenths === null ? 'Enter the miles, e.g. 23.5' : undefined,
      description: description.trim() ? undefined : 'Say where you went and why',
    };
    setErrors(found);
    if (found.date || found.miles || found.description) return;
    save.mutate(
      {
        id: editing?.id,
        taxYearId: taxYear.id,
        date,
        description: description.trim(),
        vehicle,
        distanceTenths: distanceTenths!,
        notes: notes.trim() || null,
        expectedUpdatedAt: editing?.updatedAt,
      },
      {
        onSuccess: () => {
          if (!editing) {
            // Keep the date and vehicle: several trips are often entered for the same day.
            setMiles('');
            setDescription('');
            setNotes('');
          }
          onDone();
        },
      },
    );
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-4 px-5 pb-6 sm:px-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Field label="Date" htmlFor="trip-date" error={errors.date} hint={yearRangeHint(taxYear)}>
          <input
            id="trip-date"
            type="date"
            className="field"
            min={taxYear.startDate}
            max={taxYear.endDate}
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </Field>
        <Field label="Miles" htmlFor="trip-miles" error={errors.miles} hint="The whole journey, there and back">
          <input
            id="trip-miles"
            inputMode="decimal"
            placeholder="0.0"
            className="field tabular"
            value={miles}
            onChange={(e) => setMiles(e.target.value)}
          />
        </Field>
        <Field label="Vehicle" htmlFor="trip-vehicle" className="sm:col-span-2" hint={MILEAGE_RATE_LABELS[vehicle]}>
          <select id="trip-vehicle" className="field" value={vehicle} onChange={(e) => setVehicle(e.target.value as Vehicle)}>
            {VEHICLES.map((v) => (
              <option key={v} value={v}>
                {VEHICLE_LABELS[v]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Journey" htmlFor="trip-description" error={errors.description} className="sm:col-span-2" hint="Where you went and why">
          <input
            id="trip-description"
            className="field"
            maxLength={300}
            placeholder="Home to Thame Craft Show and back"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        <Field label="Notes" htmlFor="trip-notes" className="sm:col-span-2">
          <input id="trip-notes" className="field" maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </div>
      {save.error && <Alert>{save.error.message}</Alert>}
      <div className="flex gap-2">
        <Button type="submit" variant="primary" busy={save.isPending}>
          {editing ? 'Save changes' : 'Add trip'}
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

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <Card className="p-5">
      <div className="eyebrow">{label}</div>
      <div className="tabular mt-2 text-2xl font-bold text-white">{value}</div>
      <div className="mt-1 text-xs text-muted">{sub}</div>
    </Card>
  );
}

export function Mileage() {
  const { taxYear, isLoading: yearLoading } = useActiveTaxYear();
  const { data, isLoading, error } = useMileage(taxYear?.id);
  const { remove } = useMileageMutations();
  const [editing, setEditing] = useState<MileageTrip | null>(null);
  const [toDelete, setToDelete] = useState<MileageTrip | null>(null);

  // If someone else saves the trip being edited, offer their version rather than overwriting it.
  const latest = editing ? data?.trips.find((t) => t.id === editing.id) : undefined;
  const carMilesLeft = data ? Math.max(0, MILEAGE_RATES.car.thresholdMiles * 10 - data.totals.carDistanceTenths) : 0;

  return (
    <>
      <PageHeader
        title="Mileage"
        actions={
          taxYear &&
          data &&
          data.trips.length > 0 && (
            <ExportCsvButton href={`/api/mileage/export.csv?taxYearId=${taxYear.id}`} />
          )
        }
      />
      <PageBody>
        {yearLoading || (taxYear && isLoading) ? (
          <Spinner />
        ) : !taxYear ? (
          <NoTaxYear />
        ) : error || !data ? (
          <Alert>{error?.message ?? 'Could not load mileage'}</Alert>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-3">
              <Stat label="Business miles" value={formatMiles(data.totals.distanceTenths)} sub={`${data.trips.length} trips this tax year`} />
              <Stat label="Mileage claim" value={formatGBP(data.totals.claimPence)} sub="Counted as car, van and travel expenses" />
              <Stat
                label="Left at 45p"
                value={formatMiles(carMilesLeft)}
                sub={carMilesLeft > 0 ? 'Car and van miles before the 25p rate' : 'Car and van miles are now claimed at 25p'}
              />
            </div>

            <Alert tone="warning">
              The mileage rate covers all the running costs of the vehicle (fuel, insurance, servicing, repairs). Don't also record
              those costs as outgoing for the same vehicle. Parking, tolls and train fares can still go in Outgoing.
            </Alert>

            {editing && latest && latest.updatedAt !== editing.updatedAt && (
              <ChangedElsewhere by={latest.updatedBy} onLoad={() => setEditing(latest)} />
            )}

            <Card>
              <CardHeader
                icon={editing ? <Pencil className="size-5 text-accent-soft" /> : <Plus className="size-5 text-accent-soft" />}
                title={editing ? 'Edit trip' : 'Add a trip'}
              />
              <TripForm key={editing ? `${editing.id}-${editing.updatedAt}` : 'new'} taxYear={taxYear} editing={editing} onDone={() => setEditing(null)} />
            </Card>

            <Card>
              <CardHeader icon={<Route className="size-5 text-accent-soft" />} title="Trips" />
              {data.trips.length === 0 ? (
                <EmptyState icon={<Car className="size-8" />} title="No trips yet">
                  Add the journeys you make for the business, such as driving to craft fairs or to buy supplies. Commuting to a regular
                  workplace doesn't count.
                </EmptyState>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[640px] text-sm">
                    <thead className="text-xs tracking-wide text-muted uppercase">
                      <tr className="border-y border-line">
                        <th scope="col" className="px-4 py-3 text-left font-medium sm:pl-6">Date</th>
                        <th scope="col" className="px-4 py-3 text-left font-medium">Journey</th>
                        <th scope="col" className="px-4 py-3 text-left font-medium">Vehicle</th>
                        <th scope="col" className="px-4 py-3 text-right font-medium">Miles</th>
                        <th scope="col" className="px-4 py-3 text-right font-medium">Claim</th>
                        <th scope="col" className="px-4 py-3 text-right font-medium sm:pr-6">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {data.trips.map((t) => (
                        <tr key={t.id} className={editing?.id === t.id ? 'bg-surface-2/40' : ''}>
                          <td className="px-4 py-3 whitespace-nowrap text-muted sm:pl-6">{formatDisplayDate(t.date)}</td>
                          <td className="px-4 py-3">
                            <div className="font-medium text-ink">{t.description}</div>
                            {(t.notes || t.createdBy) && (
                              <div className="text-xs text-muted">
                                {[t.notes, t.createdBy && `Added by ${recordedBy(t.createdBy, t.createdAt)}`].filter(Boolean).join(' · ')}
                              </div>
                            )}
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap text-muted">{VEHICLE_LABELS[t.vehicle]}</td>
                          <td className="tabular px-4 py-3 text-right">{tenthsToMiles(t.distanceTenths)}</td>
                          <td className="tabular px-4 py-3 text-right text-out-soft">{formatGBP(t.claimPence)}</td>
                          <td className="px-3 py-2 sm:pr-5">
                            <div className="flex justify-end gap-0.5">
                              <IconButton label={`Edit trip on ${formatDisplayDate(t.date)}`} onClick={() => setEditing(t)}>
                                <Pencil className="size-4" />
                              </IconButton>
                              <IconButton label={`Delete trip on ${formatDisplayDate(t.date)}`} tone="danger" onClick={() => setToDelete(t)}>
                                <Trash2 className="size-4" />
                              </IconButton>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t border-line-strong font-semibold">
                        <td colSpan={3} className="px-4 py-3 text-right text-muted sm:pl-6">
                          Total
                        </td>
                        <td className="tabular px-4 py-3 text-right">{tenthsToMiles(data.totals.distanceTenths)}</td>
                        <td className="tabular px-4 py-3 text-right text-out-soft">{formatGBP(data.totals.claimPence)}</td>
                        <td />
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </Card>

            <p className="flex items-start gap-2 text-xs text-faint">
              <Gauge className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              HMRC approved mileage rates: cars and vans 45p a mile for the first 10,000 business miles in a tax year and 25p after
              that, motorcycles 24p and bicycles 20p. Claims are worked out in date order through the tax year.
            </p>
          </>
        )}
      </PageBody>

      <ConfirmDialog
        open={toDelete !== null}
        title="Delete this trip?"
        confirmLabel="Delete trip"
        onClose={() => setToDelete(null)}
        onConfirm={async () => {
          await remove.mutateAsync(toDelete!.id);
          if (editing?.id === toDelete!.id) setEditing(null);
        }}
      >
        {toDelete && (
          <p>
            {toDelete.description} on {formatDisplayDate(toDelete.date)}, {formatMiles(toDelete.distanceTenths)} ({formatGBP(toDelete.claimPence)}).
            This can't be undone.
          </p>
        )}
      </ConfirmDialog>
    </>
  );
}
