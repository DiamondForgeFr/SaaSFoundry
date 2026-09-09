# GitHub Labels — Feedback Loop and SRS Workflow

The SaaSFoundryAI upstream repository (`DiamondForgeFr/SaasFoundryAI`) and every generated project expects the labels below to exist. They're used for issue classification, dedup search, voting
filters, and to let `sf-srs` detect drafting / update / creation events on the board.

> **Auto-provisioning** — `sf new --profile harness` creates the workflow guard labels (`complexity:*`, `nature:*`, and `srs:*` when an SRS backend is configured) on the target repo automatically and
> idempotently, right after writing the manifest. The canonical catalogue lives in `src/installers/harness-provisioning.ts` (`buildWorkflowLabels`); the tables below mirror it. The manual
> `gh label create` snippets remain useful for the upstream repo and for the feedback labels, which are **not** auto-provisioned on consumer projects.

## Labels used by `sf feedback`

| Label            | Color     | Purpose                                                                                                |
| ---------------- | --------- | ------------------------------------------------------------------------------------------------------ |
| `module-request` | `#0e8a16` | A user-filed request for a new module or optional skill. Sortable by 👍 for `sf feedback vote --list`. |
| `cli-bug`        | `#b60205` | A bug in the `sf` CLI itself (commands, prompts, non-interactive flags, etc.).                         |
| `scaffold-bug`   | `#d93f0b` | A bug in generated project code (scaffolds/blueprints/overlays/modules).                               |

## Labels used by `sf-srs`

The SRS workflow relies on three labels applied by maintainers on backlog / ready tickets. `sf-srs` reads them to decide which drafter (or spawner) to engage :

| Label          | Color     | Applied when…                                                                                   | `sf-srs` reaction                                                                              |
| -------------- | --------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `srs:drafting` | `#8B5CF6` | A ticket needs its FR / Epic specification drafted or refined before the team can commit to it. | The skill enters drafting mode : browse → draft → write (see `sf-srs/SKILL.md`).               |
| `srs:update`   | `#F97316` | An existing SRS page must be updated to match code that has drifted from its documented spec.   | The skill audits the linked page, proposes a diff, and updates in place (owned by SUB-8).      |
| `srs:new`      | `#3B82F6` | A new Epic / FR page must be created from scratch (no existing notes, purely forward-looking).  | The skill runs the new-spec drafter (interactive — owned by SUB-8) and writes via `write-srs`. |

A ticket carries at most one SRS label at a time. `sf-srs` treats "no SRS label" as "this ticket does not need SRS involvement".

## One-time setup on a fresh fork or repo

Run once, from anywhere (requires `gh auth login`). The `|| true` keeps the script idempotent — existing labels return a non-zero exit code but we don't want the loop to abort.

```bash
# Feedback labels
gh label create module-request --repo DiamondForgeFr/SaasFoundryAI --color 0e8a16 --description "User-filed module request" || true
gh label create cli-bug        --repo DiamondForgeFr/SaasFoundryAI --color b60205 --description "Bug in the sf CLI"         || true
gh label create scaffold-bug   --repo DiamondForgeFr/SaasFoundryAI --color d93f0b --description "Bug in generated code"     || true

# SRS workflow labels
gh label create srs:drafting --repo DiamondForgeFr/SaasFoundryAI --color 8B5CF6 --description "sf-srs: ticket needs spec drafting / refinement" || true
gh label create srs:update   --repo DiamondForgeFr/SaasFoundryAI --color F97316 --description "sf-srs: existing SRS page must be updated"        || true
gh label create srs:new      --repo DiamondForgeFr/SaasFoundryAI --color 3B82F6 --description "sf-srs: create a new Epic / FR spec from scratch" || true
```

## How the CLI uses these labels

- **`sf feedback request`** creates issues with `module-request` and searches existing `module-request` issues to dedup.
- **`sf feedback bug --source cli`** creates with `cli-bug` ; `--source scaffold` uses `scaffold-bug`. Both search their own label for dedup.
- **`sf feedback list`** filters by all three feedback labels by default and shows them in a single table.
- **`sf feedback vote --list`** ranks open `module-request` issues by 👍 reaction count.
- **`sf-srs` skill** reads the `srs:*` label on an active ticket to pick the right drafter action (see `.claude/skills/sf-srs/SKILL.md` — "How other skills hand off to `sf-srs`").

## Labels used by `sf-workflow` (Nature axis)

The Nature axis controls whether a ticket must visit **Human Testing** or can skip straight to **In Review** after AI Testing. See `.claude/skills/sf-workflow/SKILL.md` "Nature axis" section.

| Label                | Color     | Purpose                                                                                                      | Workflow effect                                               |
| -------------------- | --------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| `nature:user-facing` | `#0E8A16` | Bug fix or feature with visible UX impact (default behaviour when no `nature:*` label).                      | Mandatory `AI Testing → Human Testing → In Review → Done`     |
| `nature:internal`    | `#C5DEF5` | Refactor, scaffolding, internal tooling, doc-only change — ships its own PR.                                 | Optional `AI Testing → In Review → Done` (skip Human Testing) |
| `nature:bundled-pr`  | `#FBCA04` | Child ticket under a delivery parent; one atomic commit lands on the parent's branch, with no individual PR. | `AI Testing → Done` (skip Human Testing **and** In Review)    |

Create them once with:

```bash
gh label create "nature:user-facing" --repo DiamondForgeFr/SaasFoundryAI --color "0E8A16" --description "Workflow: ticket has user-visible impact, requires Human Testing" || true
gh label create "nature:internal"    --repo DiamondForgeFr/SaasFoundryAI --color "C5DEF5" --description "Workflow: refactor/scaffolding/non-terminal story, Human Testing optional" || true
gh label create "nature:bundled-pr"  --repo DiamondForgeFr/SaasFoundryAI --color "FBCA04" --description "Workflow: bundled child commit on delivery parent branch, skips In Review" || true
```

The `workflow-cli.sh update-status` guard enforces the rule — see "Nature guard" in `.claude/skills/sf-workflow/workflow-cli.sh`.

## Not managed here

- `complexity: {bug,low,medium,complex}` — internal workflow labels, managed by `sf-tool-github-projects` (see `.claude/skills/sf-tool-github-projects/`).
- Any custom label a maintainer adds manually — the CLI ignores unrecognized labels.
