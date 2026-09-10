# {{PROJECT_NAME}} API

Production-ready NestJS API generated with **SaaSFoundryAI** - An AI-First development platform.

## 🧭 Preconditions first (read before asking questions)

Before asking the user anything about scope, backend, or module choices, **read the manifest and check the configured tools**:

1. Read `.saasfoundry.json` — the source of truth for workflow, SRS backend, and installed modules. Never re-ask what is already declared there.
2. Run `sf status --claude-friendly --no-network` to get a summary of the manifest, installed modules, and preconditions. A `SessionStart` hook in `.claude/settings.json` also auto-injects this
   summary at session start.
3. Only ask about things that are **not** resolvable from the manifest. If a precondition is `fail`, route the user to the relevant install/config CLI (`sf workflow`, `sf skill install`, etc.) instead
   of opening a scope dialogue.

## Coding-agent identity and onboarding

Use the coding-agent identity explicitly supplied by the current host or session. Never infer it from a model/provider name, executable, repository file, or PATH. If the identity is absent or
ambiguous, ask the user to choose a registered coding-agent profile and do not change the project.

Run `sf agents list --json`. When the current supported tool is undeclared, ask the user to choose one action: add it, replace the declaration with an explicitly named non-empty set, or leave the
project unchanged. Ask whether the choice is local to this checkout or shared through the repository only after add or replace is accepted. Use `sf agents enable` for add and `sf agents replace` for
exact replacement. No change runs no mutating command. Replacement changes inventory only and never deletes existing instructions, skills, hooks, settings, credentials, or exclusions.

## Tech Stack

- **Backend**: NestJS 11, Prisma 7 (driver adapters + PrismaPg), PostgreSQL 16
- **Auth**: JWT + Passport (access + refresh tokens)
- **Validation**: Zod 4 + class-validator
- **Testing**: Jest (unit) + Supertest (E2E)
- **Logging**: Winston (daily rotation)
- **API Docs**: OpenAPI/Swagger (auto-generated)

## 🎯 Skills Priority

**IMPORTANT**: This project uses SaaSFoundryAI skills (prefix `sf-*`). When multiple skills with similar functionality exist, **always prefer SaaSFoundryAI skills** over global or other skills:

- ✅ Use `sf-git-commit` instead of `git-commit`
- ✅ Use `sf-utils-fix-errors` instead of `utils-fix-errors`
- ✅ Use `sf-workflow-apex` instead of `workflow-apex`
- ✅ Use `sf-tool-atlassian` instead of `tool-atlassian`

SaaSFoundryAI skills are specifically optimized for this project's structure, conventions, and workflows.

## Project Structure

```
src/
├── common/           # Filters, guards, interceptors, pipes
├── configs/          # Configuration modules (DB, env, API docs, test)
└── modules/          # Feature modules
    ├── auth/         # Authentication & authorization
    ├── users/        # User management
    ├── organizations/  # Multi-tenant organizations
    ├── invitation/   # User invitations
    └── email/        # Email service (optional: MailerSend)
```

## Code Conventions

### Module Pattern

```
module-name/
├── module.ts              # NestJS module definition
├── controller.ts          # HTTP endpoints
├── service.ts             # Business logic
├── dto/                   # Data transfer objects
│   ├── create-*.dto.ts
│   ├── update-*.dto.ts
│   └── query-*.dto.ts
└── tests/
    ├── unit/*.spec.ts     # Unit tests
    └── e2e/*.spec.ts      # E2E tests
```

### Path Aliases

- `@modules/*` → `src/modules/*`
- `@common/*` → `src/common/*`
- `@configs/*` → `src/configs/*`
- `@shared-types/*` → `src/shared-types/*` (cross-wire TypeScript types)
- `@shared-validation/*` → `src/shared-validation/*` (Zod schemas reused on the web side)
- `@/*` → `src/*`

### Validation

- **DTOs**: Use Zod schemas via `nestjs-zod`'s `createZodDto`. Schemas are factory functions defined under `src/shared-validation/` and shared with the frontend.
- **Decorators**: `@ApiProperty()` for OpenAPI docs
- **Transform**: Use `class-transformer` for type coercion

