# Shared agent instructions

The shared-instructions foundation adds Codex and Kimi entry points alongside the existing Claude harness. It does not select an exclusive agent for the project. The adapters direct configured agents to use the project's workflow and SRS backend through the same guarded CLI scripts; verify instruction loading and actual invocation in the host.

## Current scope

This foundation exposes an installer API and additive `sf agents` commands for managed projects. Local scope is the default; shared scope is explicit. Existing repositories can start with
`sf agents adopt <agents...>`, which previews a bounded adoption plan without writing and applies only with the exact returned plan ID. `sf agents doctor [agents...]` diagnoses local artifacts and
distinguishes them from unverified host capabilities. The full compatibility matrix is tracked by #651.

For a newly generated harness, `installHarness` accepts an optional `agents` array with `claude-code`, `codex`, and `kimi`. Omitting it preserves existing installation behavior. For an existing harness, `installAgentInstructions` adds the instruction surfaces without reinstalling its legacy files.

For managed Claude-first harnesses, the existing `CLAUDE.md` remains the source of project instructions. Generated `AGENTS.md` directs portable agents to read it. A Codex-only repository may instead
retain its original `AGENTS.md` as the source and does not need `.claude/skills`; requesting Claude may add a small reference when the plan can do so without replacing custom instructions. Portable
skill copies live under `.agents/skills/` when the source has managed skills to share. Do not manually maintain divergent copies of generated procedures.

## Conflicts and ownership

Existing instructions are user-owned. The adapter reports conflicts instead of overwriting them. Reconcile a proposed `.saasfoundry.new` file before using the affected surface. Existing custom instructions must be reviewed for agent-specific operations: a Markdown file being readable does not make every procedure portable.

The installer returns generated-file hashes for its caller to retain as the refresh baseline. Do not record the hash of a conflicting user file as a successfully installed template. Local adapter inventory lives in the checkout Git directory, outside the shared manifest.

## Workflow and access

Run `sf status --agent-friendly --no-network` before work; `--claude-friendly` remains a compatible alias. Both flags return Markdown with a non-failing process exit code, so read and resolve any failing preconditions in the output. Read the applicable workflow status file and use the project workflow CLI for transitions. Skill content is guidance; the CLI guards remain the common enforcement layer.

GitHub and SRS credentials are resolved by the existing CLIs. Do not copy secrets into agent instructions, settings, or the repository. Each agent's sandbox and approval rules still apply. Installed files alone do not demonstrate that Git push, network access, or all hooks work in a particular host.

Claude's session and prompt hooks are not automatically installed for another agent. Other agents must perform the initialization procedure explicitly until a tested native hook adapter exists. Delegation depends on the host's tools; a sequential review is not equivalent to an independent review required by the workflow.

### Manual session initialization

1. Read the selected agent entrypoint and every referenced project instruction, then `.saasfoundry.json` for configured tools, workflow and language.
2. Run `sf status --agent-friendly --no-network`, resolve its preconditions, and inspect `sf agents doctor <tool-id>`.
3. Read applicable skills explicitly until native discovery is verified. Use the retained procedure directory named by the instructions; adoption may intentionally have no copied skills.
4. Read the current workflow status document and call the existing guarded workflow CLI with `status <ticket>`. Missing workflow scripts require configuration through `sf workflow`, not direct board mutations.
5. Check required access through the configured connectors and their credential resolvers. The existence of credentials or a script does not verify authentication, permissions or guard execution.
6. Verify hooks in the actual host. Until verified, repeat initialization each session and apply SRS/workflow trigger procedures manually. Keep the host's sandbox and approval controls.

`sf agents doctor --json` distinguishes `supported`, `unavailable`, `not-checked` and `failed` checks. Supported artifact evidence is not proof of native discovery. `--check-runtime` finds executable files in PATH without launching them, and does not certify a runtime session. No network, hook execution, login or file changes are performed by doctor.

Native delegation must be available and authorized in the current host. Disclose sequential fallback when needed. A required independent review remains incomplete until a separate authorized agent context or independent human reviewer performs it; do not advance past AI testing on self-review alone. Diagnostics do not configure models, effort or routing policy.

