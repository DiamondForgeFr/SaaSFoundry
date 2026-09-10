# Frontend integration grammar (apps/web)

How to extend the React frontend of a SaaSFoundryAI-generated project. **The canonical reference page is `apps/web/src/pages/private/account/`** — when in doubt, mirror its component layout, hooks,
and i18n usage. The signin form (`src/pages/public/auth/signin.tsx`) is the canonical reference for forms.

> Topology note. This guide describes patterns shared by monorepo and multirepo. Where API hooks come from (generated `@<project>/api-client` package vs hand-written `src/hooks/api/`) and where UI
> primitives live (workspace `@<project>/ui-primitives` vs vendored `src/components/ui/shadcn/`) is covered by `topology.md`. Always run `sf status --claude-friendly --no-network` to confirm topology
> before touching files.

## Pages & routing (anchor)

Pages live under one of two roots:

| Visibility           | Path                           | Guard                                                                    |
| -------------------- | ------------------------------ | ------------------------------------------------------------------------ |
| Private (auth-gated) | `src/pages/private/<feature>/` | `<PrivateOnlyRoute />` (+ optional `<ModuleAccessRoute module="..." />`) |
| Public (no auth)     | `src/pages/public/<feature>/`  | none                                                                     |

A private page directory mirrors the canonical `account/` reference:

```
src/pages/private/account/
├── account-management.tsx     # main page component
├── account-overview.tsx       # sub-tab component
├── account-entities.tsx
├── account-users.tsx
└── index.ts                   # barrel export
```

**Route registration is a 3-step dance** — never skip steps and never invent another file:

1. **Add a lazy import** in `src/router/lazy-pages.tsx`:

   ```ts
   export const Dashboard = lazy(() => import('@/pages/private/dashboard').then((m) => ({ default: m.Dashboard })))
   ```

2. **Register the route** in `src/router/private-routes.tsx` (or `public-routes.tsx`):

   ```tsx
   {
     path: '/',
     element: <PrivateOnlyRoute />,
     children: [
       {
         element: LazyRouteElement(LayoutLogged),
         children: [
           { path: 'dashboard', element: LazyRouteElement(Dashboard) },
           { path: 'account', element: <ModuleAccessRoute module="ACCOUNT_ADMINISTRATION" />, children: [...] }
         ]
       }
     ]
   }
   ```

3. **Add a nav entry** if the page should appear in the sidebar (`src/locales/<lang>/nav.yml` + the layout component that renders the menu).

Route protection lives in `src/router/routes-guard.tsx`:

```tsx
export const PrivateOnlyRoute = () => {
  const { isSessionActive } = useIsSessionActive()
  if (!isSessionActive) return <Navigate to="/signin" replace />
  return <Outlet />
}

export const ModuleAccessRoute = ({ module }: ModuleAccessRouteProps) => {
  const { hasModuleAccess } = useModuleAccess()
  if (!hasModuleAccess(module)) return <Navigate to="/signin" replace />
  return <Outlet />
}
```

`<PrivateOnlyRoute />` enforces authentication; `<ModuleAccessRoute module="..." />` adds the RBAC module check (the `module` prop maps 1:1 to backend module names — `ORGANIZATION_ADMINISTRATION`,
`ACCOUNT_ADMINISTRATION`, …).

A page component owns its breadcrumb and namespaces:

```tsx
export function AccountManagement() {
  const { t: tAccount } = useTranslation('account')
  const { setBreadcrumb } = useBreadcrumb()
  const [searchParams] = useSearchParams()
  const currentTab = searchParams.get('tab') || 'overview'

  useEffect(() => {
    setBreadcrumb([{ label: tAccount('tk_title_') }, { label: tAccount(`tabs.tk_${currentTab}_`), description: tAccount(`tabs.tk_${currentTab}-description_`) }])
  }, [currentTab, setBreadcrumb, tAccount])
  // ...
}
```

## API hooks (anchor)

Where hooks come from depends on topology — see `topology.md`. Both flavours expose **the same shape** so page code stays identical.

**Hand-written hooks live under `src/hooks/api/<feature>/{queries,mutations}/use<Verb><Noun>.ts`.** Mutations always return `{ ...mutation, isLoading, submit, submitAsync }`:

