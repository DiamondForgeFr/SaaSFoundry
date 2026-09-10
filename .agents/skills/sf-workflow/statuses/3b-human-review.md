---
status: Human Review (drafting lifecycle — board column stays "In progress")
banner_ai: Waiting — apply your review feedback to the draft pages
banner_human: Review the SRS pages and approve, or request changes on the ticket
complexity_profiles: [srs-drafting, srs-update, srs-new]
entry_conditions:
  - `3a-ai-drafting.md` complete — `srs-cli.sh draft` exited 0
  - Backend page URL posted as ticket comment
  - Ticket still carries its `srs:*` label
mandatory_actions:
  - Post the review checklist as a ticket comment
  - Iterate with the owner (re-draft rounds are allowed)
  - Do not touch the board column — it stays `In progress`
exit_conditions:
  - Owner signalled approval (comment `/approve` or team-specific convention)
  - Backend page reflects the final agreed scope
  - `srs:*` label still in place (cleared by spawning, not here)
next_status: Spawning (see `statuses/3c-spawning.md`)
---

# STATUS (drafting lifecycle): Human Review

Spec owner reviews the AI-drafted backend page, iterates until it reflects the team's intent, signals approval.

## Action checklist

- [ ] **Trigger the phase:** `.claude/skills/sf-workflow/workflow-cli.sh transition-drafting <ticket> human-review`
- [ ] **Post the review checklist** (template below) as a ticket comment
- [ ] **Iterate with the owner** — edit the page or request another `ai-draft` round; no round limit
- [ ] **Leave the board alone** — column stays `In progress`

## Review checklist template

```markdown
## Human review — SRS draft

**Backend page**: <paste URL from ai-draft phase>

Review checklist:

- [ ] Scope is aligned with the ticket intent
- [ ] Acceptance criteria are testable
- [ ] Dependencies & assumptions are explicit
- [ ] No sensitive data leaked into the page
- [ ] Links to parent Epic / related FRs are correct

Comment `/approve` (or apply the `srs:reviewed` label if your team uses it) when satisfied.
```

## Errors to avoid

- Skipping approval — spawning from an unreviewed spec forces mid-cycle reshapes
- Advancing to `spawning` just because `ai-draft` exited 0
- Removing the `srs:*` label to "force" progress (bypasses the guard, hides the lifecycle)