## Team usage

A developer can alternate agents on one completed piece of work without changing the project's supported agents. Before implementation, the agent identifies independent writing streams and proposes
parallel worktrees only when concurrent delivery is useful. Read-only exploration and review may run in parallel in one checkout. Sequential dependencies, overlapping files or unclear ownership use
one feature worktree and sequential execution.

Read `workflow.workingBranch` from `.saasfoundry.json` and keep the primary checkout on that configured branch. Each parallel writer receives one ticket, branch and worktree path, explicit owned files
and a dependency boundary, and starts from a synchronized configured working branch. The user retains control when parallel implementation was not already authorized. Share the board and SRS, and
hand off the ticket, branch, completed checks and remaining work explicitly.

After a stream merges, return to the primary checkout, synchronize the configured working branch and verify the merge before removing the completed, unused worktree and local branch. Preserve
user-created worktrees, branches, stashes and uncommitted changes. If authorization, Git support, synchronization or clean separation is unavailable, state the constraint and use one worktree or
sequential execution.

Runtime discovery must be verified in the actual agent. Filesystem and installer tests establish that the expected files exist; they do not establish that a particular desktop or CLI version loaded them.

Runtime availability, hook execution, and manual skill readability are separate facts. Report them separately; none is evidence for the other two.

## Additive enablement on managed projects

Use `sf agents enable codex --scope shared`, then `sf agents enable kimi claude-code --scope shared` to retain all three agents. `sf agents list --json` separates configured support from discovered files and does not claim runtime verification. `sf agents refresh --scope shared` refreshes the retained set after changes to common skills.

For personal use, run `sf agents enable codex` (local by default) at the Git checkout root. Local setup preserves tracked files and the shared manifest, and isolates personal selections and exclusions by worktree. A tracked destination needing changes blocks local setup. Explicit shared setup makes its artifacts reviewable in Git and retains support for fresh clones. Unknown agent names and unsupported scopes are rejected before mutation. Existing user files and host settings are preserved; conflicts return a nonzero exit and reconciliation paths. The optional manifest inventory survives `sf update`, and repeated operations do not rewrite unchanged files.

For an existing repository, run `sf agents adopt codex --json` first. Planning performs inventory only: it creates no manifest, lock, Git config, exclusions, or generated files. The plan records the
selected source and every proposed action. Application requires a valid manifest plus `--apply --plan <id>`; the implementation replans and rejects the ID when any relevant input is stale. Local
adoption leaves tracked files untouched. Shared adoption produces a diff for review through the normal workflow. Custom mixed instruction roots are a conflict, never an invitation to pick a silent
precedence.

When no harness stamp exists, shared instruction adoption records harness version `0`; it does not claim the complete harness or `.claude/skills` were installed. `sf update` can distinguish that
state from a full installation. An existing harness version is preserved.

Adoption adds reference wrappers without copying skill/script contents, including recognized package paths that may contain customized credentials. The wrappers refer to existing custom and bundled procedures for explicit reading; later agent refreshes retain this reference-only policy.

Adoption does not move source files and needs no numbered migration. It is additive and has no automatic removal path; removing an adapter is a separate deliberate operation that must account for
user edits and repository history.

## Extensible tool profiles

Use `sf agents catalog --json` to inspect versioned profiles, declared discovery support and limitations. Available profiles include Claude Code, Codex, Kimi, Gemini CLI, Qwen Code and an explicitly unverified generic profile. All retain `runtime: not-checked` until capabilities are tested in the actual host.

Profiles identify coding tools, not model brands. Configure model/provider selection in the tool's personal settings. For an unknown tool, `sf agents enable generic --scope shared` deposits portable instructions to load manually; it does not certify tool execution or workflow compliance. Existing local/shared scope rules still apply.

Gemini receives a small GEMINI.md import of AGENTS.md. Qwen reads AGENTS.md directly, with explicit shared-skill reading fallback. The common source remains CLAUDE.md during this compatibility phase. Adding a profile must preserve this one-way instruction chain, user files, safe path constraints and workflow guards.