```ts
export const useSignIn = () => {
  const me = useMe()
  const schemas = useSignInSchema()

  const mutation = useMutation({
    mutationFn: async (data: SignInPayloadDto) => {
      const response = await apiClient.post<SignInResponseDto>('/auth/signin', data)
      return schemas.response.parse(response)
    },
    onSuccess: async () => {
      localStorage.removeItem('guestAccess')
      await me.refetch()
    }
  })

  return {
    ...mutation,
    isLoading: mutation.isPending,
    submit: mutation.mutate,
    submitAsync: mutation.mutateAsync
  }
}
```

Queries declare a stable `queryKey` and parse the response with Zod:

```ts
export const useMe = () => {
  const schemas = useMeSchema()
  return useQuery({
    queryKey: ['authMe'],
    queryFn: async () => {
      const response = await apiClient.get<MeResponseDto>('/auth/me')
      return schemas.response.parse(response)
    },
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: false,
    enabled: false
  })
}
```

**Query keys** are centralised in `src/hooks/api/queryKeys.ts` so invalidations stay coherent:

```ts
export const queryKeys = {
  auth: { me: ['authMe'] as const, guest: ['guestAccess'] as const },
  account: (accountId: string) => ['account', accountId] as const,
  entities: (accountId: string, params?: Record<string, unknown>) => ['account', accountId, 'entities', ...(params ? [params] : [])] as const
}
```

On **monorepo**, the body of the mutation calls a generated function from `@<project>/api-client/generated/api/<tag>/<tag>` instead of `apiClient.post(...)` — the wrapper and the return shape are
identical:

```ts
import { authControllerSignIn } from '@<project>/api-client/generated/api/authentication/authentication'
// ...
mutationFn: async (data) => schemas.response.parse(await authControllerSignIn(data))
```

`topology.md` covers when to call the generated function directly vs wrapping it.

## Forms (anchor)

Forms use **React Hook Form + `zodResolver` + a factory schema from `@shared-validation/<domain>`**. The factory accepts `messages` so the frontend can pass i18n strings while the API uses defaults:

```tsx
import { zodResolver } from '@hookform/resolvers/zod'
import { useForm } from 'react-hook-form'

export function SignIn() {
  const { t: tAuth } = useTranslation('auth')
  const signInMutation = useSignIn()
  const schemas = useSignInSchema()

  const form = useForm<SignInPayloadDto>({
    resolver: zodResolver(schemas.payload),
    defaultValues: { email: '', password: '' }
  })

  const onSubmit = (values: SignInPayloadDto) => {
    signInMutation.submit(values, { onError: () => setAuthError(...) })
  }
  // ...
}
```

The `useSignInSchema()` hook is co-located with the API hook — it reads i18n keys, calls `buildSigninPayloadSchema({ emailRequired: tCommon('user.tk_email-required_'), … })`, and returns
`{ payload, response }`.

**Field rendering uses the ShadCN `Form` primitives** — `FormField` plumbs RHF into `FormControl` / `FormMessage` so validation errors appear automatically:

```tsx
<FormField
  control={form.control}
  name="email"
  render={({ field }) => (
    <FormItem>
      <FormLabel htmlFor="email">{tAuth('signin.tk_email-label_')}</FormLabel>
      <FormControl>
        <Input id="email" type="email" {...field} />
      </FormControl>
      <FormMessage />
    </FormItem>
  )}
/>
```

Schema factories live in `src/shared-validation/<domain>.ts`:

```ts
export const buildSigninPayloadSchema = (messages: SigninPayloadMessages = {}) =>
  z
    .object({
      email: z
        .string()
        .min(1, { message: messages.emailRequired ?? 'Email is required' })
        .email({ message: messages.emailInvalid ?? 'Invalid email format' }),
      password: z.string().min(6, { message: messages.passwordMinLength ?? 'Password must be at least 6 characters long' })
    })
    .strict()
```

On monorepo, this file is a vendored mirror of `packages/shared-validation/src/<domain>.ts` — see `topology.md`.

## i18n (anchor)

Translations are YAML files under `src/locales/<lang>/<namespace>.yml`. Existing namespaces:

```
src/locales/en/
├── auth.yml
├── account.yml
├── dashboard.yml
├── common.yml
├── nav.yml
└── page-errors.yml
```

`fr/` mirrors the same file set. **Keys use the `tk_<slug>_` convention** so missing translations fail loudly in the UI (the leading/trailing underscores make raw keys obvious if i18n is
misconfigured).

A page consumes translations via `useTranslation('<namespace>')`:

```ts
const { t: tAuth } = useTranslation('auth')
const { t: tCommon } = useTranslation('common')
// tAuth('signin.tk_title_') / tCommon('user.tk_email_')
```

