import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Architecture boundary rules.
 *
 * These rules are the *enforcement* half of docs/architecture.md. Ownership and
 * dependency direction live in AGENTS.md; a violation here is a build failure.
 */
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/*.zip',
      '**/*.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      'no-undef': 'off',
      eqeqeq: ['error', 'always'],
      'no-console': 'off',
    },
  },
  {
    // Node-side code and tooling configs.
    files: [
      '*.{js,mjs,ts}',
      'packages/**/*.{ts,tsx}',
      'apps/server/**/*.{ts,tsx}',
    ],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    // Browser-side code.
    files: ['apps/web/src/**/*.{ts,tsx}', 'apps/web/vite.config.ts'],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },
  {
    // Protocol: canonical, framework-neutral, dependency-free.
    files: ['packages/protocol/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'node:*',
                'react',
                'react-dom',
                'react/*',
                'three',
                'three/*',
                'vite',
                'vitest',
                'express',
                'ws',
                '@starvalley/*',
              ],
              message:
                'protocol must stay framework-neutral and free of runtime dependencies (AGENTS.md: Protocol).',
            },
          ],
        },
      ],
    },
  },
  {
    // Manager: authoritative backend execution, no transport/framework/client deps.
    files: ['packages/manager/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'node:http',
                'node:https',
                'node:http2',
                'node:net',
                'node:dgram',
                'express',
                'koa',
                'fastify',
                'ws',
                'socket.io',
                'react',
                'react-dom',
                'three',
                'vite',
                '@starvalley/router',
                '@starvalley/server',
              ],
              message:
                'manager must not depend on HTTP/WebSocket frameworks or client code (AGENTS.md: Manager).',
            },
          ],
        },
      ],
    },
  },
  {
    // Router / server composition root: transport only, no client code, no game rules.
    files: ['packages/router/src/**/*.ts', 'apps/server/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'react',
                'react-dom',
                'three',
                'vite',
                '@starvalley/web',
                'vitest',
              ],
              message:
                'router/server must not depend on client code or test frameworks (AGENTS.md: Router).',
            },
          ],
        },
      ],
    },
  },
  {
    // UI: presentation only. Must not know how the backend is called.
    // Covers all client files EXCEPT the Organizer (which owns transport).
    files: ['apps/web/src/**/*.{ts,tsx}'],
    ignores: ['apps/web/src/organizer/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@starvalley/protocol',
                '@starvalley/router',
                '@starvalley/manager',
                '@starvalley/server',
                'node:*',
                'axios',
              ],
              message:
                'ui must consume the Organizer API only; it must not import wire/protocol or backend code (AGENTS.md: UI).',
            },
          ],
        },
      ],
      // Any way of reaching the network directly is forbidden. Note that ESLint
      // matches identifiers, so `fetch`, `globalThis.fetch`, `window.fetch` are all
      // listed: closing one form is not enough.
      'no-restricted-globals': [
        'error',
        {
          name: 'fetch',
          message:
            'ui must not call the backend directly; use an Organizer action instead (AGENTS.md: UI).',
        },
        {
          name: 'WebSocket',
          message:
            'ui must not open socket transports directly; use an Organizer action instead (AGENTS.md: UI).',
        },
        {
          name: 'EventSource',
          message:
            'ui must not open event streams directly; use an Organizer action instead (AGENTS.md: UI).',
        },
        {
          name: 'XMLHttpRequest',
          message:
            'ui must not call the backend directly; use an Organizer action instead (AGENTS.md: UI).',
        },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'window',
          property: 'fetch',
          message:
            'ui must not call the backend directly; use an Organizer action instead (AGENTS.md: UI).',
        },
        {
          object: 'globalThis',
          property: 'fetch',
          message:
            'ui must not call the backend directly; use an Organizer action instead (AGENTS.md: UI).',
        },
        {
          object: 'globalThis',
          property: 'WebSocket',
          message:
            'ui must not open socket transports directly; use an Organizer action instead (AGENTS.md: UI).',
        },
        {
          object: 'navigator',
          property: 'sendBeacon',
          message:
            'ui must not send network beacons directly; use an Organizer action instead (AGENTS.md: UI).',
        },
      ],
    },
  },
  {
    // Organizer: client application layer. No backend implementation, no UI code.
    files: ['apps/web/src/organizer/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@starvalley/router',
                '@starvalley/manager',
                '@starvalley/server',
                'node:*',
                '**/ui/**',
                '../ui/*',
              ],
              message:
                'organizer must not import backend implementation or UI code (AGENTS.md: Organizer).',
            },
          ],
        },
      ],
    },
  },
);
