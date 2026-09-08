# sf agents

Manage several coding agents on an existing SaaSFoundry harness. Enabling an agent adds support without disabling another agent.

```bash
sf agents enable codex --scope shared
sf agents enable claude-code kimi --scope shared
sf agents refresh --scope shared
sf agents list --json
```

## Scope and prerequisites

This delivery supports an existing managed project with `.saasfoundry.json`, `CLAUDE.md` and `.claude/skills`. Shared scope must be explicit: missing scope and `--scope local` are rejected before
changing files. Local configuration is delivered separately in #648; adoption of arbitrary unmanaged repositories belongs to #649.

Agent identifiers are `claude-code`, `codex` and `kimi`. Model names such as `gpt`, `sonnet` or `k2` are not agent identifiers. These commands do not install agent runtimes or probe their native
discovery behavior.

## Commands

| Command                             | Behavior                                                                |
| ----------------------------------- | ----------------------------------------------------------------------- |
| `enable <agents...> --scope shared` | Adds agents to the retained set and installs their shared instructions. |
| `refresh --scope shared`            | Refreshes instructions for the retained set.                            |
| `list`                              | Reports configured support and discovered project files.                |

All commands accept `--json`. `list` is read-only and explicitly reports runtime discovery as not checked.

## Preservation and conflicts

The retained set lives in the optional `modules.harness.agents` field. A legacy managed harness without this field starts with Claude Code configured. Existing agent files, hooks, credentials and
unrelated manifest values are preserved. Repeating an unchanged operation does not rewrite the manifest.

Shared instructions use the existing conflict-aware deposit mechanism. Customized destination files remain in place; `.saasfoundry.new` sidecars provide reconciliation content where possible. A
conflict exits nonzero, reports paths, and does not claim that the requested agents were successfully enabled. Successful file baselines are retained for a safe retry.

Review and commit shared changes through the project workflow. These commands never switch Git branches, commit, push, or change host permissions.

`sf update` preserves the retained agent set and shared-file baselines. Run `sf agents refresh --scope shared` after updating the common harness to refresh the shared instruction copies.