**Adding a new namespace is normally a 2-step change** — namespaces are **lazy-loaded by default** via `i18next-resources-to-backend`:

1. Create `src/locales/en/<namespace>.yml` and `src/locales/fr/<namespace>.yml` with the same key tree.
2. Use it in components: `useTranslation('<namespace>')`. The first call triggers the fetch of the YAML file; subsequent renders are cached.

**Do not add the namespace to the `ns` array in `src/i18n.ts` by default.** That array is reserved for **universal namespaces** — those rendered on the layout shell or by the global error boundary on
every route:

```ts
// src/i18n.ts (current canonical set)
ns: ['common', 'nav', 'page-errors']
```

Promote a feature namespace into `ns` **only** when it satisfies one of these criteria:

- It is referenced by a layout component that renders on every authenticated/public route (e.g. sidebar, topbar, footer).
- It is needed by the route guard or the global error boundary itself (otherwise the user sees a flash of `tk_<slug>_` keys before the lazy fetch resolves).
- Profiling shows the lazy fetch causes a visible flicker on the golden path.

Adding to `ns` costs initial bundle size and request waterfall — keep it minimal.

If a key is missing in `fr/`, the fallback is `en` (`fallbackLng: 'en'`).

## UI components (anchor)

Three layers — never mix them:

| Layer                               | Multirepo path                    | Monorepo path                                         |
| ----------------------------------- | --------------------------------- | ----------------------------------------------------- |
| Primitives (Button, Input, Form, …) | `src/components/ui/shadcn/<name>` | `@<project>/ui-primitives/<name>` (workspace package) |
| App-specific compositions           | `src/components/ui/custom/<name>` | `src/components/ui/custom/<name>` (same)              |
| Layouts (sidebar, topbar, wrappers) | `src/components/layout/<name>`    | `src/components/layout/<name>` (same)                 |

**Primitives are owned by the design system, not the page.** Don't fork a primitive into `src/components/ui/custom/` to tweak it — extend it via composition or props. The drift-guard CLI checks
vendored primitives stay byte-identical with the canonical source.

App-specific compositions (logos, page loaders, password fields, auth cards) belong in `src/components/ui/custom/`:

```tsx
// src/components/ui/custom/logo.tsx
export const Logo = ({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) => <img src={LOGO_URL} alt="Logo" className={cn('object-contain', LOGO_SIZE[size])} />
```

Theme tokens live in `src/index.css`. **Multirepo** declares them inline:

```css
@import 'tailwindcss';
@import 'tw-animate-css';
@theme {
  --color-background: hsl(var(--background));
  /* … */
}
```

**Monorepo** imports them from the workspace package:

```css
@import '@<project>/ui-primitives/theme.css';
@source '../../../node_modules/@<project>/ui-primitives/src';
```

`topology.md` covers the package wiring.

## Path aliases (anchor)

Confirmed in `apps/web/tsconfig.json`:

| Alias                  | Resolves to                 |
| ---------------------- | --------------------------- |
| `@/*`                  | `./src/*`                   |
| `@shared-types/*`      | `./src/shared-types/*`      |
| `@shared-validation/*` | `./src/shared-validation/*` |

On monorepo, `@<project>/shared-types`, `@<project>/shared-validation`, `@<project>/api-client`, and `@<project>/ui-primitives` are added as workspace packages — see `topology.md` for the
canonical-vs-mirror rule.

## Tests (anchor)

E2E tests use Playwright under `tests/e2e/`:

```
tests/e2e/
├── specs/
│   ├── auth.spec.ts
│   └── account.spec.ts
├── selectors/
│   ├── auth.se.ts        # page selectors + test fixtures
│   └── account.se.ts
└── utils/
    └── api-interceptor.ts
```

API calls are intercepted by the `setupApiInterceptor` helper so tests don't hit a real backend:

```ts
test.beforeEach(async ({ page }) => {
  await setupApiInterceptor(page, testApi.interceptorURL)
  await page.mockRoute(testApi.guest.URL, async (route) => {
    await route.fulfill({
      status: testApi.guest.success.status,
      contentType: 'application/json',
      body: JSON.stringify(testApi.guest.success.body)
    })
  })
  await page.goto('/')
})
```

Run tests:

```bash
npm run test:e2e         # Playwright e2e
npm run test:full        # format + lint + type-check + e2e
```

## Worked example — add an `Invoices` list page

Goal: introduce a new private page at `/invoices` that lists the current account's invoices, gated by the `INVOICE_ADMINISTRATION` module. Backend already exposes `GET /invoices` (see the worked
example in `backend.md`).

