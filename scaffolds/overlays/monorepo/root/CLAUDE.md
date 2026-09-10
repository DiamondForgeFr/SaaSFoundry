# {{PROJECT_NAME}}

Production-ready SaaS monorepo generated with **SaaSFoundryAI** - An AI-First development platform.

## 🧭 Preconditions first (read before asking questions)

Before asking the user anything about scope, backend, or module choices, **read the manifest and check the configured tools**:

1. Read `.saasfoundry.json` — the source of truth for workflow, SRS backend, and installed modules. Never re-ask what is already declared there.
2. Run `sf status --claude-friendly --no-network` to get a summary of the manifest, installed modules, and preconditions. A `SessionStart` hook in `.claude/settings.json` also auto-injects this summary at session start.
3. Only ask about things that are **not** resolvable from the manifest. If a precondition is `fail`, route the user to the relevant install/config CLI (`sf workflow`, `sf skill install`, etc.) instead of opening a scope dialogue.

## Coding-agent identity and onboarding

Use the coding-agent identity explicitly supplied by the current host or session. Never infer it from a model/provider name, executable, repository file, or PATH. If the identity is absent or
ambiguous, ask the user to choose a registered coding-agent profile and do not change the project.

Run `sf agents list --json`. When the current supported tool is undeclared, ask the user to choose one action: add it, replace the declaration with an explicitly named non-empty set, or leave the
project unchanged. Ask whether the choice is local to this checkout or shared through the repository only after add or replace is accepted. Use `sf agents enable` for add and `sf agents replace` for
exact replacement. No change runs no mutating command. Replacement changes inventory only and never deletes existing instructions, skills, hooks, settings, credentials, or exclusions.

## 🏗️ Monorepo Structure

This is a **Turborepo monorepo** with centralized tooling and shared skills.

```
{{PROJECT_NAME}}/
├── .claude/              # ⭐ Centralized Claude skills (shared by all apps)
│   ├── skills/           # Core skills for git, utils, workflows
│   └── skills-optional/  # Advanced skills (Context7, Atlassian, etc.)
├── apps/
│   ├── api/              # NestJS backend
│   │   └── CLAUDE.md     # API-specific context
│   └── web/              # React frontend
│       └── CLAUDE.md     # Web-specific context
├── packages/             # Shared workspaces consumed by apps/api and apps/web
│   ├── shared-types/     # TypeScript types (User, Organization, RBAC, …)
│   ├── shared-validation/# Zod schemas (signup, signin, org CRUD, …)
│   ├── shared-config/    # Runtime constants (MIME lists, size thresholds, …)
│   ├── ui-primitives/    # Headless ShadCN/Radix + Tailwind v4 theme tokens
│   └── api-client/       # Auto-generated typed React Query hooks (via orval)
├── turbo.json            # Turborepo configuration
└── package.json          # Root workspace configuration
```

### 📦 Shared packages — the no-drift contract

`packages/*` is the single source of truth for code that must be identical on both sides of the wire. Each package is a private npm workspace published under `@{{PROJECT_NAME}}/<name>`. **Read each package's `README.md` for the full "what goes in / what does not" rules** — the summary below is just the AI-orientation map.

| Package                                | Purpose                                                            | Distribution                            | Build artifact         |
| -------------------------------------- | ------------------------------------------------------------------ | --------------------------------------- | ---------------------- |
| `@{{PROJECT_NAME}}/shared-types`       | Cross-wire TypeScript types + `z.infer` outputs                    | dist (`tsc`) + vendored mirror per app  | `dist/index.{js,d.ts}` |
| `@{{PROJECT_NAME}}/shared-validation`  | Zod schemas for both NestJS DTOs and React Hook Form               | dist (`tsc`) + vendored mirror per app  | `dist/index.{js,d.ts}` |
| `@{{PROJECT_NAME}}/shared-config`      | Runtime constants (MIME lists, size thresholds, public routes, …)  | dist (`tsc`), mono-only (no mirror)     | `dist/index.{js,d.ts}` |
| `@{{PROJECT_NAME}}/ui-primitives`      | Headless ShadCN/Radix + Tailwind v4 theme tokens                   | source-only (`.tsx` via `exports`)      | none — Vite reads src  |
| `@{{PROJECT_NAME}}/api-client`         | Auto-generated typed React Query hooks (orval from `apps/api` OAS) | source-only (`.ts` via `exports`)       | none — Vite reads src  |

