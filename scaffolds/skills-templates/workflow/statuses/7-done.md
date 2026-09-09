---
status: Done
banner_ai: Cleanup: checkout workingBranch, rebase-pull, delete the feature branch, rebase other in-progress branches
banner_human: Nothing — cycle complete
complexity_profiles: [bug, low, medium, complex]
entry_conditions:
  - One of:
      - PR merged into the working branch (verified via `gh pr view <N> --json state` → `MERGED`) — standard path from `In Review`
      - AI Testing passed + ticket carries `nature:bundled-pr` (skip-In-Review path — no individual child PR is opened)
  - Tickets without a PR skip the merge check only when they are aggregate Epics or verified `nature:bundled-pr` children
mandatory_actions:
  - Run `github-projects-cli.sh list-incomplete-children <N>` and verify it returns `[]` before moving a parent to `Done`; every native child's project-board Status must be exactly `Done`
  - Move ticket to `Done`
  - Local branch cleanup — checkout working branch, rebase-pull, delete feature branch (skip for `nature:bundled-pr` children — they share the delivery parent's branch)
  - Rebase any other in-progress branches on the fresh working branch (after a real merge)
exit_conditions:
  - Ticket marked `Done`
  - Local feature branch deleted (where applicable)
  - Other in-progress branches rebased (where applicable)
next_status: N/A (end of cycle)
---

# STATUS: Done

Finalization and cleanup after merge.

## Ticket type

- **Epic** — `Done` is **derived** only when every delivery-parent child is already `Done`. Close the Epic issue once the last child reaches `Done`.
- **Story / Task / Issue with its own PR** — full cleanup flow below; merge happens at the ticket level.
- **`nature:bundled-pr` child** — no individual PR. Move directly to `Done` after AI Testing. Branch cleanup is owned by the delivery parent (the shared parent branch is deleted when its PR merges).

## Action checklist

- [ ] **Move ticket to Done** via `workflow-cli.sh update-status <ticket> Done`
- [ ] **Local cleanup** (working branch from `jq -r '.workflow.workingBranch' .saasfoundry.json`):
  - `git checkout <workingBranch>`
  - `git pull origin <workingBranch> --rebase`
  - `git branch -d <feature-branch>`
- [ ] **Rebase other in-progress branches** on the refreshed working branch:
  - per branch: `git checkout <other> && git rebase <workingBranch>` → resolve conflicts → `git push --force-with-lease`

## Where the release now stands

`update-status … Done` prints the milestone's progress by itself — you do not run anything. One API call, and only when the ticket belongs to a milestone.

It **reports**. The transition has already succeeded before this runs; no exit code is read and nothing here can undo it. A milestone never blocks a release, and it must not block a ticket either.

You will see it on a **change of state**, not on every close:

- a quarter crossed — `◆ « v1.0.0 » — 25/100 closed (25%), 75 still open.`
- the last ticket — `◆ « v1.0.0 » is complete — 49/49.` followed by the cut being named as the next step

Silence means the version moved inside the same quarter. That is deliberate: a note after every single close is how a signal becomes wallpaper.

When it says the release is complete, the next move is **not** to tag on the spot. Run `workflow-cli.sh milestone readiness "<name>"` for the full picture, and remember the tag stays a joint call with
the user.

## Errors to avoid

- Moving to Done before the actual merge — `update-status` requires a matching PR verified merged into the configured working branch. An open PR or no matching merged PR blocks Done; reviewer
  "validation" / approval is **not** a Done signal.
- Forgetting to rebase other in-progress branches

## Guard

`workflow-cli.sh update-status <N> Done` exits non-zero unless a matching PR is verified merged into the configured working branch. Aggregate Epics and verified bundled children are exempt because
they own no PR. Escape hatch: `SF_WORKFLOW_BYPASS_PR_MERGED_GUARD=1`.

> [!note] Convention sanity check
>
> This guard — and the `→ In Review` PR-existence guard — match branches by the ticket number, exactly the convention declared in `.saasfoundry.json` → `workflow.branchNaming`
> (`feature/{N}-{description}`, `fix/{N}-{description}`). The two must stay in lock-step. Quick check (should print `ok`):
> `echo "fix/32-detection-dropdown" | grep -Eq '^(feature|fix)/32(-|$)' && echo ok`. A branch missing the `{N}` ticket prefix (e.g. `fix/some-name`) cannot be verified as the ticket's PR — realign
> `branchNaming`, never "fix" the regex. A non-regression test locks both sides together: `src/__tests__/unit/skill/branch-naming-pr-regex.spec.ts`.
