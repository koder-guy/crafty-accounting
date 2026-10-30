// People who can sign in. Editors can add people, rename them, set their
// passwords and access, and remove them (but not themselves). Read-only
// people can only change their own password (readOnlyGuard lets that through).
import { Router } from 'express';
import { createUserSchema, updateUserSchema } from '@crafty/shared';
import type { AppContext } from '../context';
import { HttpError, parseId, parseWith } from '../http';
import { DEFAULT_ADMIN_PASSWORD, createUser, editorCount, getUser, hashPassword, listUsers, nameTaken } from '../users';

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
    const { name, password, role } = parseWith(createUserSchema, req.body);
    checkName(name);
    const id = createUser(ctx.db, name, password, role);
    res.status(201).json(listUsers(ctx.db).find((u) => u.id === id));
  });

  router.put('/:id', (req, res) => {
    const id = parseId(req.params.id);
    const person = getUser(ctx.db, id);
    if (!person) throw new HttpError(404, 'User not found');
    const { name, password, role } = parseWith(updateUserSchema, req.body);
    if (req.user!.mustChangePassword && (password === undefined || name !== undefined || role !== undefined)) {
      throw new HttpError(403, 'Choose a new password before carrying on.');
    }
    if (req.user!.role === 'viewer' && (id !== req.user!.id || name !== undefined || role !== undefined)) {
      throw new HttpError(403, 'Your account is read-only. You can change your own password, but nothing else.');
    }
    if (role === 'viewer' && person.role === 'editor' && editorCount(ctx.db) === 1) {
      throw new HttpError(422, 'Someone needs to stay an editor, so make another person an editor first.');
    }
    if (role !== undefined) ctx.db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
    if (name !== undefined) {
      checkName(name, id);
      ctx.db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, id);
    }
    if (password !== undefined) {
      if (password === DEFAULT_ADMIN_PASSWORD) throw new HttpError(400, 'Choose a password other than the default.');
      // Choosing their own password clears the need to change it; an editor setting someone else's doesn't.
      ctx.db
        .prepare('UPDATE users SET password_hash = ?, must_change_password = must_change_password AND ? WHERE id = ?')
        .run(hashPassword(password), id === req.user!.id ? 0 : 1, id);
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
