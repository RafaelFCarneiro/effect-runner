import { z } from 'zod';

/** Write intent; construct via `.enum.*`, never a bare string. */
export const PersistOp = z.enum(['insert', 'update', 'delete']);
export type PersistOp = z.infer<typeof PersistOp>;

/** Where every new row starts. Supplied by the adapter when shaping the insert row, not by the core. */
export const INITIAL_VERSION = 0;

/** The optimistic-concurrency token, declared once and applied via `withPersistenceMeta`, never baked into the model. */
export const PersistenceMeta = z.object({
  version: z.number().int().nonnegative().describe('Optimistic-concurrency token; internal, never on wire/out'),
});

/** Pure model schema → entity schema with the `version` field. */
export const withPersistenceMeta = <T extends z.ZodRawShape>(model: z.ZodObject<T>) =>
  model.extend(PersistenceMeta.shape);

/**
 * A write intent handed from the core to the shell. Generic over the consumer's entity tag and model.
 * `insert` carries no `version` (a new row starts at `INITIAL_VERSION`); `idempotencyKey` is optional dedup
 * metadata, not a model field. `update` carries the full end-state, where `model.version` is the version read
 * (the applier writes `version + 1` guarded on it); `delete` carries the id and version read.
 */
export type Persistable<Tag extends string = string, Model = unknown> =
  | { op: typeof PersistOp.enum.insert; entity: Tag; model: Model; idempotencyKey?: string }
  | { op: typeof PersistOp.enum.update; entity: Tag; model: Model & { version: number } }
  | { op: typeof PersistOp.enum.delete; entity: Tag; id: string; version: number };

/** Result of applying one `Persistable`. `applied: false` marks an idempotent duplicate, with `read` reflecting
 *  the existing row. A stale update/delete never reports an outcome; it conflicts and retries. */
export type PersistOutcome = { entity: string; applied: boolean; read?: unknown };

/** What a flow returns instead of performing writes. `response` is a plain value, or a pure sync function of
 *  the outcomes for idempotency-aware flows. It never performs I/O. */
export type FlowOutcome<T> = {
  persist: Persistable[];
  response: T | ((outcomes: PersistOutcome[]) => T);
};
