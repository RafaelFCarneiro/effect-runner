// Compiled against the built dist/ with skipLibCheck off: proves the shipped declarations type-check under the installed zod.
import { z } from 'zod';
import { PersistOp, withPersistenceMeta, type Persistable } from '../../dist/index.js';

const Tag = withPersistenceMeta(z.object({ id: z.string() }));
export const parsed: { id: string; version: number } = Tag.parse({ id: 'a', version: 0 });
export const op: Persistable = { op: PersistOp.enum.check, entity: 'tag', id: 'a', version: 0 };

export const allOps: readonly string[] = PersistOp.options;
export const writes = PersistOp.exclude(['check']).parse('insert');
export const reads = PersistOp.extract(['check']).parse('check');
export const chained = PersistOp.exclude(['check']).enum.insert;
export const derived = PersistOp.extract(['insert', 'update']).exclude(['update']).parse('insert');
export const rebuilt = z.enum(PersistOp.options).parse('update');
export const rebuiltFromDerived = z.enum(PersistOp.exclude(['check']).options).parse('insert');
