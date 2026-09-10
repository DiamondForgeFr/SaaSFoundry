# Complexity-Based Adaptive Workflow

This directory contains complexity configurations that adapt the workflow process based on ticket complexity.

## Complexity Levels

| Level       | Label      | Style      | Use Case                               |
| ----------- | ---------- | ---------- | -------------------------------------- |
| **bug**     | 🐛 Bug Fix | Direct fix | Quick bug fixes, minimal ceremony      |
| **low**     | 🟢 Low     | Oneshot    | Simple tasks, fast iteration           |
| **medium**  | 🟡 Medium  | Apex-free  | Standard features, structured approach |
| **complex** | 🔴 Complex | Full Apex  | Critical features, adversarial review  |

## How It Works

### 1. Complexity Detection

When a ticket enters Backlog, the AI suggests a complexity level based on:

- Number of files potentially impacted
- Keywords in description (auth, payment, security → complex)
- Risk assessment
- Historical similar tickets

**Developer always has final say on complexity tag.**

### 2. Adaptive Steps

Each complexity level enables/disables workflow steps:

#### Bug (🐛)

- Skip: Backlog (direct to In Progress)
- Skip: Analyze, Plan
- Execute: Direct fix
- Validate: Build + lint + regression test
- Skip: Examine
- Tests: Regression test only

#### Low (🟢)

- Analyze: Minimal (2-3 files, no agents)
- Plan: Mental plan only
- Execute: Direct implementation
- Validate: Lint + typecheck
- Skip: Examine
- Tests: Optional

#### Medium (🟡)

- Analyze: Standard (2-4 agents)
- Plan: Detailed file-by-file (requires approval)
- Execute: Subtasks mandatory
- Validate: Build + lint + typecheck + unit tests
- Skip: Examine
- Tests: Unit + E2E recommended

#### Complex (🔴)

- Analyze: Deep (6-10 agents)
- Plan: Comprehensive with dependencies (requires approval)
- Execute: Granular subtasks mandatory
- Validate: Full test suite
- **Examine: Adversarial review (security, logic, performance)**
- Tests: Unit + E2E + regression mandatory (80% coverage)

### 3. Configuration Format

Each `.yml` file contains:

```yaml
name: complexity-level
label: "Display label"
description: "Description"

skipStatuses: []  # Which statuses can be skipped

steps:
  analyze:
    enabled: boolean
    depth: "minimal" | "standard" | "deep"
    agents: number  # 0-10
  plan:
    enabled: boolean
    depth: "minimal" | "detailed" | "comprehensive"
    approval: boolean
  subtasks:
    enabled: boolean
    mandatory: boolean
  examine:
    enabled: boolean
  tests:
    type: "optional" | "recommended" | "mandatory"
    mandatory: boolean

testing:
  unit: boolean
  e2e: boolean
  regression: boolean
  coverage: number | null

aiInstructions: |
  Guidance for AI on how to approach this complexity level
```

## Changing Complexity

If a ticket's complexity changes during development:

```bash
/workflow retag {ticket-number} {new-complexity}
```

This adjusts remaining steps to match the new complexity level.

## Quality Preservation

- **Bug**: Fast triage, regression test
- **Low**: Oneshot quality (minimal exploration, direct fix)
- **Medium**: Apex-free quality (structured, no adversarial review)
- **Complex**: Full Apex quality (deep analysis, adversarial review, comprehensive testing)
