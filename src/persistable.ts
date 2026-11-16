import { z } from 'zod';

const PERSIST_OPS = ['insert', 'update', 'delete', 'check'] as const;
export type PersistOp = (typeof PERSIST_OPS)[number];

// Declared types name no zod 3-vs-4 internals (an inferred `ZodEnum<...>` differs between majors),
// so the shipped .d.ts type-checks under either peer. The enum surface is kept: `enum`, `options`, `extract`, `exclude`.
type EnumSchema<V extends string> = z.ZodType<V> & {
  readonly enum: { readonly [K in V]: K };
  readonly options: readonly V[];
  extract: <const U extends readonly [V, ...V[]]>(values: U) => EnumSchema<U[number]>;
  exclude: <const U extends readonly [V, ...V[]]>(values: U) => EnumSchema<Exclude<V, U[number]>>;
};

/** Effect intent (`check` is a read-set guard, not a write); construct via `.enum.*`, never a bare string. */
export const PersistOp = z.enum(PERSIST_OPS) as unknown as EnumSchema<PersistOp>;

/** Where every new row starts. Supplied by the adapter when shaping the insert row, not by the core. */
export const INITIAL_VERSION = 0;

/** The optimistic-concurrency token, declared once and applied via `withPersistenceMeta`, never baked into the model. */
export const PersistenceMeta: z.ZodObject<{ version: z.ZodNumber }> = z.object({
  version: z.number().int().nonnegative().describe('Optimistic-concurrency token; internal, never on wire/out'),
});

/** Pure model schema → entity schema with the `version` field. */
export const withPersistenceMeta = <T extends z.ZodRawShape>(
  model: z.ZodObject<T>,
): z.ZodObject<Omit<T, 'version'> & { version: z.ZodNumber }> =>
  model.extend(PersistenceMeta.shape) as unknown as z.ZodObject<Omit<T, 'version'> & { version: z.ZodNumber }>;

/**
 * A write intent handed from the core to the shell. Generic over the consumer's entity tag and model.
 * `insert` carries no `version` (a new row starts at `INITIAL_VERSION`); `idempotencyKey` is optional dedup
 * metadata, not a model field. `update` carries the full end-state, where `model.version` is the version read
 * (the applier writes `version + 1` guarded on it); `delete` carries the id and version read. `check` asserts a
 * row is still at the version read, without writing it.
 */
export type Persistable<Tag extends string = string, Model = unknown> =
  | { op: typeof PersistOp.enum.insert; entity: Tag; model: Model; idempotencyKey?: string }
  | { op: typeof PersistOp.enum.update; entity: Tag; model: Model & { version: number } }
  | { op: typeof PersistOp.enum.delete; entity: Tag; id: string; version: number }
  | { op: typeof PersistOp.enum.check; entity: Tag; id: string; version: number };

/** Builds a `check` persistable: the batch conflicts and retries if the row has moved past `version`. */
export const checkVersion = <Tag extends string>(
  entity: Tag,
  id: string,
  version: number,
): Extract<Persistable<Tag>, { op: typeof PersistOp.enum.check }> => ({
  op: PersistOp.enum.check,
  entity,
  id,
  version,
});

/** Result of applying one `Persistable`. `applied: false` marks an idempotent duplicate, with `read` reflecting
 *  the existing row. A stale update/delete never reports an outcome; it conflicts and retries. */
export type PersistOutcome = { entity: string; applied: boolean; read?: unknown };

/** What a flow returns instead of performing writes. `response` is a plain value, or a pure sync function of
 *  the outcomes for idempotency-aware flows. It never performs I/O. */
export type FlowOutcome<T> = {
  persist: Persistable[];
  response: T | ((outcomes: PersistOutcome[]) => T);
};
