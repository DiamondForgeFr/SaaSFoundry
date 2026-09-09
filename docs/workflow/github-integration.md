# GitHub Integration

The `sf-tool-github-projects` skill is the reference adapter for the SaaSFoundryAI workflow. It maps the 7-status lifecycle and the complexity system onto GitHub Projects V2 and GitHub Issues —
including sub-issue relationships via the GraphQL `addSubIssue` mutation.

If you pick GitHub as your workflow tool during `sf new`, this is the integration you get.

## Data model

Two orthogonal axes on every ticket:

| Axis           | Where it lives                                               | What it controls                                           |
| -------------- | ------------------------------------------------------------ | ---------------------------------------------------------- |
| **Status**     | Projects V2 board (single-select field "Status")             | Workflow phase (Backlog → ... → Done)                      |
| **Complexity** | GitHub label (`complexity: bug \| low \| medium \| complex`) | Rigor level applied at each phase (agents, tests, reviews) |

**Never encode status in a label. Never encode complexity on the board.** Keeping them independent is what makes retagging cheap and keeps the board free of phase-specific label noise.

## Prerequisites

- A GitHub Projects V2 board with a "Status" single-select field exposing the 7 options (`Backlog`, `Ready`, `In progress`, `AI testing`, `Human testing`, `In review`, `Done`).
- The 4 complexity labels created in the repo (see below).
- `gh` CLI authenticated with `project` and `repo` scopes: `gh auth login`.
- `.saasfoundry.json` pointing at the board:

```json
{
  "workflow": {
    "projectUrl": "https://github.com/orgs/<owner>/projects/<number>",
    "workingBranch": "develop",
    "prTargetBranch": "master"
  }
}
```

Supported `projectUrl` formats: `https://github.com/orgs/<owner>/projects/<number>` or `https://github.com/users/<owner>/projects/<number>`.

## Creating the complexity labels

One-time setup per repo:

```bash
gh label create "complexity: bug"     --color FF5555 --description "🐛 Bug fix"
gh label create "complexity: low"     --color 7CFC00 --description "🟢 Low complexity"
gh label create "complexity: medium"  --color FFD700 --description "🟡 Medium complexity"
gh label create "complexity: complex" --color FF1493 --description "🔴 Complex / critical"
```

Colours are suggestions — the workflow reads the labels by name, not by colour.

## The CLI

All interactions go through `.claude/skills/sf-tool-github-projects/github-projects-cli.sh`:

| Command                                  | Purpose                                                                           |
| ---------------------------------------- | --------------------------------------------------------------------------------- |
| `create-subtask <parent> <title> [body]` | Create a GitHub sub-issue linked to parent via the GraphQL `addSubIssue` mutation |
| `status <ticket>`                        | Read the current status from the Projects V2 board                                |
| `update-status <ticket> <status-name>`   | Write status on the board via `gh project item-edit`                              |
| `set-complexity <ticket> <level>`        | Set `complexity: <level>` label (removes any existing complexity label first)     |
| `get-complexity <ticket>`                | Read the current complexity label                                                 |
| `get-ticket <ticket>`                    | Print title + body (used by `detect-complexity.sh`)                               |
| `create-pr <ticket>`                     | Push the branch and open a PR against `prTargetBranch`                            |
| `list [status]`                          | List project items, optionally filtered by status                                 |

Status names are case-insensitive — the CLI matches against the options configured on the board.

## Routing from the orchestration skill

`sf-workflow/workflow-cli.sh` is the tool-agnostic entry point. Every command it receives is routed to the appropriate tool-specific CLI based on `workflow.projectUrl`:

```bash
# sf-workflow/workflow-cli.sh retag 42 complex
#   → github-projects-cli.sh set-complexity 42 complex

# sf-workflow/workflow-cli.sh status 42
#   → github-projects-cli.sh status 42

# sf-workflow/workflow-cli.sh create-subtask 42 "Backend API"
#   → github-projects-cli.sh create-subtask 42 "Backend API"
```

If you swap tools (say, GitHub → Linear), the orchestration skill keeps working — you swap the underlying CLI, not the commands the AI agent issues.

## Full ticket lifecycle example

Here is a complete run through the workflow, using only CLI calls:

