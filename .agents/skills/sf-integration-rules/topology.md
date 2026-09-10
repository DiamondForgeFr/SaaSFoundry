# Topology — monorepo vs multirepo divergence

Where shared code lives depends on the project's **structure** declared in `.saasfoundry.json`. This guide is the authoritative override for the monorepo-vs-multirepo bits of `backend.md` and
`frontend.md` — when the two disagree, this file wins.

## Detect the topology (anchor)

**Always read the manifest first.** Don't infer from directory listings.

```bash
sf status --claude-friendly --no-network
```

Sample output:

```
- project: my-app (monorepo, v1.0.0-beta)
- workflow: github-projects
- srs: notion — my-app-srs
```

The token after `(` is the structure: `monorepo`, `multirepo`, or `cli`. If you can't run the CLI, read the manifest directly:

```jsonc
// .saasfoundry.json
{
  "version": "1.0.0-beta",
  "structure": "monorepo",
  "projectName": "my-app",
  "workflow": { "tool": "github-projects", "workingBranch": "develop" },
  "tools": { "srs": { "enabled": true, "backend": "notion" } }
}
```

Fallback heuristic when the manifest is missing: `packages/` exists at the repo root → monorepo; otherwise → multirepo. Treat that as a last resort and surface a warning to the user.

## Monorepo workspace layout (anchor)

The monorepo overlay ships a 5-package workspace:

```
<project>/
├── apps/
│   ├── api/                   # NestJS app (mirrors packages/* under src/)
│   └── web/                   # React app (mirrors packages/* under src/)
└── packages/
    ├── shared-types/          # @<project>/shared-types — domain TS interfaces
    ├── shared-validation/     # @<project>/shared-validation — Zod factory schemas
    ├── shared-config/         # @<project>/shared-config — runtime constants (limits, etc.)
    ├── api-client/            # @<project>/api-client — orval-generated React Query hooks
    └── ui-primitives/         # @<project>/ui-primitives — shadcn primitives + theme.css
```

The root `package.json` declares the workspace:

```json
{
  "name": "<project>",
  "workspaces": ["apps/*", "packages/*"],
  "packageManager": "npm@10.9.2"
}
```

**Multirepo has no `packages/`** — `apps/api/` and `apps/web/` are standalone, so types and validation are duplicated by design (see "Multirepo trade-off" below).

## Mirror vs canonical rule (anchor)

This is the single most important rule on monorepo: **`packages/<name>/src/` is canonical; `apps/<app>/src/<name>/` is a vendored mirror.** Both copies must stay byte-identical.

| Concern             | Canonical (monorepo)                   | Mirrors (monorepo)                                                                 | Multirepo                                                                            |
| ------------------- | -------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Domain TS types     | `packages/shared-types/src/`           | `apps/api/src/shared-types/` + `apps/web/src/shared-types/`                        | `apps/api/src/shared-types/` + `apps/web/src/shared-types/` (no canonical)           |
| Zod factory schemas | `packages/shared-validation/src/`      | `apps/api/src/shared-validation/` + `apps/web/src/shared-validation/`              | `apps/api/src/shared-validation/` + `apps/web/src/shared-validation/` (no canonical) |
| Runtime constants   | `packages/shared-config/src/`          | (none — apps consume the workspace package directly)                               | inlined in the consumer service (no shared module)                                   |
| API client hooks    | `packages/api-client/src/generated/`   | (none — orval-generated, regenerated from OpenAPI)                                 | hand-written under `apps/web/src/hooks/api/<feature>/`                               |
| UI primitives       | `packages/ui-primitives/src/`          | (none — web imports from the workspace package)                                    | vendored at `apps/web/src/components/ui/shadcn/`                                     |
| Theme tokens        | `packages/ui-primitives/src/theme.css` | imported via `@import '@<project>/ui-primitives/theme.css'` in `web/src/index.css` | inlined in `apps/web/src/index.css`                                                  |

