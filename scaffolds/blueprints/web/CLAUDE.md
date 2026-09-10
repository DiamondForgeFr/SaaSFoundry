# {{PROJECT_NAME}} Web

Production-ready React application generated with **SaaSFoundryAI** - An AI-First development platform.

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

- **Frontend**: React 19, React Router v7, Vite 7
- **Styling**: TailwindCSS 4, Radix UI, ShadCN UI
- **State**: React Query (data fetching), React Hook Form (forms)
- **Validation**: Zod 4
- **i18n**: i18next (French + English)
- **Testing**: Playwright (E2E)

## 🎯 Skills Priority

**IMPORTANT**: This project uses SaaSFoundryAI skills (prefix `sf-*`). When multiple skills with similar functionality exist, **always prefer SaaSFoundryAI skills** over global or other skills:

- ✅ Use `sf-git-commit` instead of `git-commit`
- ✅ Use `sf-utils-fix-errors` instead of `utils-fix-errors`
- ✅ Use `sf-utils-oneshot` instead of `utils-oneshot`
- ✅ Use `sf-tool-figma` instead of `tool-figma`

SaaSFoundryAI skills are specifically optimized for this project's structure, conventions, and workflows.

## Project Structure

```
src/
├── components/
│   ├── dialogs/      # App-level dialog/modal compositions
│   ├── layout/       # App layout components (sidebar, topbar, wrappers)
│   ├── nav/          # Navigation components
│   ├── theme/        # Theme provider + dark/light toggle
│   └── ui/           # ShadCN UI compositions (custom/) — primitives live in @<project>/ui-primitives on monorepo
├── pages/
│   ├── private/      # Protected pages (require auth)
│   └── public/       # Public pages (login, register)
├── hooks/
│   ├── api/          # React Query hooks for API calls
│   └── ui/           # UI-related hooks
├── router/
│   ├── routes.tsx    # Route definitions
│   ├── lazy-pages.tsx  # Lazy-loaded page components
│   └── guard.tsx     # Route protection (auth)
├── locales/          # i18next translations (YAML)
│   ├── en/
│   └── fr/
└── utils/            # Utility functions
```

## Code Conventions

### Component Pattern

```tsx
// PascalCase for components
export function UserProfile() {
  // React Query for data fetching
  const { data: user } = useGetUser()

  // React Hook Form for forms
  const form = useForm<UserFormData>({
    resolver: zodResolver(userSchema)
  })

  return <div>...</div>
}
```

### Path Aliases

- `@/*` → `./src/*`
- `@shared-types/*` → `./src/shared-types/*` (cross-wire TypeScript types)
- `@shared-validation/*` → `./src/shared-validation/*` (Zod schemas reused on the API side)

### Styling

- **TailwindCSS 4** for utility classes
- **ShadCN** primitives for the design system (`Button`, `Dialog`, `Form`, …)
- **Radix UI** for accessible primitives (consumed through ShadCN)
- Mobile-first responsive design
- Theme tokens (colors, radii, animations, dark mode) live in a `theme.css` imported once in `src/index.css`

### API Integration