```bash
CLI=.claude/skills/sf-tool-github-projects/github-projects-cli.sh

# --- Backlog phase ---

# 1. Tag complexity (AI suggests via detect-complexity.sh, developer confirms)
$CLI set-complexity 42 medium

# 2. Ticket validated, move to Ready
$CLI update-status 42 "Ready"

# --- In progress phase ---

# 3. Start work: create branch + move to In progress
git checkout develop && git pull --rebase && git checkout -b feature/42-add-billing
$CLI update-status 42 "In progress"

# 4. Decompose into real sub-issues (NOT checkboxes)
$CLI create-subtask 42 "Backend API"
$CLI create-subtask 42 "Frontend UI"
$CLI create-subtask 42 "Unit tests"

# 5. Deliver child tickets: normal children use their own branch/PR; bundled children are one atomic parent-branch commit
git commit -m "feat(#SUB-1): backend API" && git push
$CLI update-status <SUB-1> "Done"    # close immediately

git commit -m "feat(#SUB-2): frontend UI" && git push
$CLI update-status <SUB-2> "Done"

git commit -m "test(#SUB-3): unit tests" && git push
$CLI update-status <SUB-3> "Done"

# --- AI testing phase ---

# 6. Move to AI testing, generate test plan, run automated checks
$CLI update-status 42 "AI testing"
npm run build && npm run lint && npm run type-check && npm run test:unit

# --- Human testing phase ---

# 7. Move to Human testing, wait for developer validation
$CLI update-status 42 "Human testing"

# 8. Developer validates → add non-regression tests
git commit -m "test(#42): add E2E regression tests" && git push

# --- In review phase ---

# 9. Open the PR and move to In review
$CLI create-pr 42
$CLI update-status 42 "In review"

# 10. Wait for green CI and reviewer approval, then merge via GitHub UI

# --- Done phase ---

# 11. Verify every child project-board Status is Done, then move parent to Done and clean up
$CLI list-incomplete-children 42    # must return []
$CLI update-status 42 "Done"
git checkout develop && git pull --rebase
git branch -d feature/42-add-billing
```

## Native sub-issue relationships

The `create-subtask` command performs two operations atomically:

1. `gh issue create` — creates the sub-issue with the requested title and body.
2. `gh api graphql -f query='mutation { addSubIssue(input: {issueId: $parent, subIssueId: $sub}) { ... } }'` — establishes the native sub-issue relationship.

`list-incomplete-children` reads that native relationship through GitHub's paginated sub-issues REST endpoint, then resolves each child's Status on the configured project board. It does not depend on
a title prefix, body text, or the issue's open/closed state.

Without `addSubIssue`, the child is not part of the parent's native hierarchy and cannot participate in the parent Done gate or Epic status roll-up.

## Where to look when things go wrong

- **Status transitions fail** → check that the board's "Status" field has all 7 options spelled exactly as the workflow expects (case-insensitive, but every option must exist).
- **`list-incomplete-children <N>` omits a known child** → the GraphQL `addSubIssue` call likely failed. Re-create the sub-issue via `create-subtask` instead of raw `gh issue create`.
- **Complexity label not changing** → `set-complexity` removes existing complexity labels before adding the new one. If you applied labels manually, there may be a stale complexity label it didn't
  know about. `get-complexity` reports what it sees.
- **PR creation fails** → verify `.saasfoundry.json` has `workflow.prTargetBranch` set and the branch is pushed. `create-pr` does not push for you — push first.

## Swapping tools

::: warning Jira / Notion / Linear / ClickUp adapters — on the roadmap

The `sf-workflow` orchestration layer is already tool-agnostic, but the only adapter that ships today is `sf-tool-github-projects`. The checklist below describes the target behaviour for when the
other adapters land. Track progress on the [public issues](https://github.com/DiamondForgeFr/SaasFoundryAI/issues).

:::

If you later migrate to Jira, Notion, Linear, or ClickUp, the checklist will be:

1. Regenerate the skill: `sf skill install --force` (after running `sf new` with the new workflow tool, or via `sf update`).
2. Update `.saasfoundry.json` → `workflow.projectUrl` to point at the new tool's board.
3. Recreate the 7 statuses and the 4 complexity labels/tags in the new tool.
4. The orchestration skill (`sf-workflow`) auto-routes to the new tool-specific CLI — no change to your workflow commands.

Once they ship, `.claude/skills/sf-tool-jira/SKILL.md`, `.claude/skills/sf-tool-notion/SKILL.md`, `.claude/skills/sf-tool-linear/SKILL.md` and `.claude/skills/sf-tool-clickup/SKILL.md` will mirror the
GitHub Projects command reference.
