# Backend integration grammar (apps/api)

How to extend the NestJS API of a SaaSFoundryAI-generated project. **The canonical reference module is `apps/api/src/modules/organizations/`** — when in doubt, mirror its file layout, imports, and
decorator order. The `accounts/` module is a useful second reference (it adds `imports: [CommonModule]` to its module declaration and uses class-validator for some DTOs).

> Topology note. This guide describes patterns that are identical on monorepo and multirepo. Where shared code lives (canonical workspace vs vendored mirror) is covered by `topology.md`. Always run
> `sf status --claude-friendly --no-network` to confirm topology before touching files in `src/shared-{types,validation}/`.

## Module structure (anchor)

A new module under `apps/api/src/modules/<name>/` ships:

```
<name>/
├── <name>.module.ts              # NestJS module declaration
├── controllers/<name>.controller.ts
├── services/<name>.service.ts
├── dto/
│   ├── requests/create-<name>.dto.ts
│   ├── requests/update-<name>.dto.ts
│   └── responses/fetch_<name>.response.dto.ts
└── tests/
    ├── unit/<name>.service.spec.ts
    └── e2e/<name>.e2e-spec.ts
```

Module declaration shape (mirrors `organizations.module.ts`):

```ts
@Module({
  controllers: [OrganizationController],
  providers: [OrganizationService]
})
export class OrganizationsModule {}
```

If the module needs shared services (logger, prisma, etc.), add `imports: [CommonModule]` like `accounts.module.ts`.

**Register the module in `src/app.module.ts`** — add the import and append to the `imports: [...]` array. Do not register modules anywhere else.

## Controllers (anchor)

Class decorators sit in this order — copy from `organization.controller.ts`:

```ts
@ApiTags('Organizations')
@Controller('organizations')
@UseGuards(JwtAuthGuard)
export class OrganizationController {
  constructor(private readonly organizationService: OrganizationService) {}
}
```

Per-route decorators stack in this order: HTTP verb → RBAC → guard → OpenAPI → handler.

```ts
@Post()
@RequirePermissions(['ORGANIZATION_CREATION'], 'ORGANIZATION_ADMINISTRATION')
@UseGuards(PermissionsGuard)
@ApiOperation({ summary: 'Create organization', description: 'Create a new organization for an account.' })
async createOrganization(
  @Req() req: AuthenticatedRequest,
  @Body() dto: CreateOrganizationDto
): Promise<FetchOrganizationResponseDto> {
  return this.organizationService.createOrganization(req.user.id, dto)
}
```

Routes that don't need a specific permission but still need module access use `@RequirePermissions([], '<MODULE_NAME>')`. Public routes are not guarded (omit `@UseGuards(JwtAuthGuard)` at the class
level only if **all** routes are public; otherwise prefer keeping the class-level guard and exposing public endpoints via a different controller).

## DTOs (anchor)

**Requests use Zod** via `nestjs-zod`'s `createZodDto`. The Zod factory schema lives in `src/shared-validation/<domain>.ts` so the frontend can reuse it with i18n messages.

```ts
// src/modules/organizations/dto/requests/create-organization.dto.ts
import { createZodDto } from 'nestjs-zod'
import { buildCreateOrganizationPayloadSchema } from '@shared-validation/organization'

export class CreateOrganizationDto extends createZodDto(buildCreateOrganizationPayloadSchema()) {}
```

```ts
// src/shared-validation/organization.ts
export const buildCreateOrganizationPayloadSchema = (messages: CreateOrganizationPayloadMessages = {}) =>
  z
    .object({
      name: z
        .string()
        .min(1, { message: messages.nameRequired ?? 'Name is required' })
        .max(100),
      type: z.enum(ORGANIZATION_TYPE_VALUES),
      accountId: z.string().min(1)
    })
    .strict()
```

**Responses use class-validator + `@ApiProperty`** so Swagger emits accurate OpenAPI types. The class implements the canonical TS type from `@shared-types/index`.

```ts
// src/modules/organizations/dto/responses/fetch_organization.response.dto.ts
import { ApiProperty } from '@nestjs/swagger'
import type { Organization } from '@shared-types/index'

export class FetchOrganizationResponseDto implements Organization {
  @ApiProperty({ description: 'Organization unique identifier', example: '...' })
  id: string

  @ApiProperty({ description: 'Organization name', example: 'Acme Corporation' })
  name: string
}
```

## Services (anchor)

Inject `PrismaService` + `Logger` + any cross-module services via the constructor. Throw HTTP exceptions (`NotFoundException`, `ForbiddenException`, …) — they are caught by the global filter and
turned into proper responses.

```ts
@Injectable()
export class OrganizationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: Logger,
    private readonly accountAccessService: AccountAccessService
  ) {}

  async fetchOrganization(userId: string, id: string): Promise<FetchOrganizationResponseDto> {
    this.logger.debug(`Getting organization ${id}`, 'fetchOrganization')
    const organization = await this.prisma.organization.findUnique({
      where: { id },
      include: { accountsLinked: { select: { accountId: true } } }
    })
    if (!organization) throw new NotFoundException('Organization not found')
    return organization
  }
}
```

