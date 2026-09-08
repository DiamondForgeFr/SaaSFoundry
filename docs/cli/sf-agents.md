# sf agents

Manage several coding agents on an existing SaaSFoundry harness. Enabling an agent adds support without disabling another agent.

```bash
sf agents enable codex
sf agents enable kimi --scope local
sf agents refresh
sf agents list --json
sf agents enable codex --scope shared
sf agents catalog --json
```

## Scope and prerequisites

A managed project has `.saasfoundry.json`, `CLAUDE.md` and `.claude/skills`. Use `sf agents catalog` for registered tool identifiers; model names are not agent profiles.

**Local is the default.** Run at the root of a non-bare Git checkout. Local setup writes registered discovery files (including `AGENTS.md` and Gemini’s `GEMINI.md`) and `.agents/skills` files while
storing the personal inventory and successful baselines inside the checkout's Git directory. It leaves tracked files, the index, branch and shared manifest unchanged. If a tracked destination needs
modification, the complete local setup fails before depositing files. Identical tracked files can be reused without local ownership.

**Shared scope is explicit.** `--scope shared` stores the selected support in the optional `modules.harness.agents` field and produces files to review and commit through the normal project workflow.
It also works in managed directories without Git. A legacy manifest without this field starts with Claude Code configured. Sharing one agent does not publish all personal selections.

Unmanaged repository adoption belongs to #649. These commands do not install runtimes, change credentials or permissions, or verify native agent discovery. Profiles are registered by tool identifier:
`claude-code`, `codex`, `kimi`, `gemini-cli`, `qwen-code` and `generic`. Use `sf agents catalog` to inspect the current versioned catalog. Model names such as `gpt`, `sonnet` or `k2` are not agent
identifiers. These commands do not install agent runtimes or probe their native discovery behavior.

## Commands

| Command                                      | Behavior                                                          |
| -------------------------------------------- | ----------------------------------------------------------------- |
| `enable <agents...> [--scope local\|shared]` | Adds support in the selected scope; defaults to local.            |
| `refresh [--scope local\|shared]`            | Refreshes instructions in that scope; defaults to local.          |
| `list`                                       | Reports shared, local and effective agents plus discovered files. |

All commands accept `--json`. `list` is read-only and reports runtime discovery as `not-checked`.

## Git exclusions and worktrees

Each checkout keeps its own inventory and exclusions. Setup uses Git's worktree configuration and a private exclude file, rather than the common `info/exclude` file that would affect sibling
worktrees. Standard repositories can enable `extensions.worktreeConfig` automatically. Configurations requiring an unrelated Git configuration migration are rejected before setup; resolve the reported
prerequisite first.

Existing user exclusions are preserved as a snapshot in the private file; their source remains untouched. Future changes to the original exclusion source are not synchronized automatically; reconcile
the private snapshot when those rules change. Only exact locally managed paths are excluded. If repository ignore rules would leave those local files visible to Git, setup refuses before depositing
them. The command never uses `assume-unchanged` or `skip-worktree` to hide changes to tracked files.

When explicitly sharing support, owned local exclusion rules for the shared artifacts are removed so those files can be reviewed and added to Git. Independent ignore rules remain yours to manage.

Git documents the worktree configuration mechanism and its prerequisites in the [Git worktree documentation](https://git-scm.com/docs/git-worktree#_configuration_file).

## Preservation and conflicts

Existing instructions, hooks, credentials and unrelated configuration are preserved. Repeating an unchanged operation avoids rewriting the manifest and generated files.

Local setup preflights the complete destination set; conflicting tracked or customized files cause a nonzero result. Shared setup retains the existing conflict-aware behavior: custom files remain in
place, `.saasfoundry.new` sidecars provide reconciliation content where possible, and successful baselines are retained for retry. A conflict never claims the requested support was successfully
enabled.

`sf update` preserves shared inventory and shared-file baselines. After updating the common harness, run `sf agents refresh` for local support or `sf agents refresh --scope shared` for shared support.
Commands never stage, commit, push, or change Git branches.

## Tool profiles and model providers

The profile registry describes how a coding tool loads project instructions. It does not select a model, provider or API credential. Configure those personally in your tool; changing them does not
require regenerating project instructions.

`sf agents catalog --json` works outside a managed project and returns the registry version, declared discovery support, documentation sources and limitations. Every profile reports runtime
capabilities as `not-checked`; declaration is not a successful connection or discovery test.

| Profile       | Instructions                    | Shared skills                                                           |
| ------------- | ------------------------------- | ----------------------------------------------------------------------- |
| `claude-code` | Existing `CLAUDE.md`            | Existing Claude skills                                                  |
| `codex`       | `AGENTS.md`                     | `.agents/skills`                                                        |
| `kimi`        | `AGENTS.md`                     | See declared profile limitations                                        |
| `gemini-cli`  | `GEMINI.md` imports `AGENTS.md` | Documented `.agents/skills` alias                                       |
| `qwen-code`   | Documented `AGENTS.md` loading  | Explicit reading fallback; native shared-skill discovery is not claimed |
| `generic`     | Manually load `AGENTS.md`       | Manually read the referenced skills; compatibility unverified           |

Gemini's [context files](https://geminicli.com/docs/cli/gemini-md/) and [skills documentation](https://geminicli.com/docs/cli/skills/) describe its discovery mechanisms. Qwen's
[memory documentation](https://qwenlm.github.io/qwen-code-docs/en/users/features/memory/) documents reading an existing AGENTS.md.

For an unlisted tool, explicitly choose `generic` and verify that it loads the instructions and can invoke the required guarded workflow commands. Unknown identifiers and model/provider names such as
`deepseek`, `gpt` or `minimax` are rejected; they are not implicitly mapped to a tool profile.

New integrations are reviewed data changes in `src/harness/agent-profiles.json`, with registry/schema parity and deposit tests. Profiles cannot contain commands, credentials or arbitrary output
directories. This delivery includes built-in profiles only; it does not load or execute remote profile plugins.
