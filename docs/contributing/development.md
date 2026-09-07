# Development

How to contribute to the SaaSFoundryAI CLI itself — set up the repo locally, run the test matrix, and stay in line with the conventions Husky enforces on every commit.

If you only want to use the CLI on a generated project, the page you want is [Quick start](/getting-started/quick-start). This page is for people changing the **scaffold engine** (the templates,
installers, and migrations that generate user projects).

## Prerequisites

- **Node.js ≥ 22.13** — the version pinned in `.nvmrc` and enforced in `package.json` via `engines` and `devEngines.runtime` (build fails on lower versions). `nvm use` reads the file directly.
- **npm ≥ 10** — also enforced via `devEngines.packageManager`.
- **Docker + docker-compose** — required for the database in dev (`docker-compose.db.yml`) and for the Docker-based E2E test matrix in `tests/docker/`.
- **Docker network** — create the shared external network once: `docker network create saasfoundry-network`. Without it, `docker compose up` fails on the API service in any generated project.
- **GitHub CLI (`gh`)** — needed to drive the workflow CLI (`workflow-cli.sh`) and `github-projects-cli.sh`. Auth once with `gh auth login`.

## Repository layout

The high-level shape is documented in [`CLAUDE.md`](https://github.com/DiamondForgeFr/SaasFoundryAI/blob/develop/CLAUDE.md) — the same file Claude Code reads at session start. Key directories:

| Path                          | Purpose                                                                                                    |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `src/commands/`               | CLI entry points wired to Commander (`new.ts`, `update.ts`, `workflow.ts`, `srs.ts`, `status.ts`, …)       |
| `src/builders/`               | Scaffold builders — `monorepo.builder.ts`, `multirepo.builder.ts`, `db.builder.ts`, etc.                   |
| `src/installers/`             | Reusable module installers (email, storage, analytics, srs)                                                |
| `src/migrations/`             | Manifest + module migration registries — see [Migration framework](#migration-framework-non-negotiable)    |
| `scaffolds/blueprints/`       | Base project templates (`api/`, `web/`, `db/`, `s3/`)                                                      |
| `scaffolds/overlays/`         | Topology overrides (`monorepo/`, `multirepo/`) and module overlays (`modules/email/`, `modules/storage/`)  |
| `scaffolds/skills-templates/` | Skill templates that ship into generated projects (sf-srs, sf-workflow, sf-integration-rules, …)           |
| `tests/docker/`               | Real-build E2E matrix — generates a project, runs `npm install`, `tsc`, `nest build`, `vite build`         |
| `.claude/skills/`             | Local copies of the same skills the scaffolds ship — drift-guarded against `scaffolds/skills-templates/`   |
| `.claude/docs/`               | Reference docs the agent reads during dev (architecture-modules, architecture-skills, migration-framework) |

For deeper guidance on how to add or modify a module or skill, read the architecture docs the agent uses:

- `.claude/docs/architecture-modules.md` — how modules compose (blueprint markers + overlay files + installer)
- `.claude/docs/architecture-skills.md` — skill template shape and the drift-guard contract
- `.claude/docs/migration-framework.md` — every breaking manifest or module change must ship through this

## Local setup

```bash
# 1. Clone
git clone https://github.com/DiamondForgeFr/SaasFoundryAI.git
cd SaaSFoundryAI

# 2. Install
nvm use         # reads .nvmrc → Node 22.13+
npm install

# 3. Build (one-shot)
npm run build

# 4. Watch the CLI while you work
npm run dev
```

To run your local checkout against a real project:

```bash
npm link                       # publishes the in-repo `sf` binary on your PATH
cd /tmp
sf new --project-name local-test --structure monorepo
```

`npm unlink -g saasfoundryai-cli` reverts to whatever you had installed globally before.

## Build, test, format, lint

| Command                                                     | What it does                                                                                                                                                                   | When to run                                                                                                            |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `npm run build`                                             | `tsc` — emits `dist/`                                                                                                                                                          | Before publishing or running the CLI standalone                                                                        |
| `npm run dev`                                               | `tsc -w` — incremental compile while editing                                                                                                                                   | While developing                                                                                                       |
| `npm run format`                                            | Prettier on `**/*.{js,jsx,ts,tsx,json,css,md}` (respects `.prettierignore`)                                                                                                    | Before pushing — Husky's pre-commit will retry it                                                                      |
| `npm run lint`                                              | ESLint with the flat config in `eslint.config.mjs`                                                                                                                             | Before pushing                                                                                                         |
| `npm test`                                                  | Jest across all four projects (`unit`, `integration`, `e2e`, `smoke`)                                                                                                          | While iterating                                                                                                        |
| `npm run test:unit`                                         | Just the unit project (fastest)                                                                                                                                                | Quick local feedback                                                                                                   |
| `npm run test:integration`                                  | Just integration tests (filesystem builders, scaffolds, installers)                                                                                                            | When changing builders / installers                                                                                    |
| `npm run test:e2e`                                          | E2E tests (CLI command surface)                                                                                                                                                | When changing command wiring                                                                                           |
| `npm run test:pre-commit`                                   | `format` + `lint` + `build` + `test` — what Husky runs on every commit (~15s)                                                                                                  | Before pushing                                                                                                         |
| `npm run test:pre-push`                                     | Top 2 Docker scenarios (`monorepo-minimal` + `multirepo-minimal`, ~2–3 min)                                                                                                    | Explicitly during AI Testing before Human Testing; record the results                                                  |
| `npm run test:full`                                         | `test:pre-commit` + `test:pre-push` — full local validation                                                                                                                    | Before declaring something done                                                                                        |
| `npm run test:docker`                                       | All Docker scenarios (~70 min, see `--list`)                                                                                                                                   | When in doubt about a builder or installer change                                                                      |
| `npm run test:docker:list`                                  | Lists every scenario without running them                                                                                                                                      | To pick a specific one                                                                                                 |
| `npm run test:docker -- --scenario multirepo-boot-and-test` | The only scenario that **starts** the generated project: `sf new --start-services`, then `/api/health` and the web root must answer, then `npm audit` and the api's unit suite | After touching a builder, an installer or a pinned dependency — a build cannot see a module that throws on load (#594) |
| `npm run test:docker -- --count N`                          | Runs the top N priority scenarios                                                                                                                                              | Selective E2E coverage                                                                                                 |
| `npm run test:docker -- --scenario <name>`                  | Runs a single named scenario                                                                                                                                                   | Targeted reproduction                                                                                                  |

Pre-commit runs in ~15 seconds; if it stalls, prettier is reformatting a large file (most often a `.md` you just changed).

## Conventional commits + commitlint

Every commit message goes through `@commitlint/cli` with the rules in `commitlint.config.js`. The pattern is:

```
<type>(#<ticket>): <description>
```

- **`<type>`** — one of `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `chore`, `ci`, `build`, `revert`
- **`(#<ticket>)`** — required scope. Every change is tied to a GitHub issue (the workflow CLI enforces this end-to-end). Use the parent Sub or Story number.
- **Header length** — capped at 100 characters. Keep the description short; put detail in the body.

Examples:

```
feat(#317): SRS intent-detector calibration — dataset + tuning + failure-mode doc
fix(#292): apply prettier normalization on color rejection case
docs(#388): enforce migration framework on breaking changes (CLAUDE.md)
```

A `chore:` without a ticket is rejected. Use `chore(#000): ...` only for genuinely repository-wide housekeeping (CI tweaks, lock-file bumps) and document why in the body.

## Husky hooks

Husky installs three hooks under `.husky/`:

| Hook         | What it runs                                                         | How to bypass                                                    |
| ------------ | -------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `commit-msg` | `commitlint` — rejects commits that don't match the convention above | Don't. Fix the message.                                          |
| `pre-commit` | `npm run test:pre-commit` (format + lint + build + jest, ~15 s)      | `--no-verify` on `git commit`. Reserve for emergencies.          |
| `pre-push`   | RC version management and WIP checks; no automatic Docker run        | Keep enabled; run heavy validation explicitly during AI Testing. |

If pre-commit reformats files (prettier), the commit aborts so you can stage the formatted result. **Do not amend** — `git add` the formatted files and create a new commit. The same rule appears in
the workflow skill: pre-commit retries are the source of truth for "the commit didn't happen."

RC branches (`rc-*`) retain version management. Ordinary pushes do not repeat Docker builds. Run `npm run test:pre-push` during AI Testing before opening the Human Testing draft PR.

Draft PRs provide the diff and manual test plan without running test/build CI. After human approval, push the required non-regression tests and use `workflow-cli.sh ready-pr <ticket>` to start full
CI. Later ready-PR pushes rerun it; `draft-pr <ticket>` returns the PR to draft for further human testing and cancels obsolete CI.

## Migration framework — non-negotiable

The migration framework (Epic #310) only delivers value if **every** breaking change runs through it. Inline shims in `sf update`, ad-hoc type mutations, and "the user can fix their manifest manually"
shortcuts reintroduce exactly the cross-version drift the framework was built to prevent.

- **Manifest shape changes** — Any breaking change to `SaaSFoundryManifest` (renaming a field, removing one, restructuring a sub-block) MUST ship as a numbered migration in
  `src/migrations/manifest/NNN-<name>.ts`, registered in `src/migrations/manifest/index.ts`, with a JSON-schema delta in `schemas/saasfoundry-manifest.schema.json` and a golden fixture pair under
  `src/__tests__/unit/migrations/fixtures/NNN-<name>/`. Never mutate manifests inline in commands; never bump `manifestVersion` without registering a migration.
- **Module file-set changes** — Any breaking change to a module's installed file set (renaming a service file, splitting an installer's deposited files, requiring a new env var) MUST bump the
  installer's `currentVersion` in `<name>.installer.ts` AND ship a `ModuleMigration` on its `migrations` array. Use `writeMigratedFile` from `src/migrations/module/conflict.ts` so user-edited files
  fall back to a `.saasfoundry.new` sidecar.

Read [`.claude/docs/migration-framework.md`](https://github.com/DiamondForgeFr/SaasFoundryAI/blob/develop/.claude/docs/migration-framework.md) before editing `src/types.ts`,
`schemas/saasfoundry-manifest.schema.json`, any installer's deposited templates, or anything under `src/migrations/`. It covers the registry pattern, the file-naming convention, the conflict-aware
writer, and worked examples for both manifest renames and module file splits.

## Workflow — never bypass statuses

We dogfood our own ticketing flow. Every code change moves through:

```
Backlog → Ready → In progress → AI testing → Human testing → In review → Done
```

- Read `.claude/skills/sf-workflow/statuses/<N>-<name>.md` before any transition — the file lists the mandatory entry actions and exit conditions.
- Use the workflow CLI: `.claude/skills/sf-workflow/workflow-cli.sh update-status <ticket> <status> --reason "..."`. Don't drag cards in the GitHub Projects UI manually — the CLI runs the guards (PR
  existence, complexity label, parent-status mirror, …) the UI doesn't know about.
- Subtasks are real GitHub issues, not checkboxes. Create them via `.claude/skills/sf-tool-github-projects/github-projects-cli.sh create-subtask`.
- Bundled PRs (one PR closing several tightly-coupled subs) are explicitly supported via `nature:bundled-pr` — see `.claude/skills/sf-workflow/SKILL.md` "Nature axis".

Full guidance: [Workflow skill SKILL.md](https://github.com/DiamondForgeFr/SaasFoundryAI/blob/develop/.claude/skills/sf-workflow/SKILL.md).

## Adding a module or a skill

These flows are documented in dedicated reference docs because they have their own constraints (drift-guard for skills, blueprint markers + overlay files + installer for modules):

- **Adding a new module** — read [`.claude/docs/architecture-modules.md`](https://github.com/DiamondForgeFr/SaasFoundryAI/blob/develop/.claude/docs/architecture-modules.md). Cover the markers, the
  overlay layout, the installer's `currentVersion` + `migrations`, the manifest delta, and the Docker scenario you'll add to `tests/docker/`.
- **Adding or editing a skill** — read [`.claude/docs/architecture-skills.md`](https://github.com/DiamondForgeFr/SaasFoundryAI/blob/develop/.claude/docs/architecture-skills.md). Cover the
  `scaffolds/skills-templates/<name>/` source tree, the drift-guard test that pins it byte-equal to `.claude/skills/<name>/`, and the SKILL.md / scripts split.

## Releasing

Releases run from `master`. The flow is automated through RC branches:

1. From `develop`, branch `rc-X.Y.Z` (e.g. `rc-2.0.0`).
2. Merge into `master` once the RC is green. Husky's `tag-manager.sh` script handles versioning.
3. CI publishes `saasfoundryai-cli@X.Y.Z` to npm.
4. Tag both branches and update `CHANGELOG.md`.

For the v1.0 / v2.0 acceptance rubric, see [`.claude/docs/release-objectives.md`](https://github.com/DiamondForgeFr/SaasFoundryAI/blob/develop/.claude/docs/release-objectives.md).

## Reporting bugs and proposing features

- **Bug**: open an issue with the `bug` label and a minimal reproduction. The maintainer will triage to `complexity: bug` and route through the workflow.
- **Feature**: open an issue describing the user-visible outcome first, the implementation second. Big proposals usually become an Epic with child Stories.
- **Security**: do not file a public issue. Email the maintainer at the address in `package.json`.

## See also

- [`CLAUDE.md`](https://github.com/DiamondForgeFr/SaasFoundryAI/blob/develop/CLAUDE.md) — the agent's session prompt; mirrors most of this page in operational form
- [Workflow skill](/skills/core-skills) — full reference for the workflow CLI and status transitions
- [Module system](/guide/module-system) — user-facing view (what modules are and how to add them to a project)
- [Architecture: modules](https://github.com/DiamondForgeFr/SaasFoundryAI/blob/develop/.claude/docs/architecture-modules.md) — internal reference for adding new modules
- [Architecture: skills](https://github.com/DiamondForgeFr/SaasFoundryAI/blob/develop/.claude/docs/architecture-skills.md) — internal reference for adding new skills
- [Migration framework](https://github.com/DiamondForgeFr/SaasFoundryAI/blob/develop/.claude/docs/migration-framework.md) — required reading before any breaking change

### Synchronizing the review button with GitHub Projects

The **Ready for review** button triggers `.github/workflows/pr-review-sync.yml`. It checks the live PR and its linked ticket, then uses the guarded workflow CLI to move the ticket to **In review**.
Configure the `SF_PROJECTS_TOKEN` Actions secret with repository access and write access to the organization Project. GitHub's default Actions token cannot access Projects; see
[GitHub's Projects automation documentation](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/automating-projects-using-actions).

The listener must first be merged into the repository default branch. It never runs code from the PR head. It supports same-repository PRs, requires the native closing-issue link to agree with the
configured branch ticket, and preserves all status guards. Missing credentials or linkage fails visibly; rerun after correcting configuration. Use the CLI manually for fork PRs or clicks made before
installation. Existing custom listeners are preserved during skill installation.
