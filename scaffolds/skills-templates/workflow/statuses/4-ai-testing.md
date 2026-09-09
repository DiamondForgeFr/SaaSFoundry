---
status: AI Testing
banner_ai: Post the test plan, run automated + manual tests, fix on red, post the report
banner_human: Nothing yet — get ready to test manually (user-facing) or review the PR (internal)
complexity_profiles: [bug, low, medium, complex]
entry_conditions:
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
  - All automated tests pass, including the configured heavy local validation before Human Testing
  - Test plan fully executed and validated
  - Adversarial review complete (complex tickets only)
  - All Critical/High findings fixed
  - Code pushed
next_status: Human Testing (default) | In Review (nature:internal) | Done (nature:bundled-pr)
---

# STATUS: AI Testing

First automated validation + test plan execution.

Aggregate Epics never enter this status. They stay `In progress` while their delivery children pass through testing and review, then roll directly to `Done` after the last child reaches `Done`.

## Action checklist

- [ ] **Test plan** — post a comment covering: setup, nominal + edge scenarios, expected results per scenario, non-regression coverage
- [ ] **Move ticket** to `AI Testing` via `workflow-cli.sh update-status`
- [ ] **Automated tests:** `npm run build` → `npm run lint` → `npm run type-check` (if TS) → `npm run test:unit`
- [ ] **Heavy local validation** — run the project's configured build/integration suite before Human Testing (for example `npm run test:pre-push` when declared in `package.json`). Record command,
      commit and results. Repeat after relevant fixes; ordinary pushes do not rerun this suite.
- [ ] **Execute test plan** step by step — verify each scenario, document any failure
- [ ] **On failure** — document, fix, commit, push, restart from automated tests
- [ ] **Complex only:** `.claude/skills/sf-workflow/scripts/examine.sh <ticket>` — 3 parallel review agents (security / logic / perf). Fix Critical/High findings. If any fix committed, restart from
      automated tests.
- [ ] **Returning from review** — if human retesting is needed, use `workflow-cli.sh draft-pr <ticket>` before returning to Human Testing. `create-pr --draft` reuses a PR without changing its state.
- [ ] **On green** — post test report summary (include examine findings if complex), then transition:

  - `nature:user-facing` (or no `nature:*` label): open/reuse a draft with `workflow-cli.sh create-pr <ticket> --draft`, include test plan/results, then → **Human Testing**
  - `nature:internal`: open a ready PR with `workflow-cli.sh create-pr <ticket>` (or promote an existing draft with `ready-pr <ticket>`), then → **In Review** directly (skip Human Testing — see
    SKILL.md "Nature axis" section). The transition is enforced by the workflow guard.

  - `nature:bundled-pr`: → **Done** after validation; no individual draft or ready PR. The delivery parent owns the branch, PR, and human validation.

## Errors to avoid

- Moving to Human Testing with failing tests
- Skipping test plan steps
- Saying "it should work" — RUN the tests
- Skipping examine for complex tickets
- Ignoring Critical/High security findings
- Marking the parent Done while child tickets are still open or not yet Done (the Done gate is mandatory)
