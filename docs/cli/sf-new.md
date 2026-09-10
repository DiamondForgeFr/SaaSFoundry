# sf new

Create a new SaaSFoundryAI project with interactive prompts, or scripted scaffolding via flags.

## Usage

```bash
sf new [options]
```

## Options

| Flag                                           | Description                                                     | Default |
| ---------------------------------------------- | --------------------------------------------------------------- | ------- |
| `--profile <profile>`                          | What to install: `full`, `harness`, or `stack`                  | `full`  |
| `--agents <agents>`                            | Comma-separated coding tools to support in the harness          | Claude¹ |
| `--non-interactive`                            | Fail if any required value is missing instead of prompting      | -       |
| `--project-name <name>`                        | Project name (kebab-case)                                       | -       |
| `--project-description <description>`          | Project description                                             | -       |
| `--structure <structure>`                      | Project structure: `monorepo` or `multirepo`                    | -       |
| `--main-branch <branch>`                       | Main branch name: `main` or `master`                            | -       |
| `--setup-repo <setup>`                         | Repository setup: `local` or `existing`                         | -       |
| `--monorepo-url <url>`                         | Monorepo remote URL (monorepo + existing)                       | -       |
| `--backend-repo-url <url>`                     | Backend repo URL (multirepo + existing)                         | -       |
| `--frontend-repo-url <url>`                    | Frontend repo URL (multirepo + existing)                        | -       |
| `--db-setup <setup>`                           | Database: `docker`, `credentials`, or `manual`                  | -       |
| `--db-type <type>`                             | Database type: `postgresql` or `sql`                            | -       |
| `--db-port <port>`                             | Host port for the dev database                                  | `5435`  |
| `--api-port <port>`                            | Host port the API listens on                                    | `3500`  |
| `--web-port <port>`                            | Host port the web dev server listens on                         | `5173`  |
| `--email-service <service>`                    | Email service: `none` or `mailersend`                           | -       |
| `--s3-setup <setup>`                           | S3 storage: `docker`, `credentials`, or `manual`                | -       |
| `--analytics / --no-analytics`                 | Include (or skip) the analytics module                          | -       |
| `--pwa / --no-pwa`                             | Make the app installable as a desktop application               | on      |
| `--advanced-skills <skills>`                   | Comma-separated: `context7,atlassian,notion,figma`              | -       |
| `--srs-enable / --no-srs-enable`               | Enable the [SRS module](/modules/srs) (pluggable spec system)   | -       |
| `--srs-backend <backend>`                      | SRS backend: `notion` (Confluence + local-markdown on roadmap)  | -       |
| `--srs-parent-page-input <url>`                | SRS root page URL (or ID) on the chosen backend                 | -       |
| `--srs-ingest-enable / --no-srs-ingest-enable` | Ingest existing notes on first open (one-shot)                  | -       |
| `--srs-ingest-parent-input <url>`              | Source parent page for ingestion (URL or ID)                    | -       |
| `--workflow <config> / --no-workflow`          | Workflow preset, `none`, or skip workflow entirely              | -       |
| `--start-services / --no-start-services`       | Auto-start dev services (DB + MinIO) after setup                | -       |
| `--start-apps <mode>`                          | Apps to start after setup: `all`, `backend`, `frontend`, `none` | -       |

## Ports

Two generated projects can run side by side. `sf new` resolves three host ports before it writes anything:

|          | default | when it is taken           |
| -------- | ------- | -------------------------- |
| database | `5435`  | the next free port is used |
| API      | `3500`  | the next free port is used |
| web      | `5173`  | the next free port is used |

**A port you asked for is never moved.** If `--api-port 3500` is taken, `sf new` stops and names what holds it — you said what you wanted, and quietly running somewhere else would be the tool
disagreeing without telling you. Only the defaults scan forward.

The chosen ports are written to `.saasfoundry.json` under `ports`, and every generated file that names a port — `.env`, the composes, `vite.config.ts`, the docs — carries them. Manifests written
before this existed have no `ports` block; those projects run on the defaults.

A `--db-port` under `--db-setup credentials` or `manual` points at a database you host elsewhere, so it is passed through untouched and never scanned.

## Installation profiles

`--profile` decides **what** `sf new` installs. It is the first question the interactive flow asks, and it changes which of the later questions are asked at all.

| Profile   | Installs                                                       | Use when                                                                       |
| --------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `full`    | Technical stack **and** the AI harness (workflow, skills, SRS) | Starting a new product from scratch — the default                              |
| `stack`   | The technical stack only                                       | You want the scaffold without the AI collaboration layer                       |
| `harness` | The AI harness only, onto an existing repository               | You already have a codebase and want the workflow, skills and SRS on top of it |

`harness` never creates a project directory and never touches your technical stack — it deposits the AI layer into the repository you run it from. Stack questions (database, storage, email,
installable app) are skipped entirely, because there is nothing to scaffold.

In `--non-interactive` mode the profile defaults to `full`, so existing flag-driven invocations keep behaving as they did before profiles existed.

For `full` and `harness`, the interactive flow asks which coding tools should share the harness immediately after the profile. The registered IDs are `claude-code`, `codex`, `kimi`, `gemini-cli`,
`qwen-code`, and `generic`. The CLI trims and deduplicates a comma-separated `--agents` value and rejects unknown IDs. These are tool hosts, not model or provider names; model credentials and routing
stay in each developer's host configuration.

In scripted runs, omitting `--agents` preserves the historical implicit Claude Code declaration. The `stack` profile skips agent selection. A multirepo scaffold writes an independent harness manifest
and bootstrap entrypoints into both application repositories; the outer manifest remains the stack-generation coordinator. `AGENTS.md` and `GEMINI.md` are universal onboarding surfaces even when their
tools are not declared, so a newly arriving supported host can request consent. The declaration controls the effective inventory and shared skill copies. An unrelated custom entrypoint for an
undeclared tool is preserved and does not block another tool's onboarding.

¹ Legacy fallback when `--agents` is omitted. An explicit value is stored in `modules.harness.agents`.

## Examples

```bash
# Interactive wizard
sf new
```

```bash
# Scripted scaffold (monorepo, postgres via docker, no analytics)
sf new --non-interactive \
  --project-name my-saas \
  --agents claude-code,codex \
  --structure monorepo \
  --setup-repo local \
  --db-setup docker \
  --db-type postgresql \
  --email-service none \
  --no-analytics \
  --start-services --start-apps all
```

```bash
# With SRS enabled (Notion backend, empty SRS root)
sf new --non-interactive \
  --project-name my-saas \
  --structure monorepo \
  --setup-repo local \
  --db-setup docker --db-type postgresql \
  --email-service none --no-analytics \
  --advanced-skills notion \
  --srs-enable \
  --srs-backend notion \
  --srs-parent-page-input "https://www.notion.so/your-workspace/SRS-root-abc123"
```

## Notes

See `sf new --help` for the full flag surface (database credentials, MailerSend keys, S3 credentials, Atlassian/Notion/Figma tokens). Most flags are only validated when the relevant module is enabled.

## See Also

- [CLI Commands](/cli/sf-new)
- [Getting Started](/getting-started/quick-start)
