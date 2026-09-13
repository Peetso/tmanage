// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';

/**
 * Workspace lint rules.
 *
 * Beyond ordinary hygiene, the `no-restricted-imports` blocks below encode the
 * repository boundary rules from `18-REPOSITORY-STRUCTURE.md`. They are lint errors
 * rather than documentation because a boundary that is only written down is a
 * boundary that erodes.
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      '**/storybook-static/**',
      '**/node_modules/**',
      // Immutable source material — never linted, never rewritten.
      'docs/planning/**',
      'docs/design/source/**',
      // Untracked leftovers of the retired Codex review process. They are not
      // repository source, and linting them is what stops `pnpm verify` being
      // runnable as written.
      'CODEX-REVIEW-2026-09-05/**',
      'CODEX_REVIEW_FOR_CLAUDE_2026-09-05.md',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-restricted-syntax': [
        'error',
        {
          // 15-AI-EXECUTION-HANDBOOK §8: localStorage is never authoritative business state.
          selector:
            "MemberExpression[object.name='localStorage'], MemberExpression[object.name='sessionStorage']",
          message:
            'Browser storage is never authoritative business state (15-AI-EXECUTION-HANDBOOK §8). Use the API and TanStack Query cache.',
        },
      ],
    },
  },

  // ── Boundary: shared domain code stays pure ─────────────────────────────────
  {
    files: ['packages/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'mysql2',
                'mysql2/*',
                'drizzle-orm',
                'drizzle-orm/*',
                'pg',
                'pg-*',
                '@nestjs/*',
                'fastify',
                'ioredis',
                '@aws-sdk/*',
                'next',
                'react',
              ],
              message:
                'packages/domain contains pure value objects, policies, and state machines only — no I/O, no framework, no ORM (18-REPOSITORY-STRUCTURE).',
            },
            {
              group: ['@tmanage/*'],
              message:
                'packages/domain is the lowest layer and must not depend on other workspace packages.',
            },
          ],
        },
      ],
    },
  },

  // ── React surfaces: accessibility is a lint error, not a review note ────────
  //
  // 40-DESIGN-SYSTEM §10 sets WCAG 2.2 AA as the target and lists the rules that matter
  // most here — every control has an accessible name, every interactive element is
  // reachable from the keyboard, nothing relies on a mouse-only handler. `jsx-a11y`
  // catches the static half of that at the point of writing; `tests/axe.ts` catches the
  // rendered half. Neither is sufficient alone, and the four human-validation items (NVDA,
  // VoiceOver, native Arabic RTL review, 200% zoom) are recorded as open in
  // `docs/implementation-status.md` rather than implied by a green lint run.
  {
    files: ['packages/ui/**/*.{ts,tsx}', 'apps/web/**/*.{ts,tsx}'],
    plugins: { 'jsx-a11y': jsxA11y, 'react-hooks': reactHooks },
    languageOptions: {
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      ...jsxA11y.flatConfigs.recommended.rules,
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },

  // ── Boundary: the design system knows nothing about the product ─────────────
  //
  // 18-REPOSITORY-STRUCTURE puts `ui` beside `contracts` and `domain` rather than above
  // them. A primitive that imports a work-item type is no longer a primitive: it cannot be
  // reused by the client portal, it cannot be rendered in isolation, and it drags the API
  // surface into every consumer.
  {
    files: ['packages/ui/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@tmanage/*', '**/apps/**'],
              message:
                'packages/ui is a design system: tokens, primitives and styles only. It does not import product code, contracts, or domain types (18-REPOSITORY-STRUCTURE).',
            },
            {
              group: ['next', 'next/*', 'mysql2', 'drizzle-orm', 'drizzle-orm/*', '@nestjs/*'],
              message:
                'The design system is framework-agnostic React. A Next.js or server import here would make every consumer inherit it.',
            },
          ],
        },
      ],
    },
  },

  // ── Boundary: the web app never reaches into API internals ──────────────────
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@tmanage/api', '@tmanage/api/*', '**/apps/api/**'],
              message:
                'Feature UI may depend on @tmanage/ui, never on API internals (18-REPOSITORY-STRUCTURE). ' +
                '@tmanage/contracts was named here and in package.json from the initial commit and never authored, ' +
                'so it is not the alternative this message used to offer. The API and web response shapes are held ' +
                'in step instead by e2e/contracts/api-web-shapes.ts, checked by `pnpm contracts:check` (D10).',
            },
            {
              group: [
                'mysql2',
                'mysql2/*',
                'drizzle-orm',
                'drizzle-orm/*',
                'pg',
                'ioredis',
                '@aws-sdk/*',
              ],
              message: 'Infrastructure clients never belong in the web app.',
            },
          ],
        },
      ],
    },
  },

  // ── Boundary: the database handle is unreachable from feature code ──────────
  //
  // 25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC §6, and layer 4 of ADR-0001:
  //
  //   "Ban direct `db` imports outside repository/migration modules with lint boundaries.
  //    Ban raw SQL except reviewed, parameterized helpers in an allowlisted directory."
  //
  // This is a lint rule rather than a review convention because MySQL has no row-level
  // security. On PostgreSQL a controller that reaches past the repository layer still gets
  // RLS underneath it; here it gets nothing. The rule removes the possibility instead of
  // relying on every reviewer catching it every time.
  //
  // The allowlist immediately below is the complete set of modules permitted to hold a
  // driver handle or write SQL. Adding to it is a deliberate, reviewable diff.
  {
    files: ['apps/api/**/*.ts', 'apps/worker/**/*.ts'],
    ignores: [
      'apps/api/src/common/database/**/*.ts',
      'apps/api/src/**/repositories/**/*.ts',
      'apps/api/src/**/*.repository.ts',
      'apps/worker/src/common/database/**/*.ts',
      // Fixtures and the isolation corpus deliberately bypass repositories: their job is
      // to prove the constraints hold underneath them.
      'apps/api/test/**/*.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['mysql2', 'mysql2/*', 'drizzle-orm', 'drizzle-orm/*', 'mysql-memory-server'],
              message:
                'Only repository and database modules may hold a driver handle (25-AUTH-AND-TENANT-ISOLATION §6). Feature code takes a TenantQueryRunner from TenantDatabase.transaction().',
            },
            {
              group: ['**/common/database/connection', '**/common/database/connection.js'],
              message:
                'The pool factory is internal to the database layer. Depend on TenantDatabase, which binds every statement to a verified TenantContext.',
            },
          ],
        },
      ],
      // `no-restricted-syntax` replaces rather than extends the workspace rule, so the
      // browser-storage selector is restated here to keep the override from silently
      // dropping it.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "MemberExpression[object.name='localStorage'], MemberExpression[object.name='sessionStorage']",
          message:
            'Browser storage is never authoritative business state (15-AI-EXECUTION-HANDBOOK §8). Use the API and TanStack Query cache.',
        },
        {
          selector:
            'Literal[value=/(?:select[\\s\\S]+from|insert[\\s\\S]+into|update[\\s\\S]+set|delete[\\s\\S]+from)/i]',
          message:
            'Raw SQL is only permitted in repository and database modules (25-AUTH-AND-TENANT-ISOLATION §6). A statement written outside them bypasses the tenant guard and the scoped-repository signature.',
        },
        {
          selector:
            'TemplateElement[value.raw=/(?:select[\\s\\S]+from|insert[\\s\\S]+into|update[\\s\\S]+set|delete[\\s\\S]+from)/i]',
          message:
            'Raw SQL is only permitted in repository and database modules (25-AUTH-AND-TENANT-ISOLATION §6). An interpolated SQL template is also how injection gets written.',
        },
      ],
    },
  },

  // Node-runtime scripts: real CLI tools, so `process` and `console` are legitimate.
  {
    // `packages/ui/vr/serve.mjs` is the visual-regression harness's static server -- same category.
    files: ['scripts/**/*.mjs', 'packages/ui/vr/serve.mjs', '**/*.config.{js,ts,mjs}'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        URL: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
      },
    },
    rules: {
      'no-console': 'off',
    },
  },

  // Test files relax a few rules that exist to protect production code paths.
  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/test/**/*.ts'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },

  prettier,
);
