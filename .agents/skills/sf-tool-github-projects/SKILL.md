---
name: sf-tool-github-projects
description: "SaaSFoundry tool github projects procedures. Follow the project workflow and CLI guards."
---

## Execution capabilities

Use the current agent's native tools for reading, editing, shell commands and delegation.
When delegation is available and authorized, assign independent work to agents; otherwise
execute the same steps sequentially. A sequential self-review is not an independent review:
report that limitation and retain any required human review. Tool names in legacy examples
describe capabilities, not required APIs. Use the user's current request as skill arguments.
Do not assume Claude Code hooks, model selection, tool permissions or credentials transfer.
Run preconditions explicitly, and stop to report a missing capability when no equivalent exists.
Never bypass CLI guards, required approvals, tests or workflow status exit conditions.
The project manifest and workflow rules take precedence over generic skill examples,
including branch names, commit formats, staging, pushing and approval requirements.
Legacy /task examples name roles: use native delegation if available and authorized,
or perform the role's work sequentially with the review limitation stated above.

## Parallel implementation and Git worktrees

Propose parallel worktrees only when the user's request contains independent writing streams
that can be delivered concurrently. Read-only exploration and review may use parallel agents
without separate worktrees. Work with sequential dependencies, overlapping file ownership or
unclear boundaries must use one feature worktree and sequential execution.

Before proposing parallel implementation, read `.saasfoundry.json` and use
`workflow.workingBranch`; never hardcode a branch name. Keep the primary checkout on that
configured working branch. Do not let feature workers write in the primary checkout while
parallel worktrees are active.

For each independent writing stream, define one ticket, branch and worktree path, plus its owned
files and dependency boundary. Start from a synchronized configured working branch. Each worker
must stay inside its assigned worktree and ownership boundary, preserve other agents' changes
and never revert unrelated work. The agent proposes this execution shape; the user retains
control when parallel implementation was not already authorized. If authorization, clean
separation, Git support or a synchronized base is unavailable, explain the constraint and use
one worktree or sequential execution.

After each stream is complete, commit and push through the configured workflow. After its merge,
return to the primary checkout, check out and synchronize the configured working branch, verify
the merge, then remove the completed worktree and local branch only when they are merged and no
longer in use. Never remove or overwrite user-owned worktrees, branches, uncommitted changes,
stashes or credentials implicitly.


# GitHub Projects Tool

Integration with GitHub Projects V2 for ticket management, status transitions, and complexity labeling.

## Auto-trigger keywords

github project, create subtask, update ticket status, github issue, project board, set complexity

## Data model

Three orthogonal axes on every ticket:

| Axis           | Where it lives                                                         | What it controls                                                                                                                                                                                                                        |
| -------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**     | Projects V2 board (Single select field "Status")                       | Workflow phase (Backlog → … → Done)                                                                                                                                                                                                     |
| **Complexity** | GitHub label (`complexity: bug\|low\|medium\|complex`)                 | Rigor level applied in each phase (agents, tests, reviews)                                                                                                                                                                              |
| **Type**       | GitHub Issue Type (org-level chip — sf-epic/sf-story/sf-task/sf-issue) | Ticket nature in the hierarchy (replaces `[EPIC]`/`[STORY]` title markers). The `sf-` prefix avoids collisions with vanilla Epic/Story/Task types defined elsewhere in the org and sidesteps the GitHub-reserved singular `Issue` name. |

Never encode status in a label. Never encode complexity on the board. Type is org-scoped — a single set of types serves every repo in the org.

## Configuration

Reads `workflow.projectUrl` and `workflow.workingBranch` from `.saasfoundry.json` — see [manifest schema](../../../.claude/docs/manifest-schema.md).

Supported `projectUrl` formats: `https://github.com/orgs/<owner>/projects/<N>` or `https://github.com/users/<owner>/projects/<N>`. Requires `gh auth login` with `project` + `repo` scopes.

## Output language

Ticket titles, bodies and comments are written in **`language.tickets`** from `.saasfoundry.json` (`jq -r '.language.tickets // "en"'`), which defaults to English — never in the language of the
conversation. A French-speaking session still files English tickets unless the project opted that surface out.

## Commands

All via `.claude/skills/sf-tool-github-projects/github-projects-cli.sh <cmd> [args]`.

| Command                                  | Purpose                                                                                           |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `create-subtask <parent> <title> [body]` | Create a GitHub sub-issue linked to parent via GraphQL `addSubIssue`                              |
| `status <ticket>`                        | Read status from Projects V2 board                                                                |
| `update-status <ticket> <status-name>`   | Write status on Projects V2 board (`gh project item-edit`)                                        |
| `set-complexity <ticket> <level>`        | Set label `complexity: <bug\|low\|medium\|complex>` (removes any existing complexity label first) |
| `get-complexity <ticket>`                | Read current complexity label                                                                     |
| `get-labels <ticket>`                    | Print every label name, one per line (used by `sf-workflow` SRS guard)                            |
| `list-incomplete-children <parent>`      | List native children whose configured project Status is not exactly `Done`                        |
| `get-parent <child>`                     | Read a ticket's native parent issue                                                               |
| `get-issue-type <ticket>`                | Read the native organization issue type                                                           |
| `get-ticket <ticket>`                    | Print title + body (used by `detect-complexity.sh`)                                               |
| `create-pr <ticket> [--draft]`           | Push branch + open/reuse PR against `workingBranch`; preserve existing draft state                |
| `list [status]`                          | List project items, optionally filtered by status                                                 |
| `ensure-issue-types [--dry-run]`         | Idempotently create org-level issue types from `workflow.issueTypes` in `.saasfoundry.json`       |
| `assign-type <issue> <type>`             | Attach a native GitHub Issue Type chip (sf-epic/sf-story/sf-task/sf-issue) to the issue           |
| `delete-issue-type <type>`               | Remove an issue type from the org (cleanup of legacy types like Bug/Feature)                      |

