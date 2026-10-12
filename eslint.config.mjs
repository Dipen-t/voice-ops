import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'data/models/**', 'data/raw/**', 'data/private-evaluation/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts','**/*.tsx'],
    rules: { '@typescript-eslint/consistent-type-imports': 'error' },
  },
);
