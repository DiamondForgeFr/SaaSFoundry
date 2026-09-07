# Workflow {{WORKFLOW_NAME}}

Complexity-adaptive development workflow with {{TOOL}} (GitHub Projects, Jira, Notion, Linear, etc.)

## Auto-trigger keywords
workflow status, check workflow, what should i do, next step, workflow help, current status, complexity, detect complexity

## 🎯 Complexity-Based Adaptive Workflow

This workflow adapts its rigor based on ticket complexity:

| Level | Label | Process | Use Case |
|-------|-------|---------|----------|
| **bug** | 🐛 Bug Fix | Direct fix, regression test | Quick bug fixes |
| **low** | 🟢 Low | Oneshot-style (minimal ceremony) | Simple tasks |
| **medium** | 🟡 Medium | Apex-free-style (structured) | Standard features |
| **complex** | 🔴 Complex | Full Apex (adversarial review) | Critical features |

**Key principle:** Higher complexity = more rigor (analysis depth, planning detail, adversarial review, test coverage)

## 🎚️ Nature axis (user-facing / internal / bundled-pr)

Orthogonal to complexity. Controls whether **Human Testing** and **In Review** are mandatory or optional in the lifecycle.

| Label | Use case | Workflow effect |
| --- | --- | --- |
| `nature:user-facing` | Bug fix or feature with visible UX impact — anything a user can click, see, or feel | Mandatory `AI Testing → Human Testing → In Review → Done` |
| `nature:internal` | Refactor, scaffolding, internal tooling, doc-only change — ships its own PR | Optional `AI Testing → In Review → Done` (skip Human Testing) |
| `nature:bundled-pr` | Sub-Story of a multi-step Epic whose merge happens via the **Epic's single bundled PR** — there is no individual PR to open at this Sub's level | `AI Testing → Done` (skip Human Testing **and** In Review — PR is at the parent Epic) |

**Default** — if a ticket has no `nature:*` label, the workflow treats it as `user-facing` (safe default).

**Why this exists** — Human Testing is theatrical on tickets with no user-visible surface (the existing tests + lint + typecheck already cover the integration risk). And `In Review` on a Sub whose PR is bundled at the parent Epic is a board lie: there is no PR to review at this Sub level — the merge happens once at the end of the Epic. For those Subs we go AI Testing → Done directly, and the Epic's own ticket carries the In Review / merge ceremony.

**Epic-level Human Testing** — when an Epic is composed entirely of `nature:internal` (or `nature:bundled-pr`) children, the meaningful manual validation happens at **Epic completion** (e.g. an integration test on the freshly merged target branch), not on each child. Tag the Epic itself `nature:user-facing` so its own AI Testing → In Review transition still requires that integration check.

**Guards** (all enforced by `update-status`):

- **Nature guard** on `→ In Review` from `AI Testing` — requires `nature:internal`. `nature:bundled-pr` is rejected here (must go to `Done` instead). Default (no label / `user-facing`) must go through Human Testing first. Escape hatch: `SF_WORKFLOW_BYPASS_NATURE_GUARD=1`.
- **PR-state guard** — `→ Human Testing` requires an open draft PR; `→ In Review` requires an open non-draft PR. Unknown PR state blocks these transitions. Epic groupers without a PR keep their derived lifecycle. Escape hatch: `SF_WORKFLOW_BYPASS_PR_EXISTENCE_GUARD=1`.
- **Nature guard** on `→ Done` from `AI Testing` — allowed **only** for `nature:bundled-pr` (everyone else must go through `In Review` first). Escape hatch: `SF_WORKFLOW_BYPASS_NATURE_GUARD=1`.
- **PR-merged guard** on `→ Done` — rejected when an open PR still exists for the ticket (`Done` means merged). Does not fire on `nature:bundled-pr` (no PR is expected). Escape hatch: `SF_WORKFLOW_BYPASS_PR_MERGED_GUARD=1`.

## 🧩 Ticket Hierarchy (Epic / Story-Task / Subtask)

{{WORKFLOW_NAME}} uses a **three-level ticket hierarchy** — Epics produce **no PR**, Subtasks are **not {{TOOL}} issues**.

```
(Epic)          optional grouper
 └─ Story|Task  mandatory — branch + PR + full workflow
     └─ Subtask optional — commit on the Story/Task branch
```

