// ESLint 10 flat config with typescript-eslint + react-hooks.
// Goal: catch real bugs (unused vars, hook deps, parsing errors) without
// chasing every stylistic rule — prettier owns style.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      'dist',
      'node_modules',
      'src/ui/dist',
      'src/ui/node_modules',
      'private',
      'src/__fixtures__/**',
      'src/ui/public/**',
      'site/**', // landing page + vendored third-party assets (tailwind, …)
      'eslint.config.js',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-empty-object-type': 'off',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-constant-condition': ['warn', { checkLoops: false }],
      // Backticks inside template literals + escaped chars inside regex
      // character classes account for ~all hits; not worth the churn.
      'no-useless-escape': 'off',
      'no-useless-assignment': 'off',
    },
  },
  // UI: browser globals + react-hooks rules.
  {
    files: ['src/ui/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.browser },
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
);
