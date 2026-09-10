# SaaSFoundry agent instructions

Read `CLAUDE.md` in this project before working: it remains the authoritative project
instructions during this additive compatibility phase. Read files that it references as well.
This preserves the existing project rules and developer customizations without duplicating them.
Do not rewrite paths to `.claude/`: the existing guarded scripts and docs remain there.

Read `.saasfoundry.json` and run `sf status --claude-friendly --no-network` before
asking about configured scope, tools or modules. Follow its output language and workflow.
Discover shared skills under `.agents/skills/sf-*/SKILL.md`. Before a status transition,
read the matching status document and execute the existing workflow CLI:
`.claude/skills/sf-workflow/workflow-cli.sh`. Use its configured board tool, not raw mutations.
Commit and push before AI testing; preserve Human testing requirements. Delivery tickets
need a verified merge before Done, except for a validated `nature:bundled-pr` child whose
commit ships in its non-Epic delivery parent's PR. An Epic has no PR: its first child entering
In progress starts it, and it reaches Done only after every native child has board status Done.

## Coding-agent identity and onboarding

At session initialization, use the coding-agent identity explicitly supplied by the current
host or session. Never infer an identity from a model or provider name, executable names,
instruction files, repository contents or PATH. If the host identity is absent or ambiguous,
ask the user to select one registered coding-agent profile and do not change the project.

Run `sf agents list --json` and compare that explicit identity with the effective shared and
local inventories. When a supported current agent is undeclared, report both inventories and
ask the user to choose exactly one action: add the current agent, replace the declaration with
an explicitly named non-empty set, or leave the project unchanged. A no-change decision runs
no mutating command.

Only after the user accepts add or replace, ask whether the declaration should be local to the
current machine/worktree or shared through the repository. Use `sf agents enable <agent>` for
an additive local change, `sf agents enable <agent> --scope shared` for an additive shared
change, and `sf agents replace <agents...> --scope <local|shared>` for an exact declaration.
Local onboarding must leave tracked files unchanged. Shared onboarding must produce reviewable
repository changes. Replacing a declaration never authorizes deleting existing instructions,
skills, hooks or settings.


## Execution capabilities

Use the current agent's native tools for reading, editing, shell commands and delegation.
When delegation is available and authorized, assign independent work to agents; otherwise
execute the same steps sequentially. A sequential self-review is not an independent review:
report that limitation and retain any required human review. Tool names in legacy examples
describe capabilities, not required APIs. Use the user's current request as skill arguments.
Do not assume Claude Code hooks, model selection, tool permissions or credentials transfer.
Run preconditions explicitly, and stop to report a missing capability when no equivalent exists.
Never bypass CLI guards, required approvals, tests or workflow status exit conditions.
The project manifest and workflow rules take precedence over generic skill examples,
including branch names, commit formats, staging, pushing and approval requirements.
Legacy /task examples name roles: use native delegation if available and authorized,
or perform the role's work sequentially with the review limitation stated above.

## Parallel implementation and Git worktrees

Propose parallel worktrees only when the user's request contains independent writing streams
that can be delivered concurrently. Read-only exploration and review may use parallel agents
without separate worktrees. Work with sequential dependencies, overlapping file ownership or
unclear boundaries must use one feature worktree and sequential execution.

Before proposing parallel implementation, read `.saasfoundry.json` and use
`workflow.workingBranch`; never hardcode a branch name. Keep the primary checkout on that
configured working branch. Do not let feature workers write in the primary checkout while
parallel worktrees are active.

For each independent writing stream, define one ticket, branch and worktree path, plus its owned
files and dependency boundary. Start from a synchronized configured working branch. Each worker
must stay inside its assigned worktree and ownership boundary, preserve other agents' changes
and never revert unrelated work. The agent proposes this execution shape; the user retains
control when parallel implementation was not already authorized. If authorization, clean
separation, Git support or a synchronized base is unavailable, explain the constraint and use
one worktree or sequential execution.

After each stream is complete, commit and push through the configured workflow. After its merge,
return to the primary checkout, check out and synchronize the configured working branch, verify
the merge, then remove the completed worktree and local branch only when they are merged and no
longer in use. Never remove or overwrite user-owned worktrees, branches, uncommitted changes,
stashes or credentials implicitly.