**Soft delete is opt-in.** The blueprint's core models (Organization, Account, Entity) do **not** carry `deletedAt`. Add it only when the domain needs it; otherwise hard-delete via
`prisma.<model>.delete()`. **Do not** invent a `deletedAt` filter in queries unless the schema actually has the column.

## RBAC (anchor)

Permissions are **runtime strings** stored in the database (the `module_permissions` table). There is **no TypeScript enum** for them — controllers reference string literals. The decorator signature
lives in `src/common/decorators/require-permissions.decorator.ts`:

```ts
RequirePermissions(permissions: string[], module: string, options?: { requireAll?: boolean })
```

To add a new permission key:

1. Add an `INSERT` to `prisma/sql/datasets/default_user_modules_roles.sql` under the relevant `INSERT INTO public.modules` block, e.g.:

   ```sql
   INSERT INTO public.module_permissions (module_id, name, description, updated_at)
   VALUES
     ((SELECT id FROM public.modules WHERE name = 'INVOICE_ADMINISTRATION'), 'INVOICE_CREATION', 'Create an invoice', NOW());
   ```

2. If the module itself is new, also `INSERT INTO public.modules` with the matching `module_types` FK.
3. Re-run `npm run db:setup:dev` so the seed re-applies (migration-free: db push --force-reset + re-seed).
4. Reference the new key from the controller: `@RequirePermissions(['INVOICE_CREATION'], 'INVOICE_ADMINISTRATION')`.

**`PermissionsGuard` is wired per-route** (via `@UseGuards(PermissionsGuard)`), not globally. Route-level opt-in keeps purely-authenticated endpoints (e.g. `/me`) cheap. There is no
`@SkipPermissions()` decorator in the blueprint — endpoints that don't need RBAC simply omit the guard.

## Validation (anchor)

- Schemas live in `src/shared-validation/<domain>.ts`.
- Each schema is a **factory function** named `buildXxxSchema(messages?)` so the frontend can override the error strings with i18n while the API uses the defaults — see `src/shared-validation/auth.ts`
  for the canonical reference.
- `createZodDto(buildXxxSchema())` produces the NestJS DTO consumed by `@Body()` / `@Query()`.
- Use `.strict()` on object schemas — unknown keys are rejected with a 400 instead of silently dropped.

On monorepo, `src/shared-validation/` is a **vendored mirror** of `packages/shared-validation/src/`. **Edit both copies (and the canonical workspace) in lockstep** — see `topology.md`.

## Prisma (anchor)

Multi-file schemas live under `prisma/schema/`:

```
prisma/schema/
├── schema.prisma          # root include file (datasource, generator)
├── accounts.prisma
├── invitations.prisma
├── modules.prisma         # RBAC tables (modules, module_permissions, ...)
├── organizations.prisma
└── users.prisma
```

Every model carries `createdAt` (`@default(now())`) and `updatedAt` (`@updatedAt`) — both `@map("…")` to snake_case columns:

```prisma
model Organization {
  id        String   @id @default(cuid())
  name      String   @db.VarChar(100)
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt      @map("updated_at")
  @@map("organizations")
}
```

After editing the schema or adding a new model:

```bash
npx prisma db push             # sync the schema into the dev DB (migration-free) + regenerate the client
```

If the model needs default rows, extend `prisma/sql/datasets/default_user_modules_roles.sql` (or add a new dataset file under `prisma/sql/datasets/` and reference it from the seed runner).

## Tests (anchor)

Each module ships **unit + e2e** tests. The unit suite mocks Prisma; the e2e suite hits a tmpfs PostgreSQL.

**Unit** (`tests/unit/<name>.service.spec.ts`) — extend `ServiceTestBase`, declare provider mocks, and per-method `prismaServiceAny.<model> = { create: jest.fn(), … }` in `customSetup()`:

```ts
class OrganizationServiceTest extends ServiceTestBase<OrganizationService> {
  protected getServiceClass() {
    return OrganizationService
  }
  protected getProviders(): Provider[] {
    return [
      { provide: PrismaService, useValue: mockPrismaService },
      { provide: Logger, useValue: mockLogger }
    ]
  }
  protected async customSetup(): Promise<void> {
    const p = mockPrismaService as any
    p.organization = { create: jest.fn(), findUnique: jest.fn(), update: jest.fn() }
  }
}
```

**E2E** (`tests/e2e/<name>.e2e-spec.ts`) — `Test.createTestingModule()` + `supertest`:

```ts
const moduleRef = await Test.createTestingModule({
  imports: [OrganizationsModule, AuthModule, LoggerModule, EnvModule, PrismaModule, AccountAccessModule]
}).compile()
app = moduleRef.createNestApplication()
app.setGlobalPrefix(process.env.API_PREFIX ?? '/api')
app.use(cookieParser())
const agent = request.agent(app.getHttpServer())
await loginTestUser(agent, testUser.email, 'TestPassword123')
```

