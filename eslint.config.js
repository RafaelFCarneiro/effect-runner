import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// The engine is driver-free by contract (it carried this ban out of FinTrack, ADR-030): it depends
// only on zod / neverthrow / remeda and must never import a database driver. A driver import here is
// the whole point of the package being swappable — keep it a build error.
export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['drizzle-orm', 'drizzle-orm/*', '@libsql/*', 'pg', 'pg-*', 'better-sqlite3', 'mysql2'],
              message:
                'effect-runner is driver-free by design — the database is the consumer\'s adapter, never a dependency here.',
            },
          ],
        },
      ],
    },
  },
);
