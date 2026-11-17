// Compiled against the built dist/ with skipLibCheck off: proves the shipped declarations type-check under zod 4.
import { z } from 'zod';
import { PersistOp, withPersistenceMeta, type Persistable } from '../../dist/index.js';

const Tag = withPersistenceMeta(z.object({ id: z.string() }));
export const parsed: { id: string; version: number } = Tag.parse({ id: 'a', version: 0 });
export const op: Persistable = { op: PersistOp.enum.check, entity: 'tag', id: 'a', version: 0 };
export const rebuilt = z.enum(PersistOp.options).parse('update');
