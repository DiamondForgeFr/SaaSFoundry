---
status: In Review
banner_ai: Monitor CI until green, answer review comments, implement requested changes
banner_human: Review + merge the PR — your merge is what triggers Done
complexity_profiles: [bug, low, medium, complex]
entry_conditions:
  - One of:
      - Human Testing validated + non-regression tests created and pushed (`nature:user-facing` path)
      - AI Testing passed + ticket carries `nature:internal` label (skip-Human-Testing path — see SKILL.md "Nature axis")
  - **An open, non-draft Pull Request exists for the ticket** (PR-existence guard — `In Review` without a PR is rejected by the CLI)
  - Ticket is **not** `nature:bundled-pr` — those go AI Testing → Done directly (no individual PR at this Sub level)
mandatory_actions:
  - Promote the approved draft via `workflow-cli.sh ready-pr <ticket>`; internal tickets may create a ready PR directly
  - Move ticket to `In Review`
  - Monitor CI until green
  - Answer reviewer comments and implement requested changes
  - Add tests when reviewer asks; verify locally, commit, push, wait for green CI
  - Wait for approval AND green CI — do NOT merge
exit_conditions:
  - PR approved by all required reviewers
  - CI is green
  - Developer merged the PR to the target branch
next_status: Done
---

# STATUS: In Review

Code review with mandatory green CI.

## Ticket type

- **Epic** — **never produces a PR**. Status is **derived** — reflects that every child Story/Task/Issue is itself in `In Review` (one open PR per child) **or** has gone AI Testing → Done as a
  `nature:bundled-pr` Sub. When an Epic uses bundled-PR Subs, the Epic itself opens **one** PR at the very end. Skip the checklist for the Epic ticket.
- **Story / Task / Issue with its own PR** — full flow below, one PR per ticket.
- **`nature:bundled-pr` Sub** — **never enters `In Review`**. Goes AI Testing → Done directly. The CLI rejects `update-status <ticket> "In review"` for these tickets.

## Action checklist

- [ ] **Ready PR** — promote the approved draft using `workflow-cli.sh ready-pr <ticket>`. Internal tickets may use `create-pr <ticket>` directly. Keep the ticket link, change summary, test
      plan/results and created tests in its description; assign configured reviewers.
- [ ] **Move ticket** to `In Review` via `workflow-cli.sh update-status`
- [ ] **Monitor CI** — readiness starts the complete applicable suite, and later non-draft pushes rerun it. Draft-skipped checks are not successful validation.
- [ ] **Handle CI failures** — on red: analyze logs, fix, commit, push, wait for green
- [ ] **Human retesting needed** — `workflow-cli.sh draft-pr <ticket>` explicitly returns the PR to draft and cancels obsolete CI under the configured policy; fix and rerun AI Testing before returning
      to Human Testing.
- [ ] **Monitor reviews** — answer questions, implement requested changes
- [ ] **Reviewer asks for extra tests** — create them, run locally, commit, push, wait for green CI, resolve conversation
- [ ] **Wait for approval + green CI** — do nothing until the developer merges

## Errors to avoid

- Asking the developer to merge with red CI
- Ignoring test failures in CI
- Merging yourself (unless explicitly instructed)

## Guard

`workflow-cli.sh update-status <N> "In review"` exits non-zero when no open, non-draft PR has a head branch matching `feature/<N>-…` or `fix/<N>-…`. Escape hatch (rare, e.g. a PR opened from a
differently-named branch): `SF_WORKFLOW_BYPASS_PR_EXISTENCE_GUARD=1`.

> [!note] Convention sanity check
>
> This guard — and the `→ Done` PR-merged guard — only match when branches carry the ticket number, exactly the convention declared in `.saasfoundry.json` → `workflow.branchNaming`
> (`feature/{N}-{description}`, `fix/{N}-{description}`). The two must stay in lock-step. Quick check (should print `ok`):
> `echo "fix/32-detection-dropdown" | grep -Eq '^(feature|fix)/32(-|$)' && echo ok`. A branch missing the `{N}` ticket prefix (e.g. `fix/some-name`) silently fails the guard and forces
> `SF_WORKFLOW_BYPASS_*` on every ticket — realign `branchNaming`, never "fix" the regex. A non-regression test locks both sides together: `src/__tests__/unit/skill/branch-naming-pr-regex.spec.ts`.
