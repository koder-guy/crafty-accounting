// Business journeys claimed at HMRC's approved mileage rates.
import { Router } from 'express';
import { z } from 'zod';
import {
  mileageInputSchema,
  penceToPounds,
  tenthsToMiles,
  VEHICLE_LABELS,
  type MileageResponse,
} from '@crafty/shared';
import type { AppContext } from '../context';
import { toCsv } from '../csv';
import { HttpError, parseId, parseWith } from '../http';
import { getMileageTrip, getTaxYear, listMileage } from '../repo';
import { checkTaxYearAndDate, checkUnchanged } from './transactions';

const querySchema = z.object({ taxYearId: z.coerce.number().int().positive() });

export function mileageRouter(ctx: AppContext): Router {
  const router = Router();

  router.get('/', (req, res) => {
    const { taxYearId } = parseWith(querySchema, req.query);
    const trips = listMileage(ctx.db, [taxYearId]);
    const sum = (list: typeof trips, value: (t: (typeof trips)[number]) => number) => list.reduce((acc, t) => acc + value(t), 0);
    const response: MileageResponse = {
      trips,
      totals: {
        distanceTenths: sum(trips, (t) => t.distanceTenths),
        claimPence: sum(trips, (t) => t.claimPence),
        carDistanceTenths: sum(
          trips.filter((t) => t.vehicle === 'car'),
          (t) => t.distanceTenths,
        ),
      },
    };
    res.json(response);
  });

  router.get('/export.csv', (req, res) => {
    const { taxYearId } = parseWith(querySchema, req.query);
    const year = getTaxYear(ctx.db, taxYearId);
    // Oldest first, as a mileage log reads.
    const rows = listMileage(ctx.db, [taxYearId])
      .reverse()
      .map((t) => [t.date, t.description, VEHICLE_LABELS[t.vehicle], tenthsToMiles(t.distanceTenths), penceToPounds(t.claimPence), t.notes]);
    const csv = toCsv(['Date', 'Journey', 'Vehicle', 'Miles', 'Claim (GBP)', 'Notes'], rows);
    res.attachment(`mileage-${year?.label ?? 'export'}.csv`).type('text/csv').send(csv);
  });

  router.post('/', (req, res) => {
    const input = parseWith(mileageInputSchema, req.body);
    checkTaxYearAndDate(ctx, input.taxYearId, input.date);
    const { lastInsertRowid } = ctx.db
      .prepare(
        `INSERT INTO mileage_trips (tax_year_id, date, description, vehicle, distance_tenths, notes, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(input.taxYearId, input.date, input.description, input.vehicle, input.distanceTenths, input.notes, req.user!.name, req.user!.name);
    res.status(201).json(getMileageTrip(ctx.db, Number(lastInsertRowid)));
  });

  router.put('/:id', (req, res) => {
    const id = parseId(req.params.id);
    const existing = getMileageTrip(ctx.db, id);
    if (!existing) throw new HttpError(404, 'Trip not found');
    const input = parseWith(mileageInputSchema, req.body);
    checkUnchanged(existing, input.expectedUpdatedAt, 'trip');
    if (input.taxYearId !== existing.taxYearId) throw new HttpError(422, 'A trip cannot be moved to another tax year');
    checkTaxYearAndDate(ctx, existing.taxYearId, input.date);
    ctx.db
      .prepare(
        `UPDATE mileage_trips SET date = ?, description = ?, vehicle = ?, distance_tenths = ?, notes = ?, updated_by = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?`,
      )
      .run(input.date, input.description, input.vehicle, input.distanceTenths, input.notes, req.user!.name, id);
    res.json(getMileageTrip(ctx.db, id));
  });

  router.delete('/:id', (req, res) => {
    const id = parseId(req.params.id);
    if (!getMileageTrip(ctx.db, id)) throw new HttpError(404, 'Trip not found');
    ctx.db.prepare('DELETE FROM mileage_trips WHERE id = ?').run(id);
    res.status(204).end();
  });

  return router;
}
