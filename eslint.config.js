// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/dev-dist/**',
      'apps/api/prisma/migrations/**',
      'apps/web/src/generated/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],

      // Rule #2 of the project: money is Int satang. Floats must never appear
      // in a money path, so ban the two most common ways they sneak in.
      'no-restricted-globals': [
        'error',
        {
          name: 'parseFloat',
          message: 'Money is Int satang. Use parseBahtToSatang() from @pos/shared.',
        },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'Number',
          property: 'parseFloat',
          message: 'Money is Int satang. Use parseBahtToSatang() from @pos/shared.',
        },
      ],
    },
  },
  {
    // Seed + config files run in Node and may log freely.
    files: ['**/*.config.{js,ts}', 'apps/api/prisma/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  prettier,
);