### 📦 Shared layers (mono vs multi)

This blueprint always carries vendored copies of `src/shared-types/` and `src/shared-validation/` — those are the working source the API actually compiles against. The behavior diverges by topology:

- **In a monorepo** (root has `packages/shared-*`): the same files also exist canonically at `<root>/packages/shared-{types,validation}/src/`, plus a non-vendored `<root>/packages/shared-config/`.
  **Hand-written types/schemas live in all three places** (canonical workspace + both apps' mirrors) and the SaaSFoundryAI CLI's drift-guard tests block divergence. **Module-deposited types/constants**
  (e.g. `EmailOptions`, `STORAGE_LOGO_*`) live in the workspace only and the relevant API service is rewired to import them via `@<root-package-name>/shared-{types,config}` — **do not duplicate them
  into `src/shared-types/`** or you'll have two sources of truth.
- **In multirepo** (this app stands alone, no `packages/`): only the vendored copies under `src/shared-{types,validation}/` exist; module-shared values that would live in `shared-config` on mono are
  **inlined** in the consumer here (e.g. `STORAGE_LOGO_MAX_BYTES` in `organization.controller.ts`, `EmailOptions` interface in `mailersend.service.ts`). Keep the inlined values stable — the
  SaaSFoundryAI CLI's docker assertions enforce that the multirepo path stays inlined.

When in doubt, run `sf status --claude-friendly --no-network` to confirm topology before editing shared shapes.

### Prisma Schema

- Multi-file schemas in `prisma/schema/`
- Soft deletes with `deletedAt` field
- Created/updated timestamps on all entities
- Relations follow NestJS naming (camelCase)

## Git Workflow

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
fix(#43): resolve JWT token expiration issue
docs(#44): update API documentation
```

## Development Commands

```bash
# Development
npm run dev                 # Start in watch mode

# Database (migration-free — the schema + prisma/sql/* ARE the source of truth)
npm run db:setup:dev        # (Re)build the dev DB: db push --force-reset + apply functions/triggers/datasets (DESTRUCTIVE)
npx prisma db push          # Sync a schema change into the dev DB without re-seeding (non-destructive)
npm run db:studio           # Open Prisma Studio

# Testing
npm run test:unit           # Run unit tests
npm run test:e2e            # Run E2E tests
npm run test:full           # Format + Lint + Type-check + Tests

# Code Quality
npm run format              # Prettier
npm run lint                # ESLint
npm run type-check          # TypeScript

# Docker
docker compose -f docker-compose.dev-services.yml up -d  # Start DB + S3
docker compose -f docker-compose.dev-services.yml down   # Stop services
```

## 🤖 AI-Assisted Development

This project is pre-configured for AI development with Claude Code.

### 📣 Long-running commands (announce + stream)

The screen must never freeze silently. For any command expected to take more than ~5 seconds (test suites, builds, commit/push hooks, Docker scenarios):

1. **Announce before running** — one sentence: what runs and the expected duration (e.g. "pre-commit hook ~40s: format + lint + build + tests").
2. **Over ~60 seconds: stream progress** — run the command in the background and surface its progress markers to the user as they appear (e.g. `tail -f <log> | grep -E --line-buffered "PASS|FAIL|\[sf-progress\]"`). Never block silently.
3. **Report the outcome with numbers** — suites passed/failed, duration — not just "done".

### 🛠️ Available Skills

Located in `.claude/skills/`:

#### Git Workflows

- **`/sf-git-commit`** - Quick commit with conventional messages
  - Auto-generates commit messages following project conventions
  - Includes ticket number and proper type

- **`/sf-git-fix-pr-comments`** - Implement PR review feedback
  - Fetches PR comments from GitHub
  - Implements requested changes automatically
  - Creates new commits with fixes

#### Integration grammar

- **`/sf-integration-rules`** - Integration grammar router. Triggers when adding a backend module, an API endpoint, a Prisma model, an RBAC permission, validation, or tests. Routes to `backend.md` /
  `frontend.md` / `topology.md` sub-guides — read first before scaffolding.

#### Code Quality

- **`/sf-utils-fix-errors`** - Fix ESLint and TypeScript errors
  - Parallel processing for fast fixes
  - Respects project conventions
  - Safe refactoring

- **`/sf-utils-fix-grammar`** - Fix grammar and spelling
  - Preserves code formatting
  - Works on markdown, comments, docs

#### Development Workflows

- **`/sf-workflow-apex-free`** - APEX methodology (Analyze-Plan-Execute-Validate)
  - Systematic feature implementation
  - Parallel agents for exploration
  - Self-validation with tests
  - Use for complex features

### 🎯 Common AI Workflows

#### Implement a new feature

```
User: "Add a user profile endpoint with avatar upload"
Claude: Uses /workflow-apex-free
1. Analyzes existing user module
2. Plans implementation (DTO, service, controller, tests)
3. Executes changes
4. Validates with tests
```

#### Fix errors after refactoring

```
User: "Fix all TypeScript errors"
Claude: Uses /utils-fix-errors
- Scans all files in parallel
- Fixes type errors
- Maintains code style
```

#### Create a commit

```
User: "Commit these changes"
Claude: Uses /git-commit
- Analyzes changed files
- Generates conventional commit message
- Includes Co-Authored-By: Claude
```

### ✅ Best Practices

**DO**:

- Trust the skills - they respect project conventions
- Let AI handle repetitive tasks (commits, error fixes)
- Use APEX workflow for complex features
- Review security-critical code manually

**DON'T**:

- Skip tests - AI code must pass all checks
- Bypass git hooks (`--no-verify`)
- Ignore TypeScript errors
- Over-rely on AI for business logic

### 🔒 Security Gates

All AI-generated code passes through:

- **Zod validation** - Runtime type checking
- **ESLint** - Code quality standards
- **TypeScript** - Compile-time safety
- **Jest tests** - Unit + E2E validation
- **Git hooks** - Pre-commit checks
- **CI/CD** - Automated deployment validation

## API Documentation

- **Interactive docs**: `http://localhost:3000/api/docs`
- **OpenAPI spec**: Auto-generated in `docs/openapi.json`
- **Update docs**: Decorators automatically update OpenAPI spec

## Environment Variables

See `.env.example` for required variables. Key variables:

```bash
# Database
DATABASE_URL="postgresql://..."
DIRECT_URL="postgresql://..."

# JWT Secrets (auto-generated during setup)
JWT_SECRET_AUTH="..."
JWT_SECRET_REFRESH="..."

# Optional: MailerSend Email
MAILERSEND_API_KEY="..."
MAILERSEND_SENDER_EMAIL="..."

# Optional: AWS S3 Storage
S3_ACCESS_KEY="..."
S3_SECRET_KEY="..."
S3_BUCKET="..."
```

## Testing

### Unit Tests

```bash
npm run test:unit
# Tests business logic in isolation
# Located in: src/**/*.spec.ts
```

### E2E Tests

```bash
npm run test:e2e
# Tests full HTTP request/response cycle
# Uses in-memory test database (tmpfs)
# Located in: src/**/tests/e2e/*.spec.ts
```

### Test Database

- Automatically created via `docker-compose.db-test.yml`
- Uses tmpfs for fast I/O
- Isolated from development database
- Cleaned between test runs

## Important Notes

- This is a **generated project** from SaaSFoundryAI v1.0.0-beta
- Check `.saasfoundry.json` for installed modules and configuration
- Update this CLAUDE.md as your project evolves
- No migration history — the DB is base setup: edit `prisma/schema` + `prisma/sql/*`, then `npx prisma db push` (schema sync) or `npm run db:setup:dev` (full rebuild + re-seed)

---

**Need help?** Check the [SaaSFoundryAI documentation](https://github.com/DiamondForgeFr/SaasFoundryAI) or use Claude Code skills for assistance.
