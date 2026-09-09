---
status: Human Testing
banner_ai: Waiting — supporting reproduction and fixing whatever you report
banner_human: Execute the manual test plan and report pass/fail on the ticket
complexity_profiles: [bug, low, medium, complex]
entry_conditions:
  - All AI Testing steps passed
  - Test plan ready for human validation
  - An open draft PR exists for the ticket, containing the test plan and AI test results
mandatory_actions:
  - Wait for developer validation
  - On bug report — fix, commit, push, return to AI Testing
  - On approval — create non-regression tests (E2E for complex/critical, unit for edge-case bugs; none for typo/doc/CSS)
  - Run created tests locally and ensure they pass
  - Commit and push tests (`test(#<N>): <description>`)
  - Be transparent when tests are intentionally skipped
exit_conditions:
  - Developer validated the feature
  - Non-regression tests created (when applicable)
  - Tests pass locally
  - Code with tests pushed
next_status: In Review (promote the existing draft PR)
---

# STATUS: Human Testing

Manual validation in a draft PR, followed by non-regression test creation and explicit promotion to review. Draft PR events skip test/build CI; a skipped check is not proof that tests passed.

## Applicability

This status is **mandatory for `nature:user-facing` tickets** (or any ticket without a `nature:*` label — safe default). It is **skipped for `nature:internal` tickets**, which transition AI Testing →
In Review directly. See SKILL.md "Nature axis" section.

## Ticket type

- **Epic** — never enters Human Testing. It has no manual test or PR and stays `In progress` until every delivery-parent child is `Done`.
- **Story / Task / Issue** — full flow below.

## Action checklist

- [ ] **Draft PR** — reuse the PR opened at the end of AI Testing via `workflow-cli.sh create-pr <ticket> --draft`; keep its description, test plan and results current. Do not promote it before
      developer approval.
- [ ] **Wait for validation** — developer tests manually, you stay available to answer
- [ ] **On bugs reported:**
  - Read the comments carefully, summarize the fix plan as a reply
  - Fix, commit, push, then return to **AI Testing** (re-run automated tests)
- [ ] **On approval** — create non-regression tests:
  - Complex/critical → E2E tests (Playwright)
  - Edge-case bug fix → unit non-regression test
  - Typo/doc/CSS refactor → none (state why in a comment)
- [ ] **Coverage** — main scenarios validated, edge cases identified, critical workflows
- [ ] **Verify locally** — `npm run test:e2e` (or relevant runner) must be green
- [ ] **Commit + push** — `test(#<N>): add E2E tests for <feature>` (pattern from `jq -r '.workflow.commitFormat.pattern' .saasfoundry.json`)
- [ ] **Promote after tests are pushed** — `workflow-cli.sh ready-pr <ticket>`, then move to `In review`. The `ready_for_review` event starts full CI. When the configured GitHub review listener and
      `SF_PROJECTS_TOKEN` are installed on the default branch, clicking **Ready for review** also moves the ticket to In review; otherwise run the guarded status transition manually.

## Errors to avoid

- Creating tests BEFORE developer validation
- Marking the draft PR ready before developer approval and the required non-regression coverage
- Pushing failing tests
