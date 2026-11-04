import { Router } from 'express';
import type { NotificationsResponse } from '@crafty/shared';
import type { AppContext } from '../context';
import { HttpError } from '../http';
import { markNotificationsRead, unreadNotifications } from '../notifications';

/** The bell: the signed-in person's unread notifications, and marking them read (viewers too). */
export function notificationsRouter(ctx: AppContext): Router {
  const router = Router();

  const list = (req: Express.Request): NotificationsResponse => ({ notifications: unreadNotifications(ctx.db, req.user!) });

  router.get('/', (req, res) => {
    res.json(list(req));
  });

  router.post('/read-all', (req, res) => {
    markNotificationsRead(ctx.db, req.user!, null);
    res.json(list(req));
  });

  router.post('/:id/read', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, 'Notification not found');
    markNotificationsRead(ctx.db, req.user!, id);
    res.json(list(req));
  });

  return router;
}
