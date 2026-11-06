import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Car, Copy, Info, Pencil, Plus, Route, Trash2 } from 'lucide-react';
import {
  formatDisplayDate,
  formatGBP,
  formatMiles,
  isDateInTaxYear,
  mileageRateLabels,
  mileageRatesFor,
  parseMilesToTenths,
  tenthsToMiles,
  todayIso,
  VEHICLE_LABELS,
  VEHICLES,
  type MileageTrip,
  type TaxYear,
  type Vehicle,
} from '@crafty/shared';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Pagination, usePagination } from '../../components/Pagination';
import { MileageCheckAlert } from '../../components/MileageCheckAlert';
import { ExportMenu } from '../../components/transactions';
import { DateInput } from '../../components/DateInput';
import { ChangedElsewhere, dateInYear, duplicateDate, recordedBy, yearRangeHint } from '../../components/FormShell';
import { NoTaxYear } from '../../components/NoTaxYear';
import { SectionHeading } from '../../components/SectionLayout';
import { SubmittedFiguresNotice } from '../../components/SubmittedFiguresNotice';
import { ClaimStats, RatesUsed, Stat } from './ClaimStats';
import { Alert, Button, Card, CardHeader, DismissibleAlert, EmptyState, Field, IconButton, Spinner } from '../../components/ui';
import { useActiveTaxYear, useCanEdit, useMileage, useMileageMutations } from '../../lib/queries';

