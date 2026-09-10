# SaaSFoundryAI

CLI tool that scaffolds production-ready SaaS projects (NestJS + React + PostgreSQL + Docker).

## 🧭 Preconditions first (read before asking questions)

Before asking the user anything about scope, backend, or module choices, **read the manifest and check the configured tools**:

1. Read `.saasfoundry.json` — this is the source of truth for workflow, SRS backend, and installed modules. Never re-ask what is already declared there.
2. Run `sf status --claude-friendly --no-network` to get a summary of the manifest, installed modules, and preconditions. On a configured session this is also auto-injected via the `SessionStart` hook
   in `.claude/settings.json`.
3. Only surface scope questions for things that are **not** resolvable from the manifest (e.g. genuine product decisions). If a precondition is `fail`, route the user to the relevant install/config
   CLI (`sf workflow`, `sf skill install`, etc.) instead of asking scope questions.

## Coding-agent identity and onboarding

Use the coding-agent identity explicitly supplied by the current host or session. Never infer it from a model/provider name, executable, repository file, or PATH. If the identity is absent or
ambiguous, ask the user to choose a registered coding-agent profile and do not change the project.

Run `sf agents list --json`. When the current supported tool is undeclared, ask the user to choose one action: add it, replace the declaration with an explicitly named non-empty set, or leave the
project unchanged. Ask whether the choice is local to this checkout or shared through the repository only after add or replace is accepted. Use `sf agents enable` for add and `sf agents replace` for
exact replacement. No change runs no mutating command. Replacement changes inventory only and never deletes existing instructions, skills, hooks, settings, credentials, or exclusions.

This rule exists because AI sessions historically asked users to re-pick the SRS backend (notion/atlassian/local-markdown) and parent page even though both were already in the manifest — those answers
must come from `.saasfoundry.json`, not from a fresh dialogue.

## 🌐 Output language

Everything produced here — SRS pages, tickets and their comments, code comments, commit messages, docs — is written in the language declared in `.saasfoundry.json` → `language`, which is English on
all three surfaces (`srs`, `tickets`, `codeComments`).

**The language of the conversation is not the signal.** Sessions are often held in French; the artefacts stay English. `sf status --claude-friendly` prints the resolved values.

## 🚨 Critical Rules (non-negotiable)

**We are dogfooding our own system.** Users of SaaSFoundryAI will rely on their AI agents to follow the workflows we generate. If we don't follow ours rigorously, we can't guarantee the system works.

### Workflow — NEVER bypass

- **Statuses**: `Backlog → Ready → In progress → AI testing → Human testing → In review → Done`
- **Before any status transition**: read `.claude/skills/sf-workflow/statuses/<N>-<name>.md` for mandatory actions and exit conditions
- **Never skip statuses.** In particular: never go Backlog → AI Testing, open a draft PR for Human Testing and never mark it ready before human validation (unless ticket carries `nature:internal`).
  Delivery tickets require a verified merged PR before Done, except validated `nature:bundled-pr` children. Epics own no PR and reach Done only after every native child has board status Done.
- **Nature axis (Human Testing optionality)** — `nature:internal` tickets (refactor / scaffolding / non-terminal stories of an Epic) may transition AI Testing → In Review directly. Default (no label
  or `nature:user-facing`) requires Human Testing. The `update-status` guard enforces this — see `.claude/skills/sf-workflow/SKILL.md` "Nature axis" section.
- **Never bypass the CLI**: use `.claude/skills/sf-workflow/workflow-cli.sh` and `.claude/skills/sf-tool-github-projects/github-projects-cli.sh` — not raw `gh api graphql` mutations
- **Heavy validation before Human Testing:** run `npm run test:pre-push` explicitly during AI Testing and record the result. Iterative pushes do not run Docker.
- **Commit + push BEFORE moving to AI Testing.** Code must be on remote before any testing phase.
- **Subtasks must be real GitHub issues** (not checkboxes), created via `.claude/skills/sf-tool-github-projects/github-projects-cli.sh create-subtask`

### Migration framework — NEVER bypass