| Level | Role | Deliverable | Tracking artifact | Status |
| --- | --- | --- | --- | --- |
| **Epic** | Grouper for related Stories/Tasks (SRS feature, bug batch, transverse refactor) | **None directly** — no branch, no commit, no PR | Ticket, labeled `type: epic`, with child Story/Task tickets linked as sub-issues | **Derived from children** (see rule below) |
| **Story** | Delivers user-observable value | Branch + commits + PR | Regular ticket, `story.tpl.ts` body — Acceptance Criteria section | Explicit, full workflow lifecycle |
| **Task** | Delivers a technical action | Branch + commits + PR | Regular ticket, `task.tpl.ts` body — Completion Criteria section | Explicit, full workflow lifecycle |
| **Issue (bug)** | Task variant for defects | Branch + commits + PR | Regular ticket, `issue.tpl.ts` body — Behavior/Expected/Repro/Environment/Impact/Evidence | Explicit, full workflow lifecycle |
| **Subtask** | Step in the action plan of a Story/Task | A single commit (atomically revertible) | **Never** a ticket, **never** a branch, **never** a PR | — (commit lands on parent branch) |

**⚠️ Naming warning** — the `create-subtask` CLI misnames its output: it creates **Story tickets**, not true Subtasks. True Subtasks are commits and are not tracked on the board.

### Epic status derivation rule

An Epic's board status is **computed from its children**, never set directly.

| Direction | Rule | Intuition |
| --- | --- | --- |
| **Ascent** (Backlog → … → In progress) | Epic = **earliest** status among children | As soon as one child advances, the Epic moves with it |
| **Descent** (In progress → … → Done) | Epic = **latest** status among children | The Epic reaches a later stage only when **all** children have reached it |

**Consequence** — an Epic at `Done` is a strong contract: every child is merged. Example: children at `{In progress, Ready, Backlog}` ⇒ Epic = `Ready` (earliest). Children at `{Done, In review, In review}` ⇒ Epic = `In review` (latest).

## How to use this skill

**FIRST TIME on a ticket:**
1. **Detect complexity:** `/workflow detect-complexity <ticket-number>`
2. **Confirm with developer:** AI suggests, developer decides
3. **Follow adaptive process:** Each status adapts to complexity level

**BEFORE EVERY ACTION:**
1. Invoke this skill with `/workflow status <ticket-number>`
2. Read the COMPLETE description of the current status
3. Follow EXACTLY the instructions from that description
4. Never guess - if uncertain, run `/workflow status` again

## Configuration (Source of Truth)

All workflow configuration lives in **`.saasfoundry.json`** at the project root. See [manifest schema](../../docs/manifest-schema.md) for the full field list and read snippets. **Never hardcode branch names** — always read from the manifest.

## Output language

Ticket titles, bodies, comments, commit messages and code comments follow **`language.tickets` / `language.codeComments`** in `.saasfoundry.json`, which default to English.

```bash
jq -r '.language.tickets      // "en"' .saasfoundry.json
jq -r '.language.codeComments // "en"' .saasfoundry.json
```

**The language of the conversation is not the signal.** A session held in French still produces English tickets and English commit messages when the project says `en`. Only change language when the
manifest says so.

## Available Commands

### Workflow Status Commands

**`/workflow status <ticket>`**
Displays the current status of the ticket and loads the complete description of that status.

**`/workflow next <ticket>`**
Indicates the next status and what needs to be done to get there.

**`/workflow validate <ticket>`**
Checks if all conditions are met to move to the next status.

**`/workflow help`**
Displays the list of statuses and their role.

### Complexity Commands (NEW)

**`/workflow detect-complexity <ticket>`**
Auto-suggests complexity level based on:
- Number of files potentially impacted
- Keywords (auth, payment, security → complex)
- Risk assessment
- Historical patterns

Developer always has final say.

**`/workflow retag <ticket> <new-complexity>`**
Changes ticket complexity level (bug | low | medium | complex).
Adjusts remaining workflow steps to match new complexity.

**Guard** — `update-status <ticket> <target>` is rejected for any target other than `Backlog` if the ticket has no `complexity: *` label. `detect-complexity` only suggests — you must call `retag` to persist. The guard fails open if label fetch errors (offline / auth issues). Escape hatch: `SF_WORKFLOW_BYPASS_COMPLEXITY_GUARD=1` (rare).

### Workflow Phase Commands (Complexity-Adaptive)

**`/workflow prepare <ticket> <complexity>`** — adaptive analyze + plan phase (Backlog → Ready).
**`/workflow test <ticket> [complexity]`** — validation + optional adversarial review (→ AI Testing).

| Complexity | `prepare` behavior | `test` behavior |
| --- | --- | --- |
| **bug** | Skip — direct to implementation | Validation only (build, lint, typecheck, unit tests) |
| **low** | Minimal — 2–3 files, mental plan | Validation only |
| **medium** | Standard — 2–4 agents, detailed plan + approval | Validation only |
| **complex** | Deep — 6–10 agents, comprehensive plan + approval | Validation **+ adversarial review** (security, logic, performance) |

## Tool-Specific Commands

