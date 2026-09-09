---
status: In Progress
banner_ai: Branch from workingBranch, deliver child tickets, validate (build/lint/tests), push
banner_human: Nothing yet — next involvement at In Review (PR review is the human gate)
complexity_profiles: [bug, low, medium, complex]
entry_conditions:
  - Plan validated and pickup confirmed in Backlog
  - Ready to start development
mandatory_actions:
  - Create feature branch from `workingBranch` (manifest)
  - Move ticket to `In Progress`
  - Deliver each child ticket in its declared mode; close it immediately when its PR is merged or its bundled commit is validated
  - Final validation — build, lint, unit tests green
  - Push branch
exit_conditions:
  - Code compiles without errors
  - Lint passes
  - Existing tests pass
  - Branch pushed to remote
next_status: AI Testing
---

# STATUS: In Progress

Active development — subtask creation, iterative commits, final validation.

## Ticket type

- **Epic** (`sf-epic` issue type): optional grouping ticket; no branch, commit, or PR. Only create and coordinate delivery-parent children. Epic status is **derived** from those children.
- **Story / Task / Issue**: full flow below.
- **Child ticket**: always a native GitHub sub-issue created with `create-subtask`. A normal child owns its branch and PR; a `nature:bundled-pr` child contributes one atomic commit on this parent's branch and has no own PR.

## SRS drafting tickets (`srs:drafting | srs:update | srs:new`)

These stay in the `In progress` board column but flow through a **separate lifecycle** — see `statuses-solo/2a-ai-drafting.md`. Drive with
`workflow-cli.sh transition-drafting <ticket> <ai-draft|human-review|spawning|done>`. Never use `update-status` — the SRS guard blocks code-path transitions.

## Action checklist — Story / Task / Issue

- [ ] **Branch** — from `jq -r '.workflow.workingBranch' .saasfoundry.json`, pattern `jq -r '.workflow.branchNaming.feature'`
  - `git checkout <workingBranch> && git pull --rebase && git checkout -b feature/<N>-<description>`
- [ ] **Move ticket to "In Progress"** via `workflow-cli.sh update-status <ticket> "In progress"`
- [ ] **Per normal child:** branch → code → PR → verify merge → close the child; per bundled child: one atomic commit on the parent's branch → validate → close the child
- [ ] **Parent implementation done:** `npm run build && npm run lint` → tests → push. Child tickets may continue through their own lifecycle.

## Errors to avoid

- Coding without creating a branch first
- Mixing multiple tickets in the same branch
- Moving to AI Testing with lint/build errors
- Forgetting to push before AI Testing
- Starting another ticket while this one is still In Progress / AI Testing / In Review (unless the developer explicitly asks to pause)
