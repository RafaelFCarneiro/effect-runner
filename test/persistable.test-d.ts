import { describe, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { PersistOp, withPersistenceMeta } from '../src/persistable.js';

const tag = z.object({ id: z.string(), name: z.string() });

describe('withPersistenceMeta types', () => {
  it('adds a numeric version to the model shape', () => {
    expectTypeOf(withPersistenceMeta(tag).shape.version).toEqualTypeOf<z.ZodNumber>();
    expectTypeOf(withPersistenceMeta(tag).shape.id).toEqualTypeOf<z.ZodString>();
  });

  it('accepts any object schema', () => {
    expectTypeOf(withPersistenceMeta).parameter(0).toExtend<z.ZodObject<z.ZodRawShape>>();
  });
});

describe('PersistOp types', () => {
  it('keeps the enum surface', () => {
    expectTypeOf(PersistOp.enum.insert).toEqualTypeOf<'insert'>();
    expectTypeOf(PersistOp.exclude(['check']).parse('insert')).toEqualTypeOf<'insert' | 'update' | 'delete'>();
    expectTypeOf(PersistOp.extract(['check']).parse('check')).toEqualTypeOf<'check'>();
  });
});

describe('derived PersistOp enums', () => {
  it('keep the enum surface when chained', () => {
    expectTypeOf(PersistOp.exclude(['check']).enum.insert).toEqualTypeOf<'insert'>();
    expectTypeOf(PersistOp.extract(['insert', 'update']).exclude(['update']).parse('insert')).toEqualTypeOf<'insert'>();
  });
});

describe('PersistOp options', () => {
  it('stay a literal tuple that z.enum accepts', () => {
    expectTypeOf(z.enum(PersistOp.options).parse('update')).toEqualTypeOf<'insert' | 'update' | 'delete' | 'check'>();
    expectTypeOf(PersistOp.exclude(['check']).options).toEqualTypeOf<['insert', 'update', 'delete']>();
  });
});
