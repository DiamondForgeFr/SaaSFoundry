---
status: In Review
banner_ai: Monitor CI until green, answer review comments, implement requested changes
banner_human: Review + merge the PR — this is the human gate of the solo workflow; your merge triggers Done
complexity_profiles: [bug, low, medium, complex]
entry_conditions:
  - AI Testing passed with the test report posted
  - "**An open, non-draft Pull Request exists for the ticket** (PR-existence guard — `In Review` without a PR is rejected by the CLI)"
  - Ticket is **not** `nature:bundled-pr` — bundled children go AI Testing → Done directly (no individual child PR)
mandatory_actions:
  - Create the Pull Request (title + description + test plan + test list + ticket link)
  - Move ticket to `In Review`
  - Monitor CI until green
  - Answer reviewer comments and implement requested changes
  - Add tests when the reviewer asks; verify locally, commit, push, wait for green CI
  - Wait for approval AND green CI — do NOT merge
exit_conditions:
  - PR approved by the developer
  - CI is green
  - Developer merged the PR to the target branch
next_status: Done
---

# STATUS: In Review

**The human gate of the solo workflow.** There is no separate manual-testing status — the developer validates here: reviewing the diff, reading the test report, and testing manually when the change warrants it. The AI's job is to make that review effortless (clear PR description, complete test report, green CI).

## Ticket type

- **Epic** — never enters In Review and never produces a PR. It stays `In progress` until every delivery-parent child is `Done`; a Story, Task, or Issue delivery parent owns any bundled PR.
- **Story / Task / Issue with its own PR** — full flow below, one PR per ticket.
- **`nature:bundled-pr` child** — **never enters `In Review`**. Goes AI Testing → Done directly. The CLI rejects `update-status <ticket> "In review"` for these tickets.

## Action checklist

- [ ] **Create a ready PR** — title = ticket title; description = ticket link + change summary + test plan (copy from ticket) + created tests; link PR to ticket
- [ ] **Move ticket** to `In Review` via `workflow-cli.sh update-status`
- [ ] **Monitor CI** — on red: analyze logs, fix, commit, push, wait for green
- [ ] **Monitor the review** — answer questions, implement requested changes
- [ ] **Reviewer asks for extra tests** — create them, run locally, commit, push, wait for green CI, resolve conversation
- [ ] **Wait for approval + green CI** — do nothing until the developer merges

## Errors to avoid

- Asking the developer to merge with red CI
- Ignoring test failures in CI
- Merging yourself (unless explicitly instructed)
- Treating the review as a formality — in solo it replaces Human Testing; surface anything the reviewer should look at manually

## Guard

`workflow-cli.sh update-status <N> "In review"` exits non-zero when no open PR has a head branch matching `feature/<N>-…` or `fix/<N>-…`. Escape hatch (rare, e.g. a PR opened from a differently-named branch): `SF_WORKFLOW_BYPASS_PR_EXISTENCE_GUARD=1`.

> [!note] Convention sanity check
>
> This guard — and the `→ Done` PR-merged guard — only match when branches carry the ticket number, exactly the convention declared in `.saasfoundry.json` → `workflow.branchNaming` (`feature/{N}-{description}`, `fix/{N}-{description}`). The two must stay in lock-step. Quick check (should print `ok`): `echo "fix/32-detection-dropdown" | grep -Eq '^(feature|fix)/32(-|$)' && echo ok`. A branch missing the `{N}` ticket prefix (e.g. `fix/some-name`) silently fails the guard and forces `SF_WORKFLOW_BYPASS_*` on every ticket — realign `branchNaming`, never "fix" the regex. A non-regression test locks both sides together: `src/__tests__/unit/skill/branch-naming-pr-regex.spec.ts`.

If a draft already exists, use `workflow-cli.sh ready-pr <ticket>` before entering In Review. Draft-skipped CI checks do not count as validation.
