// People who can sign in. Everyone signed in can add people, rename them,
// set their passwords and remove them (but not themselves).
import { Router } from 'express';
import { createUserSchema, updateUserSchema } from '@crafty/shared';
import type { AppContext } from '../context';
import { HttpError, parseId, parseWith } from '../http';
import { createUser, getUser, hashPassword, listUsers, nameTaken } from '../users';

export function usersRouter(ctx: AppContext): Router {
  const router = Router();

  const checkName = (name: string, exceptId = 0) => {
    if (nameTaken(ctx.db, name, exceptId)) {
      throw new HttpError(409, `There's already someone called ${name}`, [{ path: 'name', message: 'Name already in use' }]);
    }
  };

  router.get('/', (_req, res) => {
    res.json(listUsers(ctx.db));
  });

  router.post('/', (req, res) => {
    const { name, password } = parseWith(createUserSchema, req.body);
    checkName(name);
    const id = createUser(ctx.db, name, password);
    res.status(201).json(listUsers(ctx.db).find((u) => u.id === id));
  });

  router.put('/:id', (req, res) => {
    const id = parseId(req.params.id);
    if (!getUser(ctx.db, id)) throw new HttpError(404, 'User not found');
    const { name, password } = parseWith(updateUserSchema, req.body);
    if (name !== undefined) {
      checkName(name, id);
      ctx.db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, id);
    }
    if (password !== undefined) {
      ctx.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), id);
    }
    res.json(listUsers(ctx.db).find((u) => u.id === id));
  });

  router.delete('/:id', (req, res) => {
    const id = parseId(req.params.id);
    if (!getUser(ctx.db, id)) throw new HttpError(404, 'User not found');
    if (id === req.user!.id) throw new HttpError(422, "You can't remove yourself. Ask someone else to do it.");
    ctx.db.prepare('DELETE FROM users WHERE id = ?').run(id);
    res.status(204).end();
  });

  return router;
}