**Module resolution.** Each package is symlinked into the root `node_modules/@{{PROJECT_NAME}}/<name>`. `dist`-based packages need an `npm run build` before consumers see source edits — Turborepo's `build → ^build` topology takes care of that automatically. Source-only packages are picked up immediately by the consumer's bundler (Vite reads `.tsx` directly, TypeScript resolves the `exports` field).

### 🧠 Decision matrix — where does new code go?

When adding a new symbol, ask in order:

1. **Is it a runtime constant or threshold both apps must agree on?** → `packages/shared-config`.
2. **Is it a Zod schema validated identically on both sides?** → `packages/shared-validation` (factory pattern; web overrides messages with i18n, api uses defaults).
3. **Is it a TypeScript type / interface / enum used on both sides of the wire?** → `packages/shared-types` (mirror into both blueprints if hand-written; deposit via installer if module-scoped — see "Module deposits" below).
4. **Is it a headless UI building block (button, dialog, hook used by primitives, theme token)?** → `packages/ui-primitives`. Mirror to `apps/web/src/components/ui/shadcn/` blueprint side via the drift-guard. App-specific compositions (logos, page-loaders, business widgets) stay in `apps/web/src/components/`.
5. **Is it a backend endpoint?** Add the controller in `apps/api`, regenerate the API client (`npm run codegen`), and consume the new typed hook from `@{{PROJECT_NAME}}/api-client/generated/api/<tag>/<tag>` in `apps/web`.
6. **Otherwise** → it's app-specific and stays under the relevant `apps/<app>/src/`.

### 🔁 Module deposits (auto-managed shared files)

When SaaSFoundryAI installed an optional module on this monorepo, it may have deposited a shared file directly into `packages/shared-*`. The deposits are **idempotent** (re-running `sf update` won't duplicate them) and **gated** on the module being installed:

| Module    | Deposits into                              | Consumer rewired to                              |
| --------- | ------------------------------------------ | ------------------------------------------------ |
| storage   | `packages/shared-config/src/storage.ts`    | `apps/api/.../organization.controller.ts`        |
| email     | `packages/shared-types/src/email.ts`       | `apps/api/.../mailersend.service.ts`             |

Edit these files like any other shared file once they exist — they're just canonical seeds, not generated artifacts. **If you delete one without removing the consumer's import, the build will break** — keep the deposit ↔ consumer pair in sync.

### 🛡️ Vendored mirrors — keep them in sync

`shared-types` and `shared-validation` ship as a **canonical workspace package** AND as a **vendored mirror** under each app's `src/shared-{types,validation}/`. The apps actually consume the mirror via the TS alias `@shared-types/*` / `@shared-validation/*` — the workspace package is the documentation source plus the home for module-deposited types/schemas. **When you change a hand-written file, change all three copies** (canonical + each app's mirror). If you only edit one, the other side will silently keep the old shape and types will drift.

## 🎯 Skills Priority

**IMPORTANT**: This monorepo uses centralized SaaSFoundryAI skills (prefix `sf-*`). When multiple skills with similar functionality exist, **always prefer SaaSFoundryAI skills** over global or other skills:

- ✅ Use `sf-git-commit` instead of `git-commit`
- ✅ Use `sf-utils-fix-errors` instead of `utils-fix-errors`
- ✅ Use `sf-workflow-apex` instead of `workflow-apex`
- ✅ Use `sf-tool-atlassian` instead of `tool-atlassian`

SaaSFoundryAI skills are located in `.claude/` at the repository root and are optimized for this monorepo structure.

## 📣 Long-running commands (announce + stream)

The screen must never freeze silently. For any command expected to take more than ~5 seconds (test suites, builds, commit/push hooks, Docker scenarios):

1. **Announce before running** — one sentence: what runs and the expected duration (e.g. "pre-commit hook ~40s: format + lint + build + tests").
2. **Over ~60 seconds: stream progress** — run the command in the background and surface its progress markers to the user as they appear (e.g. `tail -f <log> | grep -E --line-buffered "PASS|FAIL|\[sf-progress\]"`). Never block silently.
3. **Report the outcome with numbers** — suites passed/failed, duration — not just "done".

## 📦 Tech Stack

### Backend (apps/api/)
- **Framework**: NestJS 11
- **Database**: PostgreSQL 16 + Prisma 7
- **Auth**: JWT + Passport
- **Validation**: Zod 4
- **Testing**: Jest + Supertest
- **API Docs**: OpenAPI/Swagger