The migration framework (Epic #310) only delivers value if every breaking change runs through it. Inline shims in `sf update`, ad-hoc type mutations, and "the user can fix their manifest manually"
shortcuts reintroduce exactly the cross-version drift the framework was built to prevent.

- **Manifest shape changes** — Any breaking change to `SaaSFoundryManifest` (renaming a field, removing one, restructuring a sub-block) MUST ship as a numbered migration in
  `src/migrations/manifest/NNN-<name>.ts` with a registered entry in `src/migrations/manifest/index.ts`, a JSON-schema delta in `schemas/saasfoundry-manifest.schema.json`, and a golden fixture pair
  under `src/__tests__/unit/migrations/fixtures/NNN-<name>/`. Never mutate manifests inline in commands; never bump `manifestVersion` without registering a migration.
- **Module file-set changes** — Any breaking change to a module's installed file set (renaming a service file, splitting an installer's deposited files, requiring a new env var) MUST bump the
  installer's `currentVersion` in `<name>.installer.ts` AND ship a `ModuleMigration` on its `migrations` array. Use `writeMigratedFile` from `src/migrations/module/conflict.ts` so user-edited files
  fall back to a `.saasfoundry.new` sidecar.
- **Read the playbook first** — Before editing `src/types.ts`, `schemas/saasfoundry-manifest.schema.json`, any installer's deposited templates, or any file under `src/migrations/`, read
  `.claude/docs/migration-framework.md`. It covers the registry pattern, the file-naming convention, the conflict-aware writer, and worked examples for both manifest renames and module file splits.

### Reading before acting

- Workflow: `.claude/skills/sf-workflow/SKILL.md` and the `statuses/` files
- SRS drafting / spawning: `.claude/skills/sf-srs/SKILL.md`
- Integration grammar (adding modules / pages / endpoints): `.claude/skills/sf-integration-rules/SKILL.md`
- CLI orchestration (`sf new`, `sf update`, `sf workflow`, feedback flows): `.claude/skills/tool-saasfoundry/SKILL.md` — symlinked to `scaffolds/skills-templates/tool-saasfoundry/` so contributor
  edits land in the source of truth
- Module architecture (adding/modifying modules): `.claude/docs/architecture-modules.md`
- Skills architecture (adding/modifying skills): `.claude/docs/architecture-skills.md`
- Migration framework (any breaking manifest/module change): `.claude/docs/migration-framework.md`
- Workflow configuration: `.saasfoundry.json` (source of truth — never hardcode branch names, status names, etc.)

## Tech Stack

- **CLI**: Node.js, Commander, Inquirer, TypeScript
- **Generated Backend**: NestJS 11, Prisma 7 (driver adapters + PrismaPg), PostgreSQL 16, JWT + Passport, Zod 4
- **Generated Frontend**: React 19, React Router v7, Vite 7, TailwindCSS 4, Radix UI (unified), ShadCN UI, React Query, React Hook Form + Zod 4, i18next
- **Infra**: Docker multi-stage builds, Nginx, `saasfoundry-network`

## Project Structure

```
src/
├── commands/         # CLI commands (new.ts, update.ts, workflow.ts)
├── prompts/          # Inquirer prompt definitions (project.prompts.ts, update.prompts.ts, workflow.prompts.ts)
├── builders/         # Project scaffolding builders (api, web, monorepo, dev-services, db, s3)
├── installers/       # Reusable module installers (email, storage, analytics)
├── runners/          # Post-setup runners (database, s3, server, terminal)
├── types.ts          # All interfaces and path constants
├── utils.ts          # Utility functions
└── index.ts          # CLI entrypoint (Commander)
scaffolds/
├── blueprints/       # Base templates (api/, web/, db/, s3/)
└── overlays/         # Topology overrides + optional module overlays
    ├── monorepo/     # Monorepo-specific overrides (root/, api/, web/)
    ├── multirepo/    # Multirepo-specific overrides (api/, web/)
    └── modules/      # Optional feature modules (email/, storage/, analytics/)
tests/
└── docker/           # Docker-based real build tests (see `npm run test:docker:list`)
bin/                  # CLI entrypoint (sf.js)
scripts/              # Version management (tag-manager.sh)
```

## CLI Commands

- `sf new` — Create a new SaaSFoundryAI project (src/commands/new.ts)
- `sf update` — Add modules to an existing project (src/commands/update.ts)
- `sf workflow` — Manage workflow configuration and AI rules (src/commands/workflow.ts)

### Dev Commands

