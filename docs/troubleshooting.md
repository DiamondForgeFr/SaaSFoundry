# Troubleshooting

The most common errors people hit when using SaaSFoundryAI, with the cause and the fix. If you do not find your symptom here, open an issue at
[`github.com/DiamondForgeFr/SaasFoundryAI/issues`](https://github.com/DiamondForgeFr/SaasFoundryAI/issues).

::: tip Self-diagnose first

Run `sf status --no-network` inside your project. It dumps the manifest, the installed modules, and the precondition checks the CLI runs before any command. Most of the errors below surface there
first.

:::

## `docker compose up` says "network saasfoundry-network not found"

**Symptom**

```
ERROR: Network saasfoundry-network declared as external, but could not be found.
```

**Cause** — Generated projects join an external Docker network so the API, the database, and (optionally) MinIO can talk to each other. The network is created once on your machine, not by the compose
file.

**Fix**

```bash
docker network create saasfoundry-network
docker compose up
```

You only have to do this once per machine. The network persists across reboots.

## `npm install` fails on Node 18 / 20 / anything below 22.13

**Symptom**

```
npm warn EBADENGINE Unsupported engine {
  package: 'saasfoundryai-cli',
  required: { node: '>=22.0.0', npm: '>=10.0.0' }
}
```

…or a generated project's TypeScript build fails with `Cannot find name 'using'` or similar modern-syntax errors.

**Cause** — Both the CLI itself and the scaffolded projects pin Node ≥ 22.13. The version is enforced via `package.json` `engines` and `devEngines.runtime`.

**Fix**

```bash
nvm install 22.13   # if you don't have it yet
nvm use             # reads .nvmrc inside any SaaSFoundryAI repo or generated project
node --version      # → v22.13.x or higher
```

If you cannot move off an older Node version, you can set `nvmrc` per project, but the build will keep refusing — there is no compatibility shim.

## `.saasfoundry.json` is invalid (ajv error on every command)

**Symptom**

```
✗ Manifest .saasfoundry.json failed schema validation
  /modules/email — must be one of: { "provider": "mailersend", … }, "none"
```

**Cause** — Every CLI invocation validates `.saasfoundry.json` against the JSON Schema in `schemas/saasfoundry-manifest.schema.json` using ajv. A typo in a key, a stale shape, or a hand-edited value
that no longer matches the current schema all surface here.

**Fix**

1. Read the path the validator points at (e.g. `/modules/email`). That is the field at fault.
2. Open the manifest and compare against the schema. The schema is shipped with the CLI and also published online — your editor can reference `$schema`:
   ```jsonc
   {
     "$schema": "https://raw.githubusercontent.com/DiamondForgeFr/SaasFoundryAI/develop/schemas/saasfoundry-manifest.schema.json",
     ...
   }
   ```
3. If the manifest looks correct but is from an older CLI version, run `sf update` — it will run any pending manifest migrations.

The validator never auto-fixes; it only points at the broken field.

## `sf update` keeps creating `*.saasfoundry.new` sidecars

**Symptom** — After `sf update`, you find files like `apps/api/src/modules/email/services/email.service.ts.saasfoundry.new` next to your real files, and the CLI says:

```
⚠ Conflict: file modified locally and in template — wrote new version to <path>.saasfoundry.new
```

**Cause** — The migration framework writes a sidecar instead of overwriting whenever both the user and the template have changed the same file. This is the safe behaviour: your edits are never
silently overwritten.

**Fix**

1. Open both files side by side (`diff <file> <file>.saasfoundry.new`).
2. Take whichever lines you want from the new template, into your real file.
3. Delete the sidecar (`rm <file>.saasfoundry.new`).

The next `sf update` will not re-create the sidecar unless the template changes again.

## Port already in use (3000 / 5173 / 5435)

**Symptom**

```
Error: listen EADDRINUSE: address already in use 0.0.0.0:3000
```

…or `5173` for the web dev server, or `5435` for the dev database.

**Cause** — Another process (a previous `npm run dev`, a different SaaS project's API, a system service) holds the port.

`sf new` no longer hits this: it picks the next free port for anything it was not told explicitly, and records the choice in `.saasfoundry.json` under `ports`. What is left is a project already
generated on a port that has since been taken by something else.

**Fix**

```bash
# Find the offender
lsof -i :3000          # or :5173, :5435

# Stop it gracefully
kill <pid>

# If it's a docker container
docker ps              # find the container
docker stop <name>
```

To remap the port instead of freeing it, change the `PORT` env var (API), `server.port` in `vite.config.ts` (web), or the `ports` mapping in `docker-compose.db.yml` — and keep `.saasfoundry.json` →
`ports` in step, since `sf update` diffs the regenerated template against it. Both apps log the actual URL on boot — read the line, do not assume the default.

To pin a port at generation time instead, pass `--db-port` / `--api-port` / `--web-port` to `sf new`. Those are honoured or refused, never moved.

## Husky hook failure (commitlint, prettier, eslint)

**Symptom** — Your `git commit` aborts with one of:

```
⧗ input: feat: my feature                           # missing ticket scope
✖ subject may not be empty [subject-empty]
✖ scope may not be empty [scope-empty]
```

…or pre-commit reformats files and tells you to re-stage:

```
✖ Files were formatted by prettier — please git add the result and re-commit
```

**Cause** — Three Husky hooks gate every commit:

| Hook         | What it checks                                                                 |
| ------------ | ------------------------------------------------------------------------------ |
| `commit-msg` | `commitlint` — `<type>(#<ticket>): <description>` shape                        |
| `pre-commit` | `npm run test:pre-commit` — format + lint + build + jest                       |
| `pre-push`   | RC version management and WIP checks; Docker runs explicitly during AI Testing |

**Fix**

- **commitlint failure** — Rewrite the commit message with the right shape: `feat(#317): SRS calibration` etc. The ticket scope is required.
- **Prettier reformatted** — `git add` the formatted files and create a **new** commit. Do **not** `--amend`: the previous commit did happen, you would amend the wrong snapshot. See
  `.claude/skills/sf-workflow/SKILL.md` for the official rationale.
- **ESLint / TS error** — Read the output, fix the reported line, re-stage, re-commit. `--no-verify` exists but every reviewer will ask why.

## "GH not authenticated" / `gh auth status` fails

**Symptom** — `sf workflow`, `sf-workflow/workflow-cli.sh`, or `github-projects-cli.sh` print:

```
✗ gh CLI not authenticated. Run: gh auth login
```

**Cause** — The workflow + ticket-tracking layer talks to GitHub Projects through the official `gh` CLI. Without a logged-in session it cannot read your project board.

**Fix**

```bash
gh auth login                   # follow the browser flow
gh auth status                  # confirm "Logged in to github.com"
```

If you already use `gh` for another account, switch with `gh auth switch`. Tokens live under `~/.config/gh/` — do not commit them.

## SRS skill: `srs-cli.sh validate` exits 5

**Symptom**

```
$ .claude/skills/sf-srs/scripts/srs-cli.sh validate
✗ Notion adapter init failed (network or auth)
exit 5
```

**Cause** — The SRS skill talks to Notion's HTTP API through your integration token. Exit 5 means the adapter could not reach the configured page.

**Fix**

1. Check your Notion API token: `cat ~/.claude/credentials/notion/<account>.env` (or wherever `sf skill install` placed it). The value should start with `secret_…` and not be a placeholder.
2. Confirm the parent page in `tools.srs.rootPage.url` is **explicitly shared with the integration** in Notion's UI. Notion's permission model is opt-in — sharing the workspace is not enough.
3. Check outbound HTTPS to `api.notion.com` is allowed. Corporate proxies and VPC egress rules often block this without a clear error.
4. Re-run `sf skill install sf-srs --reconfigure` if the credentials look right but the page id is stale.

The same exit-code table appears in the SRS walkthrough; this entry exists to surface it from the troubleshooting index.

## `npm run test:docker` times out

**Symptom**

```
Scenario: monorepo-with-email
============================================================
Timeout: scenario exceeded 600s
```

**Cause** — The Docker E2E matrix runs full project generation + `npm install` + `tsc` + `nest build` + `vite build` per scenario. On a slow disk or a cold npm cache, a single scenario can blow past
the default timeout. The full 18-scenario matrix is ~65 minutes; a single scenario is 2–4 minutes typically.

**Fix**

```bash
# Run the failing scenario in isolation to see the real error
npm run test:docker -- --scenario monorepo-with-email

# Pre-warm the npm cache by generating once manually
sf new --project-name warmup --structure monorepo --setup-repo none
cd warmup && npm install && cd .. && rm -rf warmup
```

If a scenario consistently times out on a known-good machine, the assertion list inside `tests/docker/scenarios/<scenario>.sh` may have grown — open an issue with the timeout output attached.

## Node version mismatch in CI but not locally

**Symptom** — Your local `npm test` is green; the GitHub Actions run reports a TypeScript or build error nobody sees on your machine.

**Cause** — The workflow file at `.github/workflows/ci.yml` pins a Node version. If your `.nvmrc` is ahead of the CI version, you may be using a syntax CI cannot parse.

**Fix**

1. Check `.github/workflows/ci.yml` (and any other workflow) for the `actions/setup-node@…` block.
2. Compare against `.nvmrc`.
3. Bring CI up to your `.nvmrc` (preferred) or downgrade locally to match CI.

The CLI repo itself runs on Node 22.13 in CI. Generated projects inherit the same default.

## "I changed a file in `.claude/skills/<skill>/` and the drift-guard test fails"

**Symptom**

```
FAIL src/__tests__/integration/skill/<name>-drift.spec.ts
  expected file content to be byte-equal between
    scaffolds/skills-templates/<name>/<file>
    .claude/skills/<name>/<file>
```

**Cause** — Skills are dogfooded: the local copy under `.claude/skills/<name>/` is pinned byte-for-byte to the source under `scaffolds/skills-templates/<name>/`. The drift-guard test catches edits
that touch one without the other.

**Fix**

```bash
# Source of truth is the scaffold. Edit there first, then sync:
cp scaffolds/skills-templates/<name>/<file> .claude/skills/<name>/<file>

# Re-run the drift-guard
npx jest src/__tests__/integration/skill/<name>-drift.spec.ts --no-coverage
```

If the file was already a symlink (some skills use symlinks instead of copies), the drift can never happen — but most skills still use copies for tooling that does not follow symlinks.

## Where to go next

- **CLI commands** — [`sf new`](/cli/sf-new), [`sf update`](/cli/sf-update), [`sf workflow`](/cli/sf-workflow), [`sf skill install`](/cli/sf-skill)
- **Workflow questions** — [Workflow skill](/skills/core-skills)
- **SRS questions** — [SRS walkthrough](/srs/walkthrough)
- **Bug report or unhandled error** — open an issue with `sf status --no-network` + `sf --version` output attached
