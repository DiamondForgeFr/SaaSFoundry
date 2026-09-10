# Complexity System

Not every ticket deserves the same amount of process. A typo fix in a doc shouldn't require an adversarial security review; a payment integration shouldn't ship without one. The complexity system is
how SaaSFoundryAI scales ceremony to the actual risk of the change.

## The four levels

| Level          | Label   | Style            | When to use                                                   |
| -------------- | ------- | ---------------- | ------------------------------------------------------------- |
| 🐛 **bug**     | Bug fix | Direct fix       | Known defect, localised fix, regression test only             |
| 🟢 **low**     | Low     | Oneshot          | Typos, doc tweaks, small refactors, 1–3 files                 |
| 🟡 **medium**  | Medium  | Structured       | Standard features with multiple files and a clear scope       |
| 🔴 **complex** | Complex | Full adversarial | Auth, payments, security, concurrency, cross-cutting features |

**Higher complexity = more rigor**: deeper analysis, more exploration agents, more detailed plans, mandatory approval gates, adversarial review, stricter test coverage.

## How the tag is set

The complexity tag lives as a GitHub label (or equivalent on other tools): `complexity: bug`, `complexity: low`, `complexity: medium`, `complexity: complex`. It is **orthogonal** to the workflow
status — status lives on the project board, complexity lives on the ticket labels. The two never overlap.

The agent runs complexity detection when the ticket enters Backlog:

```bash
.claude/skills/sf-workflow/scripts/detect-complexity.sh <ticket>
```

Detection considers:

- Number of files potentially impacted
- Keywords in the description (auth / payment / security → complex)
- Risk assessment based on the affected modules
- Similar historical tickets

**The developer always has final say.** If detection suggests `medium` but the change touches the billing flow, the developer retags it to `complex`. If detection suggests `complex` but the change is
a pure copy tweak, the developer retags to `low`.

Retag anytime:

```bash
.claude/skills/sf-workflow/workflow-cli.sh retag <ticket> <new-complexity>
```

## Step-by-step mapping

Each complexity level enables or disables specific workflow steps:

### 🐛 Bug

| Step     | Behaviour                                   |
| -------- | ------------------------------------------- |
| Analyze  | Skipped — go directly to the bug location   |
| Plan     | Skipped — identify root cause, fix directly |
| Subtasks | Skipped — single fix, no decomposition      |
| Examine  | Skipped — no adversarial review             |
| Tests    | **Regression test mandatory** (always)      |

**Testing matrix:** unit ✓ · regression ✓ · E2E optional.

### 🟢 Low

| Step     | Behaviour                                           |
| -------- | --------------------------------------------------- |
| Analyze  | Minimal — 2–3 files, direct Glob/Grep, no subagents |
| Plan     | Minimal — mental plan, no formal doc, no approval   |
| Subtasks | Optional — auto-create if >3 files impacted         |
| Examine  | Skipped                                             |
| Tests    | Optional — inform the developer if skipped          |

**Testing matrix:** all optional.

### 🟡 Medium

| Step     | Behaviour                                                        |
| -------- | ---------------------------------------------------------------- |
| Analyze  | Standard — 2–4 parallel exploration agents                       |
| Plan     | Detailed file-by-file plan — **approval required** before coding |
| Subtasks | **Mandatory** — each major file change gets a subtask            |
| Examine  | Skipped                                                          |
| Tests    | Recommended — unit tests for logic, E2E for user workflows       |

**Testing matrix:** unit ✓ · E2E ✓ · regression ✓ (not strictly mandatory).

The required exploration agents are read-only and may share the active checkout. If implementation is split across independent writing streams, each writer needs a separate ticket, branch and worktree
with explicit file ownership. Coupled or overlapping implementation remains sequential in one feature worktree. The configured base branch comes from `workflow.workingBranch` in `.saasfoundry.json`.

### 🔴 Complex

| Step     | Behaviour                                                                   |
| -------- | --------------------------------------------------------------------------- |
| Analyze  | Deep — 6–10 parallel agents (explore-codebase × N, explore-docs, websearch) |
| Plan     | Comprehensive with dependencies — **approval required**                     |
| Subtasks | **Mandatory + granular**                                                    |
| Examine  | **Adversarial review** — security (OWASP Top 10), logic flaws, performance  |
| Tests    | **Mandatory** — comprehensive unit + E2E + regression, 80% coverage target  |

**Testing matrix:** unit ✓ · E2E ✓ · regression ✓ · coverage ≥ 80%.

## Adversarial review (complex only)

The Examine phase is what separates `complex` from every other level. After validation passes, three parallel review agents analyse the implementation:

- **Security agent** — OWASP Top 10, input validation, auth bypass, injection vectors.
- **Logic agent** — edge cases, race conditions, off-by-one, invariant violations.
- **Performance agent** — bottlenecks, N+1 queries, unbounded loops, memory hot-spots.

Findings are classified by severity (Critical / High / Medium / Low) and by confidence (Real vs False Positive). Critical and High findings must be fixed before the ticket moves to Human testing.
Medium and Low findings are documented in the ticket for future consideration.

Adversarial review agents are read-only and may share the implementation checkout. Any follow-up fixes are coordinated by the owning writer; reviewers do not write concurrently in that checkout.

## Quality preservation principle

The complexity system is **not about cutting corners on simple tickets** — it's about preserving full rigor where rigor matters. A `low` ticket gets oneshot-quality treatment (direct, minimal
exploration). A `complex` ticket gets apex-level treatment (deep analysis, adversarial review). Either way, the quality standard for that level is fully applied.

## Configuration files

Each complexity level is defined in a YAML file:

- `.claude/skills/sf-workflow/complexity/bug.yml`
- `.claude/skills/sf-workflow/complexity/low.yml`
- `.claude/skills/sf-workflow/complexity/medium.yml`
- `.claude/skills/sf-workflow/complexity/complex.yml`

Each file declares `steps.*` (enabled/disabled per phase), `testing.*` (unit/e2e/regression/coverage), and `aiInstructions` (narrative guidance the AI agent reads before executing the phase). Tune
these files to your team's appetite for ceremony — the workflow adapts automatically.

## Retagging mid-flight

If a ticket's complexity turns out to be different from the initial tag — for example, an exploration reveals a security concern nobody anticipated — retag it:

```bash
/workflow retag 42 complex
```

The workflow adjusts remaining steps to match the new complexity level. Any earlier phases that would have been gated (e.g. adversarial review) are inserted into the remaining plan.