Workflow commands that interact with your project management tool (GitHub Projects, Jira, Notion, Linear) are delegated to tool-specific CLIs.

The workflow skill automatically routes commands to the appropriate tool based on your `.saasfoundry.json` configuration.

**Example:** Creating a subtask
```bash
# This command is automatically routed to the correct tool
.claude/skills/sf-workflow/workflow-cli.sh create-subtask <parent> <title>
```

See your tool-specific skill documentation for complete command reference:
- GitHub Projects: `.claude/skills/sf-tool-github-projects/SKILL.md`
- Jira: `.claude/skills/sf-tool-jira/SKILL.md`
- Notion: `.claude/skills/sf-tool-notion/SKILL.md`
- Linear: `.claude/skills/sf-tool-linear/SKILL.md`

## SRS Handoff (drafting / spawning tickets)

When a ticket crosses into **Ready** and requires Software Requirements Specifications (US / UR / FR / DS / TC),
stop and hand off to the agnostic SRS skill:

- `.claude/skills/sf-srs/SKILL.md` — selects the configured SRS backend from `.saasfoundry.json → tools.srs.backend`
- `.claude/skills/sf-srs/scripts/srs-cli.sh validate` — smoke-tests the backend adapter (init OK, exit 0)
- `.claude/skills/sf-srs/scripts/srs-cli.sh draft|spawn|eval` — backend-neutral actions (sibling SUBs under #174 fill the body)

Never bypass the skill to write SRS by hand — the backend dispatch is how new projects get to swap Notion for
Confluence / local markdown without touching the workflow logic.

### Drafting lifecycle (tickets labelled `srs:drafting | srs:update | srs:new`)

SRS tickets don't flow through the code-path statuses — they have their own lifecycle inside the `In progress` board column:

```
Ready → In progress (brainstorm)
         → ai-draft        (srs-cli.sh draft)
         → human-review    (owner reviews the backend page)
         → spawning        (srs-cli.sh spawn — creates Backlog children)
         → done            (board status → Done)
```

Drive it with:

```bash
.claude/skills/sf-workflow/workflow-cli.sh transition-drafting <ticket> <phase>
# phase: ai-draft | human-review | spawning | done
```

Each phase is documented in detail:
- `statuses/3a-ai-drafting.md` — AI drafter runs against the configured backend
- `statuses/3b-human-review.md` — spec owner reviews and approves
- `statuses/3c-spawning.md` — children land in Backlog, drafting ticket closes

**Guard** — `update-status <ticket> <any testing/review status>` is rejected when the ticket carries an `srs:*` label. Use `transition-drafting` instead. The guard fails open if label fetch errors (offline / auth issues) so normal teams are not punished by infrastructure hiccups.

### Rule 8 — spawning Stories from SRS

Once an Epic page tree is drafted (Main spec + FR-001…FR-N children), the Story sub-tickets under the parent must be created by the spawner, not by hand:

```bash
.claude/skills/sf-srs/scripts/srs-cli.sh spawn --ticket <parent> --epic <page-url-or-id>
```

The spawner enumerates FR pages, renders each Story body from `renderStoryTicketBody`, and invokes `workflow-cli.sh create-subtask` with `--bypass-srs spawned-from-srs`. Children land as regular sub-issues under the parent ticket (no `srs:*` label — they flow through the normal code-path workflow). Use `--dry-run` to preview without writing.

On SRS-enabled projects (`tools.srs.backend` is set), `create-subtask` refuses calls without `--bypass-srs <reason>` and exits 2. The escape hatch is legitimate only for:

- Meta tickets that don't map to an FR page (SRS tooling, drafter refactors, eval polish)
- Bootstrapping an Epic's own SUBs during rollout before the page tree exists

Typing the reason is the audit trail — pick something a reviewer can grep for (`spawned-from-srs`, `meta-srs-tooling`, `bootstrap-epic-174`…). If the ticket represents a feature requirement, the answer is always "go draft it first, then spawn."

### Conversational eval hook (SRS-enabled projects)

When `tools.srs.enabled = true`, Claude must interject during conversation turns whose content looks like a new User Requirement / Functional Requirement / Design decision / Test Case, propose a diff, and on user accept apply it via `.claude/skills/sf-srs/scripts/srs-cli.sh apply-update`. The detection heuristics, confirmation flow, and scope limits (ADD-only in v1) live in the sf-srs SKILL.md — see its `## Conversational eval hook (SUB-10)` section. This skill only references it ; never duplicate the heuristics here.

## Draft PR lifecycle

After AI validation (including the configured heavy local suite), use `workflow-cli.sh create-pr <ticket> --draft` before Human Testing. Keep the test plan and results on that PR. After developer approval and required non-regression tests, push then use `workflow-cli.sh ready-pr <ticket>` before In Review. Creation retries reuse the existing PR without changing its draft state. Use `draft-pr <ticket>` explicitly when returning a ready PR to human retesting. Internal/solo routes may create a ready PR directly.

With the updated CI policy, draft PRs skip test/build CI. When adopting these skills in an existing project, inspect its checked-in workflows and hooks: refreshing instructions alone does not update external CI configuration or remove custom push hooks. Readiness and subsequent ready-PR pushes run full CI; returning to draft cancels obsolete runs. Quick commit checks remain enabled; heavy local validation belongs to AI Testing instead of every push.

## Workflow Statuses

{{STATUSES_LIST}}

**⚠️ This skill is your SOURCE OF TRUTH for the workflow.**

## Critical Rules

1. **ALWAYS read the status description** before taking any action
2. **NEVER skip steps** described in a status
3. **NEVER move to the next status** without meeting all exit conditions
4. **ASK if uncertain** - don't assume or guess
5. **CLOSE CHILD TICKETS AS THEY LAND** — after a child Story/Task/Issue's final commit is merged, immediately run `workflow-cli.sh update-status <child> Done` and verify `gh issue view <child> --json state` prints `CLOSED` before starting the next sibling. Never batch closures at the end of an Epic. (A true Subtask is a commit, not a {{TOOL}} issue — there is no status to close.)
6. **EPIC STATUS FOLLOWS CHILDREN** — an Epic's board status is derived from its children (earliest for ascent Backlog→In progress, latest for descent In progress→Done — see "Epic status derivation rule" above). Before advancing an Epic, run `gh issue list --state open --search "parent #<N>"` and confirm the target status is consistent with all children. An Epic can only reach `Done` when every child is `Done`.
7. **FINISH THE CURRENT TICKET BEFORE STARTING ANOTHER** — if a ticket sits in any status between `In Progress` and `Done` (see the Workflow Statuses section above), drive it to `Done` before claiming or starting another. The only override is an explicit developer request to pause.
8. **TICKETS FROM SRS** — when `tools.srs.backend` is set in `.saasfoundry.json`, Story sub-tickets under an SRS Epic must be spawned from the canonical FR pages, not hand-written. Use `.claude/skills/sf-srs/scripts/srs-cli.sh spawn --ticket <parent> --epic <page-url-or-id>` to create one child issue per FR page, each body rendered from `renderStoryTicketBody`. The `create-subtask` command rejects any call without `--bypass-srs <reason>` on SRS-enabled projects — see the "SRS Handoff" section above. The escape hatch exists for meta tickets (SRS refactors, tooling) but must never be used to duplicate an FR that already has a page.

9. **ANNOUNCE + STREAM LONG COMMANDS** — before any command expected to take more than ~5 seconds (test suites, builds, commit/push hooks, Docker scenarios), announce in one sentence what runs and the expected duration. Over ~60 seconds, run it in the background and stream its progress markers to the user as they appear (e.g. `tail -f <log> | grep -E --line-buffered "PASS|FAIL|\[sf-progress\]"`) — never block silently. Report the outcome with numbers, and relay the ▶ AI / ⏳ Dev banner printed by `update-status` after every transition.

## Implementation

The status descriptions are in the `statuses/` directory:
- Each status has its own markdown file
- Descriptions include: when to enter, mandatory actions, exit conditions, next status
- The CLI script (`workflow-cli.sh`) queries the project management tool and displays the appropriate description

## Where this sits in the zero-to-project flow

This skill carries **phases 5 to 7 — *create the tickets*, *base setup*, then *features*** of the flow a user walks when they arrive with a POC and no project. The map — every phase, its entry, its checkable exit, and how to resume mid-way — lives in the
`tool-saasfoundry` skill under "The zero-to-project flow".

It starts from an SRS carrying FRs and a configured board, and the first ticket moving past Backlog is what marks the base setup underway.

On a resumed session, run `tool-saasfoundry`'s `scripts/recap.sh` before assuming anything: it reads the phase from the manifest and the board, never from chat history.

### Milestones

A release scope is defined in this layer and projected per tool — `workflow-cli.sh milestone create|list|show|scope|assign|associate`. GitHub has native milestones, Jira fix versions, Linear cycles; the concept does not belong to any of them.

A version is **associated** to a release, never equal to it: one milestone per release, and several SRS version pages may point at it. The association travels with the milestone in the tool that holds it, not in `.saasfoundry.json`.

**A milestone reports; it never blocks a release.** It states where the scope stands and asks for an acknowledgement to continue on an incomplete one — it does not refuse. See Epic #542.

The `tool-saasfoundry` skill carries the Milestone Guardrail: when to raise the subject, and how to propose a scope from evidence rather than from a guess.