- **Monorepo**: typed React Query hooks come from `@<root-package-name>/api-client/generated/api/<tag>/<tag>` (auto-emitted by orval from the API's OpenAPI snapshot). Hand-written hooks under
  `src/hooks/api/` are thin wrappers when extra logic is needed.
- **Multirepo**: hand-written React Query hooks under `src/hooks/api/` consume a typed fetch wrapper directly.
- Cookie-based auth with automatic refresh
- Type-safe end-to-end via shared types + auto-generated client (mono) or shared types alone (multi)

### 📦 Shared layers (mono vs multi)

This blueprint always carries vendored copies of `src/shared-types/` and `src/shared-validation/` — that's the working source the web bundle compiles against. The full shared landscape diverges by
topology:

- **In a monorepo** (root has `packages/`):
  - `src/shared-types/` and `src/shared-validation/` are mirrored from `<root>/packages/shared-{types,validation}/src/` — **edit hand-written files in all three places** (canonical + both apps'
    mirrors). The SaaSFoundryAI CLI's drift-guard tests block divergence.
  - **ShadCN primitives** are not in `src/components/ui/shadcn/` — they live in the workspace package and are imported as `@<root-package-name>/ui-primitives/<name>` (see `package.json`). The Tailwind
    theme is pulled in via `@import "@<root-package-name>/ui-primitives/theme.css"` in `src/index.css`. App-specific compositions (logos, page-loaders, business widgets) stay under `src/components/`.
  - **Typed API client**: `@<root-package-name>/api-client/generated/api/<tag>/<tag>` exposes `useXxx` React Query hooks generated from the API's OpenAPI snapshot.
  - **Module-deposited shared constants** (e.g. `STORAGE_LOGO_MAX_BYTES` in `shared-config`) — consume them via the workspace import; don't re-declare locally.
- **In multirepo** (this app stands alone):
  - Vendored `src/shared-{types,validation}/` are the only copies.
  - **ShadCN primitives** live in `src/components/ui/shadcn/` (vendored from the same canonical source as the mono `ui-primitives` package — drift-guarded by the CLI).
  - No generated API client — hand-write React Query hooks under `src/hooks/api/`.
  - Module-shared values (storage MIME list, email envelope, …) are inlined per side; keep them stable — the SaaSFoundryAI CLI's docker assertions enforce the inlined shape.

Run `sf status --claude-friendly --no-network` to confirm topology before changing shared shapes.

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
feat(#42): add user profile page
fix(#43): resolve form validation issue
style(#44): improve mobile responsiveness
```

## Development Commands

```bash
# Development
npm run dev                 # Start Vite dev server (port 5173)

# Testing
npm run test:e2e            # Run Playwright E2E tests
npm run test:full           # Format + Lint + Type-check + E2E

# Code Quality
npm run format              # Prettier
npm run lint                # ESLint
npm run type-check          # TypeScript

# Build
npm run build               # Production build
npm run preview             # Preview production build
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

- **`/sf-integration-rules`** - Integration grammar router. Triggers when adding a page, an API hook, a form, a ShadCN composition, RBAC wiring, or i18n keys. Routes to `backend.md` / `frontend.md` /
  `topology.md` sub-guides — read first before scaffolding.

#### Code Quality

- **`/sf-utils-fix-errors`** - Fix ESLint and TypeScript errors
  - Parallel processing for fast fixes
  - Respects project conventions
  - Safe refactoring

- **`/sf-utils-fix-grammar`** - Fix grammar and spelling
  - Preserves code formatting
  - Works on markdown, comments, docs

### 🎯 Common AI Workflows

#### Implement a new page

```
User: "Add a user settings page with form validation"
Claude:
1. Creates page component in src/pages/private/
2. Adds route in router/routes.tsx
3. Creates form with React Hook Form + Zod
4. Adds i18n translations
5. Implements API hook for saving settings
```

#### Fix styling issues

```
User: "Make this page responsive for mobile"
Claude:
- Analyzes current layout
- Adds Tailwind responsive classes (sm:, md:, lg:)
- Tests on different breakpoints
```

#### Add translations

```
User: "Add French translation for the login page"
Claude:
- Updates src/locales/fr/auth.yml
- Ensures translation keys match English version
- Uses i18next best practices
```

### ✅ Best Practices

**DO**:

- Trust the skills - they respect project conventions
- Let AI handle repetitive tasks (commits, error fixes, translations)
- Use ShadCN components for consistency
- Review UI/UX choices manually

**DON'T**:

- Skip tests - E2E tests validate user flows
- Bypass git hooks (`--no-verify`)
- Ignore TypeScript errors
- Hard-code strings (use i18next)

### 🔒 Quality Gates

All AI-generated code passes through:

- **ESLint** - Code quality standards (React hooks rules)
- **TypeScript** - Compile-time type safety
- **Prettier** - Consistent code formatting
- **Playwright** - E2E user flow validation
- **Git hooks** - Pre-commit checks
- **CI/CD** - Automated deployment validation

## Routing

### Protected Routes

```tsx
// Requires authentication
<Route element={<ProtectedLayout />}>
  <Route path="/dashboard" element={<Dashboard />} />
  <Route path="/profile" element={<UserProfile />} />
</Route>
```

### Public Routes

```tsx
// No authentication required
<Route path="/login" element={<Login />} />
<Route path="/register" element={<Register />} />
```

### Lazy Loading

```tsx
// Automatic code splitting
const Dashboard = lazy(() => import('./pages/private/Dashboard'))
```

## Internationalization (i18n)

### Using Translations

```tsx
import { useTranslation } from 'react-i18next'

function LoginPage() {
  const { t } = useTranslation('auth')

  return <h1>{t('login.title')}</h1>
}
```

### Translation Files

```yaml
# src/locales/en/auth.yml
login:
  title: 'Sign In'
  email: 'Email Address'
  password: 'Password'
```

## Environment Variables

See `.env.example` for required variables:

```bash
# API Configuration
VITE_API_URL="http://localhost:3000/api"

# Optional: Analytics
VITE_ANALYTICS_URL="..."
VITE_ANALYTICS_WEBSITE_ID="..."

# Optional: Storage
VITE_STORAGE_ENABLED="true"
```

## Testing

### E2E Tests (Playwright)

```bash
npm run test:e2e
# Tests full user flows in real browser
# Located in: tests/e2e/*.spec.ts
```

### Writing Tests

```typescript
test('user can login', async ({ page }) => {
  await page.goto('/login')
  await page.fill('[name="email"]', 'user@example.com')
  await page.fill('[name="password"]', 'password')
  await page.click('button[type="submit"]')
  await expect(page).toHaveURL('/dashboard')
})
```

## Important Notes

- This is a **generated project** from SaaSFoundryAI v1.0.0-beta
- Check `.saasfoundry.json` for installed modules and configuration
- Update this CLAUDE.md as your project evolves
- Add new components to ShadCN collection as needed

---

**Need help?** Check the [SaaSFoundryAI documentation](https://github.com/DiamondForgeFr/SaasFoundryAI) or use Claude Code skills for assistance.
