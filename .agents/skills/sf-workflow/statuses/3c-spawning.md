---
status: Spawning (drafting lifecycle — board column stays "In progress" → "Done" on transition-drafting done)
banner_ai: Spawn child tickets from the approved FR pages, then close the drafting ticket
banner_human: Nothing — children land in Backlog for later prioritization
complexity_profiles: [srs-drafting, srs-update, srs-new]
entry_conditions:
  - `3b-human-review.md` complete — owner approval signalled
  - Backend page is stable
  - Ticket still carries its `srs:*` label
mandatory_actions:
  - Run the spawner via `transition-drafting <ticket> spawning`
  - Verify children (titles, empty complexity tags, back-links to the backend page)
  - Clear the `srs:*` label on the drafting ticket
  - Close the drafting ticket via `transition-drafting <ticket> done`
exit_conditions:
  - `srs-cli.sh spawn` exited 0
  - All children exist in Backlog with correct titles and bodies
  - Parent drafting ticket no longer carries the `srs:*` label
  - Parent ticket board status is `Done`
next_status: Done — children follow the normal code-path workflow from Backlog
---

# STATUS (drafting lifecycle): Spawning

Turn the approved SRS page into the matching tickets that will drive implementation.

## Action checklist

- [ ] **Run the spawner:** `.claude/skills/sf-workflow/workflow-cli.sh transition-drafting <ticket> spawning`
  - dispatches to `.claude/skills/sf-srs/scripts/srs-cli.sh spawn --ticket <ticket>`
  - renders ticket templates from `sf-srs/templates/tickets/` (Epic or Story)
  - creates children on the configured workflow tool — each lands in **Backlog**, no `srs:*` label
- [ ] **Verify the children:** `github-projects-cli.sh list-incomplete-children <ticket>` — every newly spawned child must appear with its title and Backlog status; then inspect its backend-page link
- [ ] **Clear the SRS label:** once children exist, remove the `srs:*` label (the `done` phase handles this if the adapter supports it; otherwise `gh issue edit <ticket> --remove-label srs:drafting`)
- [ ] **Close the drafting ticket:** `.claude/skills/sf-workflow/workflow-cli.sh transition-drafting <ticket> done` — internally calls `update-status <ticket> Done` with
      `SF_WORKFLOW_BYPASS_SRS_GUARD=1`

## Errors to avoid

- Spawning before approval
- Editing children to paste code-path statuses — leave them in `Backlog`, the team sequences them normally
- Closing the drafting ticket by hand with `update-status <ticket> Done` bypassing the CLI — the guard must stay informative
