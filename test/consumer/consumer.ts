// Compiled against the built dist/ with skipLibCheck off: proves the shipped declarations type-check under zod 4.
import { z } from 'zod';
import { PersistOp, raiseConflictWhen, withPersistenceMeta, type EntityApplier, type Persistable } from '../../dist/index.js';

const Tag = withPersistenceMeta(z.object({ id: z.string() }));
export const parsed: { id: string; version: number } = Tag.parse({ id: 'a', version: 0 });
export const op: Persistable = { op: PersistOp.enum.check, entity: 'tag', id: 'a', version: 0 };
export const rebuilt = z.enum(PersistOp.options).parse('update');
export const decorated: EntityApplier<{ id: number }> = raiseConflictWhen((cause) => cause instanceof Error)({
  insert: async () => ({ applied: true }),
  update: async () => ({ applied: true }),
  delete: async () => ({ applied: true }),
});
