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
                '@starvalley/render-protocol',
              ],
              message:
                'manager must not depend on HTTP/WebSocket frameworks, rendering, or client code (AGENTS.md: Manager).',
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
                '@starvalley/render-protocol',
                'vitest',
              ],
              message:
                'router/server must not depend on client code, rendering, or test frameworks (AGENTS.md: Router).',
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
    ignores: ['apps/web/src/organizer/**', 'apps/web/src/render/**'],
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
                '@starvalley/render-protocol',
                'node:*',
                'axios',
                '../organizer/*',
                '../../*',
                '../../../*',
                '../../../../*',
              ],
              message:
                'ui must consume the Organizer barrel and the render bridge/runtime only; importing wire/protocol, render-ISA, backend code, or Organizer internals is forbidden (AGENTS.md: UI).',
            },
            {
              // NOTE: this MUST be a regex, not a `group` glob. `group` entries are
              // matched gitignore-style, so a bare 'three' also matches the local
              // *directory segment* in '../render/three/runtime' - the exact import
              // the architecture requires. The regex pins the npm package only.
              regex: '^three(/.*)?$',
              message:
                'ui must not import Three.js directly: it is an executor of the render ISA, reachable only through the injected render runtime (AGENTS.md: UI).',
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
      // The specifier patterns above enforce the *module surface* (a UI file may
      // import its own local modules, the Organizer barrel, and the render bridge/
      // runtime — nothing else, including Organizer internals and deep relative
      // escapes). What patterns cannot express is dynamic and computed access, so
      // those forms are covered here.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "ImportExpression[source.value=/^(@starvalley\\/(protocol|router|manager|server)|node:|axios)$/]",
          message:
            'ui must consume the Organizer API only; dynamic import() of wire/protocol or backend code is forbidden (AGENTS.md: UI).',
        },
        {
          selector:
            "MemberExpression[computed=true][object.name='globalThis'][property.value='fetch']",
          message:
            'ui must not call the backend directly; use an Organizer action instead (AGENTS.md: UI).',
        },
        {
          selector:
            "MemberExpression[computed=true][object.name='window'][property.value='fetch']",
          message:
            'ui must not call the backend directly; use an Organizer action instead (AGENTS.md: UI).',
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
                '@starvalley/render-protocol',
                'three',
                'node:*',
                '**/ui/**',
                '**/render/**',
                '../ui/*',
              ],
              message:
                'organizer must not import backend implementation, rendering, or UI code (AGENTS.md: Organizer).',
            },
          ],
        },
      ],
    },
  },
  {
    // The render ISA itself: an instruction set, so it must stay framework-free.
    files: ['packages/render-protocol/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', 'react', 'react-dom', 'three', 'three/*', 'vite', '@starvalley/*'],
              message:
                'the render ISA is executed by many possible runtimes: it must stay framework-free and dependency-free (no Three.js, no React, no Node, no game protocol).',
            },
          ],
        },
      ],
    },
  },
  {
    // Render bridge: pure game-state -> render-command mapping. Must not touch Three.js.
    files: ['apps/web/src/render/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'three',
                'three/*',
                './three',
                './three/*',
                '**/render/three/**',
                'node:*',
                '@starvalley/protocol',
                '@starvalley/router',
                '@starvalley/manager',
                '@starvalley/server',
                '**/ui/**',
                '../ui/*',
              ],
              message:
                'the render bridge maps Organizer state to render commands: it must not import Three.js (not even transitively via ./three/*), the game protocol, the backend, or UI components (only @starvalley/render-protocol and the Organizer barrel).',
            },
          ],
        },
      ],
    },
  },
  {
    // The ONLY place Three.js may be imported: it is the render ISA executor.
    files: ['apps/web/src/render/three/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'node:*',
                '@starvalley/protocol',
                '@starvalley/router',
                '@starvalley/manager',
                '@starvalley/server',
                '**/organizer/**',
                '../organizer',
                '../../organizer',
                '../bridge',
                '../bridge/*',
                '../*',
                '../../*',
              ],
              message:
                'the Three.js runtime only executes render primitives: it must not know game semantics (no game protocol, no Organizer state) and must not reach outside its own module (not even transitively via ../bridge).',
            },
          ],
        },
      ],
    },
  },
);