1. **i18n** — create `src/locales/en/invoices.yml` + `src/locales/fr/invoices.yml`:

   ```yaml
   tk_title_: Invoices
   tk_subtitle_: Manage invoices for your account
   table:
     tk_amount_: Amount
     tk_status_: Status
     tk_created-at_: Created at
   empty:
     tk_message_: No invoices yet
   ```

   The namespace is picked up automatically the first time `useTranslation('invoices')` runs — **do not add it to the `ns` array in `src/i18n.ts`** unless the page sits on the layout shell or causes a
   visible flicker on the golden path (see the i18n section above for the promotion criteria).

2. **Hook** — `src/hooks/api/invoices/queries/useFetchInvoices.ts`:

   ```ts
   export const useFetchInvoices = (accountId: string) => {
     const schemas = useFetchInvoicesSchema()
     return useQuery({
       queryKey: queryKeys.invoices(accountId),
       queryFn: async () => schemas.response.parse(await apiClient.get<FetchInvoicesResponseDto>(`/invoices?accountId=${accountId}`))
     })
   }
   ```

   Add `invoices: (accountId: string) => ['invoices', accountId] as const` to `src/hooks/api/queryKeys.ts`. On **monorepo**, the `queryFn` calls `invoicesControllerListInvoices` from
   `@<project>/api-client/generated/api/invoices/invoices` instead.

3. **Page component** — `src/pages/private/invoices/invoices-list.tsx`:

   ```tsx
   export function InvoicesList() {
     const { t: tInvoices } = useTranslation('invoices')
     const { setBreadcrumb } = useBreadcrumb()
     const { accountId } = useCurrentAccount()
     const { data: invoices, isLoading } = useFetchInvoices(accountId)

     useEffect(() => {
       setBreadcrumb([{ label: tInvoices('tk_title_'), description: tInvoices('tk_subtitle_') }])
     }, [setBreadcrumb, tInvoices])

     if (isLoading) return <PageLoader />
     return (
       <Table>
         <TableHeader>
           <TableRow>
             <TableHead>{tInvoices('table.tk_amount_')}</TableHead>
             <TableHead>{tInvoices('table.tk_status_')}</TableHead>
             <TableHead>{tInvoices('table.tk_created-at_')}</TableHead>
           </TableRow>
         </TableHeader>
         <TableBody>
           {invoices?.length ? (
             invoices.map((i) => (
               <TableRow key={i.id}>
                 <TableCell>{i.amountCents / 100}</TableCell>
                 <TableCell>{i.status}</TableCell>
                 <TableCell>{i.createdAt}</TableCell>
               </TableRow>
             ))
           ) : (
             <TableRow>
               <TableCell colSpan={3}>{tInvoices('empty.tk_message_')}</TableCell>
             </TableRow>
           )}
         </TableBody>
       </Table>
     )
   }
   ```

   Add `src/pages/private/invoices/index.ts` re-exporting `InvoicesList`.

4. **Lazy import** — append to `src/router/lazy-pages.tsx`:

   ```ts
   export const InvoicesList = lazy(() => import('@/pages/private/invoices').then((m) => ({ default: m.InvoicesList })))
   ```

5. **Route** — add to `src/router/private-routes.tsx` under the `LayoutLogged` children:

   ```tsx
   { path: 'invoices', element: <ModuleAccessRoute module="INVOICE_ADMINISTRATION" />, children: [
     { index: true, element: LazyRouteElement(InvoicesList) }
   ]}
   ```

6. **Nav entry** — add a key to `src/locales/<lang>/nav.yml` (`tk_invoices_: Invoices`) and an item in the sidebar component that renders the menu (typically `src/components/layout/sidebar/...`). Gate
   the entry with `useModuleAccess().hasModuleAccess('INVOICE_ADMINISTRATION')` so it disappears for users without the permission.

7. **E2E test** — `tests/e2e/specs/invoices.spec.ts` mirroring `auth.spec.ts`: mock `GET /invoices` via `page.mockRoute`, navigate to `/invoices`, assert the table renders the mocked rows. Add
   selectors in `tests/e2e/selectors/invoices.se.ts`.

8. **Run** — `npm run test:full` to format + lint + type-check + run Playwright.

Every step mirrors a real file in the canonical `account/` page or `signin.tsx` form. **Do not invent an alternative layout** — drift breaks tooling (codegen on monorepo, drift-guards on primitives,
i18n loaders).
