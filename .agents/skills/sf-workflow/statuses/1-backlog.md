---
status: Backlog
banner_ai: Detect + persist the complexity label, analyze and plan per complexity, challenge the specs
banner_human: Validate specs + plan (→ Ready), then confirm pickup priority (→ In progress)
complexity_profiles: [bug, low, medium, complex]
entry_conditions:
  - Developer mentions a new idea / feature / bug
  - No branch created, no code written
mandatory_actions:
  - Read the ticket thoroughly
  - Detect complexity — suggestion only
  - Persist complexity label — MANDATORY (update-status is hard-gated on it)
  - Analyze (adaptive — skip=bug, minimal=low, 2–4 agents=medium, 6–10 agents=complex)
  - Plan (adaptive — skip=bug, mental=low, file-by-file=medium, comprehensive=complex)
  - Challenge the specs (edge cases, questions, alternatives)
  - Wait for developer validation
exit_conditions:
  - Complexity label present — `get-complexity <ticket>` prints one of `bug|low|medium|complex` (not `(none)`)
  - Analysis complete (if required by complexity)
  - Plan approved (if required by complexity)
  - Developer validates specs are complete
next_status: Ready
---

# STATUS: Backlog

Preparation phase — detect complexity, analyze context, plan implementation, validate specs.

## Action checklist

- [ ] **Detect complexity (suggestion):** `.claude/skills/sf-workflow/scripts/detect-complexity.sh <ticket>`
- [ ] **Persist the label (mandatory):** `.claude/skills/sf-workflow/workflow-cli.sh retag <ticket> <bug|low|medium|complex>`
- [ ] **Analyze:** `.claude/skills/sf-workflow/scripts/analyze.sh <ticket> <complexity>` — follow its guidance
- [ ] **Plan:** `.claude/skills/sf-workflow/scripts/plan.sh <ticket> <complexity>` — follow its guidance; post + await approval for medium/complex
- [ ] **Challenge the specs** — ask questions, surface edge cases, propose alternatives
- [ ] **Ticket completeness** — problem/need, acceptance criteria, technical context, complexity tag
- [ ] **Wait for validation** — two approvals: (1) specs complete → Ready, (2) prioritization → In Progress

## Complexity cheat sheet

| Level      | Analyze     | Plan                     |
| ---------- | ----------- | ------------------------ |
| 🐛 bug     | skip        | skip                     |
| 🟢 low     | minimal     | mental                   |
| 🟡 medium  | 2–4 agents  | file-by-file + approval  |
| 🔴 complex | 6–10 agents | comprehensive + approval |

## Errors to avoid

- Creating a branch from Backlog
- Starting to code before Ready
- Skipping complexity detection
- Leaving Backlog without the `complexity: *` label (suggestion ≠ label; hard-gated)
- Skipping analysis/planning when required
- Moving to Ready without developer validation