The test database is set up by `src/configs/test/e2e-environment.ts` (Jest `globalSetup`) which spins up `docker-compose.db-test.yml` (tmpfs-backed PostgreSQL) and runs the migrations + the seed
loader. Cleanup is done by `e2e-teardown.ts`.

Run tests:

```bash
npm run test:unit               # Jest, mocks only
npm run test:e2e                # Jest + supertest + tmpfs DB
npm run test:full               # format + lint + type-check + unit + e2e
```

## Path aliases (anchor)

Confirmed in `tsconfig.json`:

| Alias                  | Resolves to                |
| ---------------------- | -------------------------- |
| `@modules/*`           | `src/modules/*`            |
| `@common/*`            | `src/common/*`             |
| `@configs/*`           | `src/configs/*`            |
| `@shared-types/*`      | `src/shared-types/*`       |
| `@shared-validation/*` | `src/shared-validation/* ` |
| `@/*`                  | `src/*`                    |

Always import with the most specific alias. Avoid relative paths that cross `src/modules/<a>/` → `src/modules/<b>/`; route through the alias.

## Worked example — add an `Invoice` module

Goal: introduce a new `Invoice` aggregate with `create` and `fetch` endpoints, RBAC-gated under a new `INVOICE_ADMINISTRATION` module key.

1. **Schema** — add `prisma/schema/invoices.prisma`:

   ```prisma
   model Invoice {
     id          String   @id @default(cuid())
     accountId   String   @map("account_id")
     amountCents Int      @map("amount_cents")
     status      String   @db.VarChar(20)
     createdAt   DateTime @default(now()) @map("created_at")
     updatedAt   DateTime @updatedAt      @map("updated_at")

     account Account @relation(fields: [accountId], references: [id])
     @@map("invoices")
   }
   ```

2. **Apply** — `npx prisma db push` syncs the schema and regenerates `@prisma/client`.

3. **Validation** — `src/shared-validation/invoice.ts` (factory schema). Mirror `organization.ts`:

   ```ts
   export const buildCreateInvoicePayloadSchema = (messages: CreateInvoicePayloadMessages = {}) =>
     z
       .object({
         accountId: z.string().min(1),
         amountCents: z.number().int().positive(),
         status: z.enum(INVOICE_STATUS_VALUES)
       })
       .strict()
   ```

   On **monorepo**, also mirror this file into `packages/shared-validation/src/invoice.ts` and re-export from `packages/shared-validation/src/index.ts` (see `topology.md`).

4. **Type** — `src/shared-types/invoice.ts`:

   ```ts
   export interface Invoice {
     id: string
     accountId: string
     amountCents: number
     status: InvoiceStatus
     createdAt: string
     updatedAt: string
   }
   ```

   Re-export from `src/shared-types/index.ts`. On monorepo, mirror to `packages/shared-types/src/invoice.ts` and update its `index.ts`.

5. **DTOs** — `src/modules/invoices/dto/`:

   ```ts
   // requests/create-invoice.dto.ts
   export class CreateInvoiceDto extends createZodDto(buildCreateInvoicePayloadSchema()) {}

   // responses/fetch_invoice.response.dto.ts
   export class FetchInvoiceResponseDto implements Invoice {
     /* @ApiProperty fields */
   }
   ```

6. **Service** — `src/modules/invoices/services/invoice.service.ts` (constructor injects `PrismaService` + `Logger`, throws `NotFoundException` on 404, returns DTOs).

7. **Controller** — `src/modules/invoices/controllers/invoice.controller.ts`:

   ```ts
   @ApiTags('Invoices')
   @Controller('invoices')
   @UseGuards(JwtAuthGuard)
   export class InvoiceController {
     @Post()
     @RequirePermissions(['INVOICE_CREATION'], 'INVOICE_ADMINISTRATION')
     @UseGuards(PermissionsGuard)
     async createInvoice(@Req() req: AuthenticatedRequest, @Body() dto: CreateInvoiceDto): Promise<FetchInvoiceResponseDto> {
       return this.invoiceService.createInvoice(req.user.id, dto)
     }
   }
   ```

8. **Module** — `src/modules/invoices/invoices.module.ts` declares the controller + service. Register in `src/app.module.ts`.

9. **RBAC seed** — `prisma/sql/datasets/default_user_modules_roles.sql`: add an `INSERT` for the new module (`INVOICE_ADMINISTRATION`) and its permissions (`INVOICE_CREATION`, …). Re-run
   `npm run db:setup:dev`.

10. **Tests** — `tests/unit/invoice.service.spec.ts` (mocked Prisma) + `tests/e2e/invoice.e2e-spec.ts` (supertest, login a user with `INVOICE_CREATION` permission). Run `npm run test:full`.

11. **Monorepo only** — regenerate the typed API client so the web app picks up the new endpoint:

    ```bash
    npm run codegen
    ```

    The frontend will then import `useCreateInvoice` from `@<project>/api-client/generated/api/invoices/invoices`.

That's the full path — every step mirrors a real file in the canonical `organizations/` module. **Do not invent an alternative layout** — drift breaks tooling (codegen, drift-guards, OpenAPI tag
routing).