/** One line per vehicle type, with its number of trips, under a stat box's figure. */
function VehicleBreakdown({ rows }: { rows: { vehicle: Vehicle; trips: number; value: string }[] }) {
  return (
    <dl className="mt-3 space-y-1 border-t border-line pt-2 text-xs">
      {rows.map(({ vehicle, trips, value }) => (
        <div key={vehicle} className="flex justify-between gap-3">
          <dt className="text-muted">
            {VEHICLE_LABELS[vehicle]} · {trips} {trips === 1 ? 'trip' : 'trips'}
          </dt>
          <dd className="tabular font-semibold whitespace-nowrap text-ink">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Adds a trip (blank, or copied from `copyOf`) or edits one. */
function TripForm({
  taxYear,
  editing,
  copyOf,
  onDone,
}: {
  taxYear: TaxYear;
  editing: MileageTrip | null;
  copyOf: MileageTrip | null;
  onDone: () => void;
}) {
  const { save } = useMileageMutations();
  const today = todayIso();
  const from = editing ?? copyOf;
  const [date, setDate] = useState(
    editing?.date ?? (copyOf ? duplicateDate(copyOf.date, taxYear) : isDateInTaxYear(today, taxYear) ? today : ''),
  );
  const [miles, setMiles] = useState(from ? tenthsToMiles(from.distanceTenths) : '');
  const [vehicle, setVehicle] = useState<Vehicle>(from?.vehicle ?? 'car');
  const [description, setDescription] = useState(from?.description ?? '');
  const [notes, setNotes] = useState(from?.notes ?? '');
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
          <DateInput id="trip-date" min={taxYear.startDate} max={taxYear.endDate} value={date} onChange={setDate} />
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
        <Field label="Vehicle" htmlFor="trip-vehicle" className="sm:col-span-2" hint={mileageRateLabels(mileageRatesFor(taxYear.label))[vehicle]}>
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
            placeholder="Home to a client in Oxford and back"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        <Field label="Notes" htmlFor="trip-notes" className="sm:col-span-2">
          <input id="trip-notes" className="field" maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </div>
      <SubmittedFiguresNotice taxYearId={taxYear.id} dates={[date, editing?.date]} />
      {save.error && <Alert>{save.error.message}</Alert>}
      <div className="flex gap-2">
        <Button type="submit" variant="primary" busy={save.isPending}>
          {editing ? 'Save changes' : 'Add trip'}
        </Button>
        {(editing || copyOf) && (
          <Button type="button" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

const EMPTY_TRIPS: MileageTrip[] = [];

export function Mileage() {
  const { taxYear, isLoading: yearLoading } = useActiveTaxYear();
  const { data, isLoading, error } = useMileage(taxYear?.id);
  const canEdit = useCanEdit();
  const { remove } = useMileageMutations();
  const [editing, setEditing] = useState<MileageTrip | null>(null);
  const [copyOf, setCopyOf] = useState<MileageTrip | null>(null);
  const [toDelete, setToDelete] = useState<MileageTrip | null>(null);
  const formRef = useRef<HTMLDivElement>(null);
  const tripsRef = useRef<HTMLElement>(null);
  const pagination = usePagination(data?.trips ?? EMPTY_TRIPS, tripsRef, 'trips');

  // Bring the form into view when a trip is picked to edit or duplicate from the list below it.
  useEffect(() => {
    if (editing || copyOf) formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [editing, copyOf]);
  const startEdit = (trip: MileageTrip) => {
    setCopyOf(null);
    setEditing(trip);
  };
  const startCopy = (trip: MileageTrip) => {
    setEditing(null);
    setCopyOf(trip);
  };
  const finish = () => {
    setEditing(null);
    setCopyOf(null);
  };

  // If someone else saves the trip being edited, offer their version rather than overwriting it.
  const latest = editing ? data?.trips.find((t) => t.id === editing.id) : undefined;
  const rates = mileageRatesFor(taxYear?.label ?? '');
  const carMilesLeft = data ? Math.max(0, rates.car.thresholdMiles * 10 - data.totals.carDistanceTenths) : 0;
  // Trips, miles and claim per vehicle type, in VEHICLES order, for the types used this year.
  const byVehicle = VEHICLES.map((vehicle) => {
    const trips = (data?.trips ?? []).filter((t) => t.vehicle === vehicle);
    return {
      vehicle,
      trips: trips.length,
      tenths: trips.reduce((sum, t) => sum + t.distanceTenths, 0),
      pence: trips.reduce((sum, t) => sum + t.claimPence, 0),
    };
  }).filter((v) => v.tenths > 0);

  return (
    <>
      <div className="space-y-6">
        <SectionHeading
          title="Mileage"
          description="Business trips, claimed at HMRC's approved mileage rates instead of the vehicle's running costs."
          actions={
            taxYear &&
            data &&
            data.trips.length > 0 && (
              <ExportMenu href={(format) => `/api/mileage/export.${format}?taxYearId=${taxYear.id}`} count={data.trips.length} noun={['trip', 'trips']} />
            )
          }
        />
          {yearLoading || (taxYear && isLoading) ? (
            <Spinner />
          ) : !taxYear ? (
            <NoTaxYear />
          ) : error || !data ? (
            <Alert>{error?.message ?? 'Could not load mileage'}</Alert>
          ) : (
            <>
              <ClaimStats>
                <Stat label="Business miles" value={formatMiles(data.totals.distanceTenths)} sub={`${data.trips.length} trips this tax year`}>
                  {byVehicle.length > 1 && <VehicleBreakdown rows={byVehicle.map((v) => ({ vehicle: v.vehicle, trips: v.trips, value: formatMiles(v.tenths) }))} />}
                </Stat>
                <Stat label="Mileage claim" value={formatGBP(data.totals.claimPence)} sub="Counted as car, van and travel expenses">
                  {byVehicle.length > 1 && <VehicleBreakdown rows={byVehicle.map((v) => ({ vehicle: v.vehicle, trips: v.trips, value: formatGBP(v.pence) }))} />}
                </Stat>
                <Stat
                  label={`Left at ${rates.car.firstPence}p`}
                  value={formatMiles(carMilesLeft)}
                  sub={carMilesLeft > 0 ? `Car and van miles before the ${rates.car.afterPence}p rate` : `Car and van miles are now claimed at ${rates.car.afterPence}p`}
                />
                <RatesUsed
                  rates={[
                    { label: `Car or van, first ${rates.car.thresholdMiles.toLocaleString('en-GB')}`, rate: `${rates.car.firstPence}p` },
                    { label: 'After that', rate: `${rates.car.afterPence}p` },
                    { label: 'Motorcycle', rate: `${rates.motorcycle}p` },
                    { label: 'Bicycle', rate: `${rates.bicycle}p` },
                  ]}
                  note={rates.provisional}
                />
              </ClaimStats>

              {data.check ? (
                <MileageCheckAlert check={data.check} />
              ) : (
                <DismissibleAlert id="mileage-running-costs">
                  The mileage rate covers all the running costs of the vehicle (fuel, insurance, servicing, repairs). Don't also record
                  those costs as expenses for the same vehicle. Parking, tolls and train fares can still go in Expenses.
                </DismissibleAlert>
              )}

              {canEdit && (
                <>
                  {editing && latest && latest.updatedAt !== editing.updatedAt && (
                    <ChangedElsewhere by={latest.updatedBy} what="this trip" onLoad={() => setEditing(latest)} />
                  )}

                  <div ref={formRef} className="scroll-mt-24">
                    <Card>
                      <CardHeader
                        icon={
                          editing ? (
                            <Pencil className="size-5 text-accent-soft" />
                          ) : copyOf ? (
                            <Copy className="size-5 text-accent-soft" />
                          ) : (
                            <Plus className="size-5 text-accent-soft" />
                          )
                        }
                        title={editing ? 'Edit trip' : copyOf ? `Duplicate trip from ${formatDisplayDate(copyOf.date)}` : 'Add a trip'}
                      />
                      <TripForm
                        key={editing ? `${editing.id}-${editing.updatedAt}` : copyOf ? `copy-${copyOf.id}` : 'new'}
                        taxYear={taxYear}
                        editing={editing}
                        copyOf={copyOf}
                        onDone={finish}
                      />
                    </Card>
                  </div>
                </>
              )}

              <Card ref={tripsRef}>
                <CardHeader icon={<Route className="size-5 text-accent-soft" />} title="Trips" />
                {data.trips.length === 0 ? (
                  <EmptyState icon={<Car className="size-8" />} title="No trips yet">
                    Add the journeys you make for the business, such as visiting customers or clients, or driving to buy supplies.
                    Commuting to a regular workplace doesn't count.
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
                          {canEdit && <th scope="col" className="px-4 py-3 text-right font-medium sm:pr-6">Actions</th>}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-line">
                        {pagination.pageRows.map((t) => (
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
                            {canEdit && (
                              <td className="px-3 py-2 sm:pr-5">
                                <div className="flex justify-end gap-0.5">
                                  <IconButton label={`Edit trip on ${formatDisplayDate(t.date)}`} onClick={() => startEdit(t)}>
                                    <Pencil className="size-4" />
                                  </IconButton>
                                  <IconButton label={`Duplicate trip on ${formatDisplayDate(t.date)}`} onClick={() => startCopy(t)}>
                                    <Copy className="size-4" />
                                  </IconButton>
                                  <IconButton label={`Delete trip on ${formatDisplayDate(t.date)}`} tone="danger" onClick={() => setToDelete(t)}>
                                    <Trash2 className="size-4" />
                                  </IconButton>
                                </div>
                              </td>
                            )}
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
                          {canEdit && <td />}
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                )}
                <Pagination pagination={pagination} noun="trips" />
              </Card>

              <p className="flex items-start gap-2 text-sm text-muted">
                <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
                Claims are worked out in date order through the tax year.
              </p>
            </>
          )}
      </div>

      <ConfirmDialog
        open={toDelete !== null}
        title="Delete this trip?"
        confirmLabel="Delete trip"
        onClose={() => setToDelete(null)}
        onConfirm={async () => {
          await remove.mutateAsync(toDelete!.id);
          if (editing?.id === toDelete!.id) finish();
        }}
      >
        {toDelete && (
          <p>
            {toDelete.description} on {formatDisplayDate(toDelete.date)}, {formatMiles(toDelete.distanceTenths)} ({formatGBP(toDelete.claimPence)}).
            This can't be undone.
          </p>
        )}
        <SubmittedFiguresNotice taxYearId={toDelete?.taxYearId} dates={[toDelete?.date]} />
      </ConfirmDialog>
    </>
  );
}
