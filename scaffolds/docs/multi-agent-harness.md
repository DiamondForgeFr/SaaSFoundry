# Shared agent instructions

The shared-instructions foundation adds Codex and Kimi entry points alongside the existing Claude harness. It does not select an exclusive agent for the project. All agents use the configured workflow and SRS backend and invoke the same guarded CLI scripts.

## Current scope

This foundation exposes an installer API. User-facing enablement and local/shared CLI options are tracked by #647 and #648; adoption and refresh orchestration by #649; capability diagnostics by #650; the full compatibility matrix by #651. These commands are not available yet.

For a newly generated harness, `installHarness` accepts an optional `agents` array with `claude-code`, `codex`, and `kimi`. Omitting it preserves existing installation behavior. For an existing harness, `installAgentInstructions` adds the instruction surfaces without reinstalling its legacy files.

The existing `CLAUDE.md` remains the source of project instructions during this additive phase. Generated `AGENTS.md` directs Codex and Kimi to read it. Portable skill copies live under `.agents/skills/`; the legacy `.claude/skills/` files remain available to Claude and existing scripts. Do not manually maintain divergent copies of generated procedures. Structural relocation belongs to the registered migration in the adoption phase.

## Conflicts and ownership

Existing instructions are user-owned. The adapter reports conflicts instead of overwriting them. Reconcile a proposed `.saasfoundry.new` file before using the affected surface. Existing custom instructions must be reviewed for agent-specific operations: a Markdown file being readable does not make every procedure portable.

The installer returns generated-file hashes for its caller to retain as the refresh baseline. Do not record the hash of a conflicting user file as a successfully installed template. Keep local adapter inventory outside a shared manifest when the local-scope implementation is added.

## Workflow and access

Run `sf status --claude-friendly --no-network` before work; the option is still named for Claude but its Markdown report can be read by every agent. Read the applicable workflow status file and use the project workflow CLI for transitions. Skill content is guidance; the CLI guards remain the common enforcement layer.

GitHub and SRS credentials are resolved by the existing CLIs. Do not copy secrets into agent instructions, settings, or the repository. Each agent's sandbox and approval rules still apply. Installed files alone do not demonstrate that Git push, network access, or all hooks work in a particular host.

Claude's session and prompt hooks are not automatically installed for another agent. Other agents must perform the initialization procedure explicitly until a tested native hook adapter exists. Delegation depends on the host's tools; a sequential review is not equivalent to an independent review required by the workflow.

## Team usage

A developer can alternate agents on one completed piece of work without changing the project's supported agents. For simultaneous implementation on different changes, use separate branches and worktrees. Share the board and SRS, and hand off the ticket, branch, completed checks and remaining work explicitly.

Runtime discovery must be verified in the actual agent. Filesystem and installer tests establish that the expected files exist; they do not establish that a particular desktop or CLI version loaded them.