**Why mirrors at all on monorepo?** The path alias `@shared-types/*` (resolved by `tsconfig.json` of each app) keeps working without rewiring imports per topology. The mirrors also let each app build
independently (`npm run build -w apps/api` doesn't need the web workspace). The drift-guards make the duplication safe.

### Drift-guards enforce identity

Three integration tests at the CLI level keep the copies coherent:

```
src/__tests__/integration/skill/shared-types-drift.spec.ts
src/__tests__/integration/skill/shared-validation-drift.spec.ts
src/__tests__/integration/skill/ui-primitives-drift.spec.ts
```

`shared-types-drift` and `shared-validation-drift` enforce **byte-identity** between the canonical workspace and both blueprint mirrors. `ui-primitives-drift` normalizes the canonical file (rewrites
internal imports from `'./button'` to `'@/components/ui/shadcn/button'`, `'./lib/utils'` to `'@/utils/ui'`, etc.) before comparing — primitives must use workspace-relative imports in the canonical and
aliased imports in the vendored copy.

### Editing discipline on monorepo

When you change a domain type or schema:

1. Edit the **canonical** file in `packages/<name>/src/<domain>.ts`
2. Mirror the same change to **`apps/api/src/<name>/<domain>.ts`**
3. Mirror the same change to **`apps/web/src/<name>/<domain>.ts`**
4. Re-export from `index.ts` if it's a new file (in all three locations)
5. Run `npm run test:unit` — the drift-guard fails fast if you forgot one

**Skipping a mirror is the #1 silent monorepo bug.** It compiles locally because TS picks up the path alias and the workspace package independently — divergence only surfaces in CI or in a docker test
scenario.

## Module-deposit pattern (mono only) (anchor)

Some module installers (`storage`, `email`) **deposit** files into `packages/shared-*` rather than vendoring three copies. Deposits are:

- **Idempotent** — `sf update` won't duplicate them
- **Activation-gated** — only written when the consuming module is installed
- **Multi-aware** — multirepo inlines the same content per app; parity assertions in the docker tests enforce that the inlined and deposited copies stay byte-identical

| Module  | Mono deposit                            | Multi inlined location                               |
| ------- | --------------------------------------- | ---------------------------------------------------- |
| storage | `packages/shared-config/src/storage.ts` | inlined in `apps/api/.../organization.controller.ts` |
| email   | `packages/shared-types/src/email.ts`    | inlined in `apps/api/.../mailersend.service.ts`      |

If you're adding a third module that needs shared constants/types, follow the same shape: a deposit on monorepo, an inlined literal on multirepo, and a parity assertion that fails when they drift.

## API client + codegen (monorepo) (anchor)

`packages/api-client/` is **regenerated**, never hand-edited. The flow:

1. Add or change an endpoint in `apps/api/src/modules/<name>/`
2. `npm run dev:api` (boots the API; emits `apps/api/docs/openapi.json` snapshot)
3. `npm run codegen` (orval reads the snapshot → regenerates `packages/api-client/src/generated/api/`)
4. Commit `apps/api/docs/openapi.json` **and** `packages/api-client/src/generated/` together

Orval emits one file per `@ApiTags()` group with React Query hooks:

```
packages/api-client/src/generated/api/
├── organizations/organizations.ts   # useGetOrganization, useCreateOrganization, ...
├── accounts/accounts.ts
└── health/health.ts
```

A web page consumes the generated hook directly — no hand-written wrapper unless cross-cutting logic is needed:

```ts
import { useGetOrganization } from '@<project>/api-client/generated/api/organizations/organizations'
// or wrap it under apps/web/src/hooks/api/organizations/queries/useFetchOrganization.ts
// when you need a Zod-parsed return shape, optimistic updates, or a stable queryKey contract
```

**When does codegen need to re-run?**

| Change                                      | Re-run codegen? |
| ------------------------------------------- | --------------- |
| New controller route or HTTP method         | Yes             |
| Add / remove / rename a DTO field           | Yes             |
| Change the request or response Zod schema   | Yes             |
| Move endpoint to a different `@ApiTags()`   | Yes             |
| Refactor a service body (no surface change) | No              |
| Frontend-only edits                         | No              |

A drift-guard script (`scripts/check-codegen-drift.sh`) catches PRs that forgot to commit the regenerated client.

**Multirepo has no codegen.** The web app talks to the API via hand-written hooks under `apps/web/src/hooks/api/` (see `frontend.md` API-hooks section).

## Workspace import syntax (anchor)

On monorepo, packages are imported by their scoped name `@<project>/<package>`. The `<project>` placeholder is substituted at scaffold time by `monorepo.builder.ts`:

```ts
// monorepo.builder.ts
await substitutePlaceholdersInFiles(['packages/shared-types/package.json', 'packages/shared-validation/package.json' /* ... */], { PROJECT_NAME: projectName })
```

After substitution, real imports look like:

```ts
import { SHARED_CONFIG_PLACEHOLDER } from '@my-app/shared-config'
import type { Organization } from '@my-app/shared-types'
import { buildSignupPayloadSchema } from '@my-app/shared-validation'
```

In the SaaSFoundryAI **scaffold sources** you'll see imports written with a literal `PROJECT_NAME` mustache token — those are templates. **Never** ship a placeholder import to a generated project; the
builder must substitute first.

## Multirepo trade-off (anchor)

Multirepo intentionally duplicates types, validation, and UI primitives:

```
apps/api/src/shared-types/<domain>.ts        # one copy
apps/web/src/shared-types/<domain>.ts        # second copy, byte-identical
```

**Why not extract a workspace?** Multirepo means each app can be deployed, versioned, and tested in isolation — at the cost of the duplication. The trade-off is:

- ✅ Each app builds without a sibling — useful when api/ and web/ are deployed by different teams or pipelines
- ✅ No npm workspace plumbing in CI
- ❌ Type/schema drift is silent until runtime — the SaaSFoundryAI CLI's docker assertions enforce byte-identity at build-test time, but there's no fast local feedback loop
- ❌ Constants like `STORAGE_LOGO_MAX_BYTES` get inlined per consumer (no `shared-config` equivalent)

When you edit a multirepo type or schema:

1. Edit `apps/api/src/<name>/<domain>.ts`
2. Edit `apps/web/src/<name>/<domain>.ts` with the **identical** content
3. Run the docker assertion suite or the e2e tests — divergence shows up there

The same drift-guard story as monorepo, minus the canonical source.

## Worked example — add an `Invoice` aggregate

This walks through the same task on both topologies so the divergence is concrete. The backend module work itself is identical (see `backend.md`'s worked example) — what changes is **where the shared
bits land**.

### Monorepo

1. **Type** — edit canonical first, then both mirrors:

   ```
   packages/shared-types/src/invoice.ts                 # canonical, edit first
   apps/api/src/shared-types/invoice.ts                 # mirror, byte-identical
   apps/web/src/shared-types/invoice.ts                 # mirror, byte-identical
   ```

   Re-export from `index.ts` in all three.

2. **Validation** — same three-copy pattern:

   ```
   packages/shared-validation/src/invoice.ts            # canonical
   apps/api/src/shared-validation/invoice.ts            # mirror
   apps/web/src/shared-validation/invoice.ts            # mirror
   ```

3. **Backend module** — under `apps/api/src/modules/invoices/` exactly as `backend.md` describes. The DTOs import from `@shared-validation/invoice` (path alias resolves into the api app's mirror;
   behaviour is identical to importing from `@<project>/shared-validation`).

4. **Apply schema + RBAC seed** — `npm run db:setup:dev` in `apps/api/` (migration-free: db push --force-reset + apply prisma/sql/\*).

5. **Regenerate the API client**:

   ```bash
   npm run codegen
   ```

   This adds `packages/api-client/src/generated/api/invoices/invoices.ts` with `useCreateInvoice`, `useGetInvoices`, etc.

6. **Frontend page** — as `frontend.md` describes. The query hook calls the generated function:

   ```ts
   import { invoicesControllerListInvoices } from '@<project>/api-client/generated/api/invoices/invoices'
   ```

7. **UI primitives** — already available via `@<project>/ui-primitives/<name>` (Button, Table, …); no per-app vendoring needed.

8. **Run** — `npm run test:full` runs format + lint + type-check + unit + e2e + drift-guards across the workspace.

### Multirepo

1. **Type** — edit both copies in lockstep, no canonical:

   ```
   apps/api/src/shared-types/invoice.ts
   apps/web/src/shared-types/invoice.ts                 # byte-identical
   ```

2. **Validation** — same:

   ```
   apps/api/src/shared-validation/invoice.ts
   apps/web/src/shared-validation/invoice.ts            # byte-identical
   ```

3. **Backend module** — under `apps/api/src/modules/invoices/` exactly as `backend.md` describes (no monorepo divergence here).

4. **Apply schema + RBAC seed** — `npm run db:setup:dev` in `apps/api/` (migration-free: db push --force-reset + apply prisma/sql/\*).

5. **No codegen.** Hand-write the API client hook under `apps/web/src/hooks/api/invoices/queries/useFetchInvoices.ts` using `apiClient.get<FetchInvoicesResponseDto>('/invoices?accountId=...')` — see
   `frontend.md`.

6. **Frontend page** — as `frontend.md` describes. The query hook is the hand-written one.

7. **UI primitives** — already vendored at `apps/web/src/components/ui/shadcn/<name>.tsx`.

8. **Run** — `npm run test:full` in each app.

The two paths produce equivalent runtime behaviour. The monorepo path enforces type identity and saves you from hand-writing API hooks; the multirepo path keeps each app independent at the cost of
duplication.

## Decision matrix (anchor)

When you're about to add a file, walk this matrix:

| I'm adding…                                        | Monorepo path                                            | Multirepo path                                          |
| -------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------- |
| A domain TS type / interface                       | `packages/shared-types/src/<domain>.ts` + 2 mirrors      | `apps/{api,web}/src/shared-types/<domain>.ts` (×2)      |
| A Zod request/payload schema                       | `packages/shared-validation/src/<domain>.ts` + 2 mirrors | `apps/{api,web}/src/shared-validation/<domain>.ts` (×2) |
| A runtime constant shared by api + web             | `packages/shared-config/src/<topic>.ts`                  | inline in both consumers (no shared module)             |
| A backend controller / service / DTO               | `apps/api/src/modules/<name>/...`                        | `apps/api/src/modules/<name>/...`                       |
| A frontend page                                    | `apps/web/src/pages/{private,public}/<feature>/`         | `apps/web/src/pages/{private,public}/<feature>/`        |
| A React Query hook for an API endpoint             | consume `@<project>/api-client/...` (or wrap it)         | hand-write `apps/web/src/hooks/api/<feature>/...`       |
| A new UI primitive (Button-style, generic)         | `packages/ui-primitives/src/<name>.tsx`                  | `apps/web/src/components/ui/shadcn/<name>.tsx`          |
| An app-specific composition (logo, page-loader, …) | `apps/web/src/components/ui/custom/<name>.tsx`           | `apps/web/src/components/ui/custom/<name>.tsx`          |
| A theme token                                      | `packages/ui-primitives/src/theme.css`                   | `apps/web/src/index.css` (inlined)                      |

**If you can't tell the topology from `.saasfoundry.json`, stop and ask.** Don't guess — the wrong placement creates silent drift the user will only discover later.
