---
status: AI Drafting (drafting lifecycle — board column stays "In progress")
banner_ai: Run the drafter against the configured SRS backend and post the draft page links on the ticket
banner_human: Wait for the draft — your review comes next (human-review phase)
complexity_profiles: [srs-drafting, srs-update, srs-new]
entry_conditions:
  - Ticket board status is `In progress`
  - Ticket carries exactly one `srs:*` label (`srs:drafting | srs:update | srs:new`)
  - Brainstorm phase complete — ticket body is sharp enough to draft
mandatory_actions:
  - Run the drafter via `transition-drafting <ticket> ai-draft`
  - Post the backend page URL as a ticket comment
  - Do not touch the board column — it stays `In progress`
exit_conditions:
  - `srs-cli.sh draft` exited 0
  - Backend page URL posted as ticket comment
  - No backend error left unresolved
next_status: Human review (see `statuses/3b-human-review.md`)
---

# STATUS (drafting lifecycle): AI Drafting

AI produces the first draft of the SRS page in the configured backend (Notion, Confluence, local markdown, …).

## Action checklist

- [ ] **Run the drafter:** `.claude/skills/sf-workflow/workflow-cli.sh transition-drafting <ticket> ai-draft`
  - dispatches to `.claude/skills/sf-srs/scripts/srs-cli.sh draft --ticket <ticket>`
  - reads `tools.srs.backend`, resolves the `SrsAdapter`, writes via `createEpicPage` / `createFrPage`
- [ ] **Post the page URL** as a ticket comment so the reviewer can jump without leaving the board
- [ ] **Leave the board** — column stays `In progress` until the lifecycle closes with `transition-drafting done`

## Errors to avoid

- Hand-drafting the spec (always go through the skill CLI — the backend adapter is the single integration point)
- Moving the ticket to `AI testing` — code-path statuses are blocked by the SRS guard
- Bypassing `srs-cli.sh draft` with direct backend SDK calls
- Deleting the `srs:*` label before `spawning` succeeds — the label keeps the ticket in the drafting lifecycle