Status names are case-insensitive — the CLI matches against the options defined on the board.

`ready-pr <ticket>` verifies the pushed branch and promotes its existing draft PR; retries are idempotent. Use it only after developer validation when Human Testing applies. `draft-pr <ticket>`
explicitly returns a ready PR to draft for further human testing, with the same branch/head checks.

## How the orchestration skill uses this CLI

`sf-workflow/workflow-cli.sh` routes every tool-specific call through this CLI:

```bash
# e.g. sf-workflow/workflow-cli.sh retag 42 complex
#   → github-projects-cli.sh set-complexity 42 complex

# e.g. sf-workflow/workflow-cli.sh status 42
#   → github-projects-cli.sh status 42
```

## Complexity labels

The following labels must exist in the repo (create them once):

| Label                 | Color     | Use case                                        |
| --------------------- | --------- | ----------------------------------------------- |
| `complexity: bug`     | `#FF5555` | Bug fix — direct fix + regression test          |
| `complexity: low`     | `#7CFC00` | Oneshot-style, minimal ceremony                 |
| `complexity: medium`  | `#FFD700` | Structured plan + validation                    |
| `complexity: complex` | `#FF1493` | Full adversarial review (security, logic, perf) |

Create them with:

```bash
gh label create "complexity: bug"     --color FF5555 --description "🐛 Bug fix"
gh label create "complexity: low"     --color 7CFC00 --description "🟢 Low complexity"
gh label create "complexity: medium"  --color FFD700 --description "🟡 Medium complexity"
gh label create "complexity: complex" --color FF1493 --description "🔴 Complex / critical"
```

## SRS workflow labels

Applied on backlog / ready tickets so the `sf-srs` skill picks the right drafter when a ticket becomes active. A ticket carries at most one SRS label at a time ; absence of an SRS label means `sf-srs`
leaves the ticket alone.

| Label          | Color     | Applied when…                                                  |
| -------------- | --------- | -------------------------------------------------------------- |
| `srs:drafting` | `#8B5CF6` | Spec needs to be drafted / refined before the team can commit. |
| `srs:update`   | `#F97316` | Existing SRS page must be updated to match code drift.         |
| `srs:new`      | `#3B82F6` | New Epic / FR spec to be created from scratch.                 |

Create them with (idempotent — `|| true` swallows the exit code when the label already exists) :

```bash
gh label create "srs:drafting" --color 8B5CF6 --description "sf-srs: ticket needs spec drafting / refinement" || true
gh label create "srs:update"   --color F97316 --description "sf-srs: existing SRS page must be updated"        || true
gh label create "srs:new"      --color 3B82F6 --description "sf-srs: create a new Epic / FR spec from scratch" || true
```

See `.claude/skills/sf-srs/SKILL.md` for the end-to-end contract and `.claude/docs/github-labels.md` for the full label catalogue.

## Example — full ticket lifecycle

```bash
CLI=.claude/skills/sf-tool-github-projects/github-projects-cli.sh

# 1. Tag complexity (AI suggests, developer confirms)
$CLI set-complexity 42 medium

# 2. Subtasks
$CLI create-subtask 42 "Backend API"
$CLI create-subtask 42 "Frontend UI"

# 3. Status transitions (from the board, not labels)
$CLI update-status 42 "In progress"
$CLI update-status 42 "AI testing"
$CLI create-pr 42 --draft
$CLI update-status 42 "Human testing"

# 4. PR + review + done
# After human approval and non-regression tests are pushed:
$CLI ready-pr 42
$CLI update-status 42 "In review"
# (after merge)
$CLI update-status 42 "Done"
```

## Issue Types (org-level chips)

Native GitHub Issue Types replace the legacy textual title markers (`[EPIC]`, `[STORY]`, `[Parent #N]`). Types live at the **organisation** level — one canonical set is shared across every repo in the
org. The CLI keeps the org in sync with `.saasfoundry.json` → `workflow.issueTypes[]`:

```bash
# 1. One-time setup — create missing types declared in the manifest (idempotent)
$CLI ensure-issue-types

# 2. Assign a type to an existing issue
$CLI assign-type 42 Story

# 3. Cleanup — remove a legacy type after reassigning its issues
$CLI delete-issue-type Bug
```

`create-subtask` automatically calls `assign-type` for the matching native type after creation (best-effort — subtask creation never fails because of a type-assignment hiccup).

**Permissions** — `ensure-issue-types`, `assign-type`, and `delete-issue-type` write to org-level config and require the `admin:org` scope on the `gh` token. Refresh once with:

```bash
gh auth refresh --hostname github.com --scopes admin:org
```

Without that scope the CLI still works for read paths and prints an actionable message before exiting (no silent failure).

## Requirements

- `gh` CLI authenticated (`gh auth status` must show `project` + `repo` scopes)
- `gh` token has `admin:org` scope **only** if you'll run the Issue Types commands (otherwise read paths are enough)
- `jq` for JSON parsing
- Project exists with a single-select "Status" field whose options match `.saasfoundry.json` → `workflow.statuses`

## Troubleshooting

**`Could not load project <N> for owner <X>`** Check `.saasfoundry.json` → `workflow.projectUrl` matches a real project. Run `gh project list --owner <owner>` to see what you have access to.

**`Ticket #N is not on project board`** The issue exists but hasn't been added to the project. Add it via the board UI or `gh project item-add`.

**`Unknown status '<name>'`** Status must exactly match an option on the board (case is ignored). The CLI prints the available options on error.
