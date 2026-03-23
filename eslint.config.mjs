import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';
import importPlugin from 'eslint-plugin-import-x';

export default tseslint.config(
  {
    ignores: ['dist/', 'node_modules/'],
  },
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      sourceType: 'module',
    },
    plugins: {
      'import-x': importPlugin,
    },
    rules: {
      // No `any` allowed
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',

      // No unused variables
      '@typescript-eslint/no-unused-vars': 'error',

      // No floating promises
      '@typescript-eslint/no-floating-promises': 'error',

      // Consistent type imports
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],

      // No non-null assertions
      '@typescript-eslint/no-non-null-assertion': 'error',

      // Strict boolean expressions
      '@typescript-eslint/strict-boolean-expressions': 'error',

      // No unnecessary conditions
      '@typescript-eslint/no-unnecessary-condition': 'error',

      // Prefer nullish coalescing
      '@typescript-eslint/prefer-nullish-coalescing': 'error',

      // Prefer optional chaining
      '@typescript-eslint/prefer-optional-chain': 'error',

      // Require await in async functions
      '@typescript-eslint/require-await': 'error',

      // No misused promises
      '@typescript-eslint/no-misused-promises': 'error',

      // Switch exhaustiveness check
      '@typescript-eslint/switch-exhaustiveness-check': 'error',

      // Import ordering
      'import-x/order': [
        'error',
        {
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
          'newlines-between': 'always',
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],
      'import-x/newline-after-import': 'error',
      'import-x/no-duplicates': 'error',
    },
  },
  eslintConfigPrettier,
);