### Frontend (apps/web/)
- **Framework**: React 19 + React Router v7
- **Build**: Vite 7
- **Styling**: TailwindCSS 4 + ShadCN UI
- **State**: React Query + React Hook Form
- **i18n**: i18next (French + English)
- **Testing**: Playwright

### Monorepo Tools
- **Build System**: Turborepo (parallel builds, caching)
- **Package Manager**: npm workspaces
- **Git Hooks**: Husky + Commitlint (conventional commits)
- **Linting**: ESLint (shared config)
- **Formatting**: Prettier (shared config)

## 🛠️ Available Skills

All skills are located in `.claude/` at the root and are available across the entire monorepo.

### Core Skills (Always Available)

#### Git Workflows
- **`sf-git-commit`** - Create commits with conventional messages
- **`sf-git-create-pr`** - Generate PR with auto-generated description
- **`sf-git-fix-pr-comments`** - Implement PR review feedback
- **`sf-git-merge`** - Intelligent branch merging

#### Code Quality
- **`sf-utils-fix-errors`** - Fix ESLint and TypeScript errors in parallel
- **`sf-utils-fix-grammar`** - Fix grammar and spelling

#### Integration grammar
- **`sf-integration-rules`** - Integration grammar router. Triggers when adding a backend module, a page, an API hook, a form, an RBAC permission, or any cross-cutting wire-up. Routes to `backend.md` / `frontend.md` / `topology.md` sub-guides.

#### Development Workflows
- **`sf-utils-oneshot`** - Ultra-fast feature implementation
- **`sf-workflow-apex-free`** - APEX methodology (Analyze-Plan-Execute-Validate)
- **`sf-workflow-apex`** - APEX with adversarial review (for critical features)

### Advanced Skills (Optional - Require Configuration)

- **`sf-tool-context7`** - Up-to-date library documentation (React, Vite, Prisma, etc.)
- **`sf-tool-atlassian`** - Jira/Confluence integration
- **`sf-tool-notion`** - Notion workspace integration
- **`sf-tool-figma`** - Figma design system integration

> **Note**: Advanced skills require API tokens. Configure them during `sf new` or when Claude prompts you.

## 🚀 Common Commands

### Monorepo-wide
```bash
npm run dev               # Start all apps in parallel
npm run build             # Build all apps
npm run test              # Run all tests
npm run lint              # Lint all apps
npm run format            # Format all apps
```

### App-specific
```bash
npm run dev:api           # Start API only
npm run dev:web           # Start Web only
npm run test:api          # Test API only
npm run test:web          # Test Web only
```

## 📖 Git Workflow

- Main branch: `{{MAIN_BRANCH}}`
- **ALWAYS** use conventional commits: `<type>(#<ticket>): <description>`
- Types: feat, fix, docs, style, refactor, perf, test, chore
- Scope (ticket number) is required
- Max header: 100 characters
- Husky enforces commit format + pre-push checks

### Commit Examples

_Ticket numbers below are illustrative — always use the number of the ticket you are working on._
```bash
feat(#42): add user profile endpoint
fix(#43): resolve JWT token expiration
docs(#44): update API documentation
```

## 🤖 AI-Assisted Development

### Using Skills
```bash
# Let Claude handle commits
"Commit these changes"  # → sf-git-commit

# Fix errors across the monorepo
"Fix all TypeScript errors"  # → sf-utils-fix-errors

# Implement complex features
"Use APEX workflow to add real-time notifications"  # → sf-workflow-apex
```

### Best Practices
- ✅ Skills respect monorepo structure (apps/api, apps/web)
- ✅ Git hooks validate all AI-generated commits
- ✅ Tests run automatically before push
- ✅ Use CLAUDE.md files in apps/ for app-specific context

## 📚 Documentation

- **API Docs**: `http://localhost:3500/api/docs` (when API is running)
- **App-specific context**: Check `apps/api/CLAUDE.md` and `apps/web/CLAUDE.md`
- **Skills**: Check `.claude/README.md` for detailed skill documentation

## 🔧 Troubleshooting

**Turborepo cache issues?**
```bash
npx turbo clean
npm install
```

**Git hooks not working?**
```bash
npx husky
```

**Skills not loading?**
- Ensure you're at the monorepo root when starting Claude
- Check `.claude/` directory exists and contains skills

---

**Generated with SaaSFoundryAI v1.0.0-beta** - Check `.saasfoundry.json` for configuration and installed modules.
