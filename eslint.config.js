import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

const rules = {
  ...tseslint.configs.recommended.rules,
  '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
  '@typescript-eslint/no-non-null-assertion': 'off',
};

export default [
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        project: './tsconfig.json',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules,
  },
  // The experiment runner (Node, imports the browser code; experiments/tsconfig.json)
  {
    files: ['experiments/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        project: './experiments/tsconfig.json',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules,
  },
  // Node code: the dev server, the Vercel function and the Vite config (tsconfig.node.json)
  {
    files: ['server/**/*.ts', 'api/**/*.ts', 'vite.config.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        project: './tsconfig.node.json',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules,
  },
  // The tactical proxy, a Cloudflare Worker (proxy/tsconfig.json: Workers APIs, no Node types)
  {
    files: ['proxy/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        project: './proxy/tsconfig.json',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules,
  },
];
