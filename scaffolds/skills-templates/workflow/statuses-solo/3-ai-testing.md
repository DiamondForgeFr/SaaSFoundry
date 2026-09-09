---
status: AI Testing
banner_ai: Post the test plan, run automated + manual tests, fix on red, post the report, open the PR
banner_human: Nothing yet — get ready to review the PR (your review is the validation gate)
complexity_profiles: [bug, low, medium, complex]
entry_conditions:
  - All child tickets completed in In Progress
  - Code pushed and ready for testing
mandatory_actions:
  - Generate test plan and post as ticket comment
  - Move ticket to `AI Testing`
  - Run automated tests (build, lint, type-check, unit tests)
  - Execute the test plan manually (nominal + edge cases)
  - Adversarial review — only for complexity `complex` (`examine.sh`)
  - If problems found — fix, commit, push, restart from automated tests
  - Post test report summary as comment when all green
exit_conditions:
  - All automated tests pass
  - Test plan fully executed and validated
  - Adversarial review complete (complex tickets only)
  - All Critical/High findings fixed
  - Code pushed
next_status: In Review (create PR) | Done (nature:bundled-pr Subs only)
---

# STATUS: AI Testing

Automated validation + test plan execution. In the solo workflow this is the only testing status — the developer validates during PR review, so the test report must give them everything they need to review efficiently.

Aggregate Epics never enter this status. They stay `In progress` while their delivery children pass through testing
and review, then roll directly to `Done` after the last child reaches `Done`.

## Action checklist

- [ ] **Test plan** — post a comment covering: setup, nominal + edge scenarios, expected results per scenario, non-regression coverage
- [ ] **Move ticket** to `AI Testing` via `workflow-cli.sh update-status`
- [ ] **Automated tests:** `npm run build` → `npm run lint` → `npm run type-check` (if TS) → `npm run test:unit`
- [ ] **Execute test plan** step by step — verify each scenario, document any failure
- [ ] **On failure** — document, fix, commit, push, restart from automated tests
- [ ] **Complex only:** `.claude/skills/sf-workflow/scripts/examine.sh <ticket>` — 3 parallel review agents (security / logic / perf). Fix Critical/High findings. If any fix committed, restart from
      automated tests.
- [ ] **On green** — post the test report summary (include examine findings if complex), then:
  - default: create the PR and move to **In Review**
  - `nature:bundled-pr` children: move to **Done** directly (no individual PR — the delivery parent owns the branch and PR)

## Errors to avoid

- Moving to In Review with failing tests
- Skipping test plan steps
- Saying "it should work" — RUN the tests
- Skipping examine for complex tickets
- Ignoring Critical/High security findings
- Opening the PR before the test report is posted — the report is the reviewer's map