- `npm run build` — Compile CLI
- `npm run dev` — Watch mode for CLI development
- `npm run format` — Prettier
- `npm run lint` — ESLint
- `npm run test:pre-commit` — Format + Lint + Type-check + Jest tests (runs on pre-commit, ~15s)
- `npm run test:pre-push` — Top 2 Docker scenarios (run explicitly during AI Testing before Human Testing, ~2-3 min)
- `npm run test:full` — Alias: `test:pre-commit` + `test:pre-push` (full local validation)
- `npm run test:docker` — All Docker scenarios (~70 min; `test:docker:list` prints the current set, `--count` the number)
- `npm run test:docker -- --count N` — Top N priority scenarios
- `npm run test:docker -- --scenario <name>` — Single scenario
- `npm run test:docker:list` — Show all scenarios
- One of them, `multirepo-boot-and-test`, **starts** a generated project instead of compiling it — `sf new --start-services` against a Postgres inside the test image, then `/api/health` and the web
  root must answer, then `npm audit` and the api's own unit suite. It runs on PRs to both branches; the rest of the matrix compiles only (#594).

## Git Workflow

- Working branch: `develop`, release branch: `master` (see `.saasfoundry.json` → `workflow.workingBranch` / `releaseBranch`)
- **ALWAYS** use conventional commits: `<type>(#<ticket>): <description>`
- Types: feat, fix, docs, style, refactor, perf, test, chore, ci, build, revert
- Scope (ticket number) is required by commitlint
- Max header length: 100 characters
- Husky enforces commit format and local commit checks; heavy Docker validation runs explicitly during AI Testing
- RC branches (`rc-*`) trigger automated version management

## Code Conventions

### Backend (scaffolds/blueprints/api/)

- Module pattern: `module.ts`, `controller.ts`, `service.ts`, `dto/*.dto.ts`, `tests/unit/*.spec.ts`, `tests/e2e/*.spec.ts`
- Path aliases: `@modules/*`, `@common/*`, `@configs/*`, `@/*`
- Prisma multi-file schemas in `prisma/schema/`
- Validation with class-validator + class-transformer
- Logging with Winston (daily rotation)

### Frontend (scaffolds/blueprints/web/)

- Pages in `src/pages/private/` and `src/pages/public/`
- Lazy-loaded routes with code splitting
- API hooks in `src/hooks/api/`
- UI components in `src/components/ui/` (ShadCN)
- Translations in `src/locales/` (YAML format)
- Path alias: `@/*` → `./src/*`

## Docker

- Dev database: `docker-compose.db.yml` (port 5435 by default — `sf new` moves to the next free port and records the choice in `.saasfoundry.json` → `ports`, see #584)
- External network: `docker network create saasfoundry-network`
- API health check: `GET /api/health`
- Build tests: `Dockerfile.test` + `tests/docker/` — generates real projects and runs `npm install` + `tsc` + `nest build` + `vite build`

## Important Context

- This is a **scaffold/generator** CLI — the code in `scaffolds/` is template code, not application code
- **NEVER** modify scaffold templates without considering the impact on generated projects
- Current version: 1.0.0-beta (npm package `saasfoundryai-cli`)
- Node.js >= 22.13.0 to run the CLI (its own `.nvmrc` says 22.15.0)
- **The generated API and web app run different TypeScript majors, on purpose.** The API is pinned to **5.9.x** with `ignoreDeprecations: "5.0"`; the web app is on 6.x. NestJS 11's OpenAPI CLI plugin
  cannot read the TypeScript 6 AST — it emits `{ enum: string }`, a bare identifier with no runtime value, and **no generated API can start**. The compiler, the build and the unit suite all stay
  green, because the metadata is only invalid at runtime. See #595 for the measurement and #643 for what happened when the difference was mistaken for drift and "fixed". It stops being a constraint
  the day the backend moves to NestJS 12, which is an ESM migration — see `.claude/docs/embedded-dependencies.md`.
- **Generated projects ask for Node 24** — their `.nvmrc` says 24.19.0, because they declare `npm >= 11` with `onFail: error` and Node 22 ships npm 10. The CLI reads the target project's `.nvmrc`
  before shelling out to `npm`; it does not impose its own version. See #589 — the two used to be assumed identical, and every `npm run` in a generated project was refused.
