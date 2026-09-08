import js from '@eslint/js';
import ts from 'typescript-eslint';

export default ts.config(
  { ignores: ['.next/**', 'node_modules/**', 'src/payload-types.ts', 'src/app/(payload)/admin/importMap.js', 'next-env.d.ts'] },
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    languageOptions: { globals: { process: 'readonly', console: 'readonly', Buffer: 'readonly', fetch: 'readonly', URL: 'readonly', Request: 'readonly', Response: 'readonly', Headers: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly' } },
    rules: { '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }] },
  },
  // Payload's migration generator includes unused destructured hook arguments.
  { files: ['src/migrations/*.ts'], rules: { '@typescript-eslint/no-unused-vars': ['error', { args: 'none' }] } },
  { files: ['test/**/*.ts'], rules: { '@typescript-eslint/no-explicit-any': 'off' } },
);
