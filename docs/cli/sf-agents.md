# sf agents

Manage several coding agents on an existing SaaSFoundry harness. Enabling an agent adds support without disabling another agent.

```bash
sf agents enable codex
sf agents enable kimi --scope local
sf agents refresh
sf agents list --json
sf agents enable codex --scope shared
sf agents catalog --json
sf agents adopt codex claude-code --scope shared
# Review the preview, then apply that exact plan:
sf agents adopt codex claude-code --scope shared --apply --plan <plan-id>
```

## Scope and prerequisites

A managed project has `.saasfoundry.json`, `CLAUDE.md` and `.claude/skills`. Use `sf agents catalog` for registered tool identifiers; model names are not agent profiles.

**Local is the default.** Run at the root of a non-bare Git checkout. Local setup writes registered discovery files (including `AGENTS.md` and Gemini’s `GEMINI.md`) and `.agents/skills` files while
storing the personal inventory and successful baselines inside the checkout's Git directory. It leaves tracked files, the index, branch and shared manifest unchanged. If a tracked destination needs
modification, the complete local setup fails before depositing files. Identical tracked files can be reused without local ownership.

**Shared scope is explicit.** `--scope shared` stores the selected support in the optional `modules.harness.agents` field and produces files to review and commit through the normal project workflow.
It also works in managed directories without Git. A legacy manifest without this field starts with Claude Code configured. Sharing one agent does not publish all personal selections.

`sf agents adopt` is the entry point for an existing repository that does not yet have a SaaSFoundry manifest. Its default invocation is a pure preview: it inventories recognized instruction and skill
surfaces, identifies the source it can preserve, and reports every proposed file, prerequisite, warning, and conflict without writing files, Git configuration, exclusions, state, or lock files.
Applying requires both `--apply` and the exact `--plan <id>` printed by that preview. The command recomputes the plan before writing and rejects a stale ID if the repository changed.

These commands do not install runtimes, change credentials or permissions, or verify native agent discovery. Profiles are registered by tool identifier: `claude-code`, `codex`, `kimi`, `gemini-cli`,
`qwen-code` and `generic`. Use `sf agents catalog` to inspect the current versioned catalog. Model names such as `gpt`, `sonnet` or `k2` are not agent identifiers. These commands do not install agent
runtimes or probe their native discovery behavior.

## Commands

| Command                                      | Behavior                                                                             |
| -------------------------------------------- | ------------------------------------------------------------------------------------ |
| `adopt <agents...> [--scope local\|shared]`  | Plans by default; applies only with `--apply --plan <id>`.                           |
| `enable <agents...> [--scope local\|shared]` | Adds support in the selected scope; defaults to local.                               |
| `refresh [--scope local\|shared]`            | Refreshes instructions in that scope; defaults to local.                             |
| `list`                                       | Reports shared, local and effective agents plus discovered files.                    |
| `doctor [agents...]`                         | Diagnoses artifact evidence and unverified host capabilities without changing files. |

All commands accept `--json`. `list` is read-only and reports runtime discovery as `not-checked`.

## Adopting an existing repository

Start from the repository root and request the tool profiles that should be supported:

```bash
sf agents adopt codex claude-code --json
```

The JSON plan is versioned and includes `planId`, `source`, the existing inventory, proposed file actions, conflicts, warnings, prerequisites, and `canApply`. Preview works without a manifest so it
can explain what is reusable and, when workflow configuration is absent, point to `sf workflow` as a prerequisite. Applying requires an existing valid `.saasfoundry.json`; the preview never creates or
repairs one.

When `canApply` is true, apply the exact reviewed plan:

```bash
sf agents adopt codex claude-code --scope local --apply --plan <plan-id>
```

Local adoption is personal to the checkout and does not modify tracked files. Shared adoption writes a reviewable working-tree diff for the team workflow. Neither mode stages, commits, pushes, changes
branches, or moves the chosen source file. A changed inventory, source, request, or scope produces a different plan ID and the old apply command is rejected.

Shared adoption records harness version `0` when the manifest has no existing harness stamp. This identifies instruction adoption without claiming that the full harness or its skill set was installed;
`sf update` can therefore distinguish an adopted instruction surface from a complete harness. An existing harness version is retained.

Adoption creates reference wrappers only. It does not copy even recognized skill files: a customized script or skill body can contain credentials. The wrappers point to existing procedures for
explicit reading, including custom skills. This reference-only behavior is retained by later agent refreshes.

A repository with only `AGENTS.md` can be adopted for Codex without fabricating `CLAUDE.md` or requiring `.claude/skills`; a generated Claude reference is optional when Claude Code is also requested.
If both Claude and portable instruction roots contain custom content, adoption reports a conflict and does not silently choose precedence. Original instruction files remain user-owned; only exact
generated wrappers receive managed baselines.

Adoption is additive. There is no automatic removal command: removing an adapter is a separate deliberate operation because user edits, shared history, and local exclusions must be evaluated at that
time.

## Diagnosing agent capabilities

```bash
sf agents doctor codex claude-code
sf agents doctor --json
sf agents doctor codex --check-runtime --json
```

`doctor` reports all registered profiles by default, or only the explicitly requested tool IDs. It works in partial repositories and never selects an active model. It reads local evidence without
installing anything, changing files, running hooks, logging in or contacting services. `--check-runtime` only looks for executable files in PATH; it does not launch them. A desktop or IDE host can
work without a corresponding CLI in PATH.

The versioned JSON report separates project checks from each agent's checks and includes initialization instructions. Each check has a stable ID, status, explanation and, where relevant, remediation:

Executable lookup is bounded to 64 KiB and 256 PATH entries. Windows executable-extension lookup is currently reported as `not-checked`; verify availability in the actual host. Shared registration is
read from the manifest; checkout-private registration remains `not-checked` and can be inspected separately with `sf agents list --json`.

| Status        | Meaning                                                                                                    |
| ------------- | ---------------------------------------------------------------------------------------------------------- |
| `supported`   | The stated static evidence was found, such as an instruction artifact. It does not certify host execution. |
| `unavailable` | The checked artifact or executable was not found. Follow the remediation when it is needed.                |
| `not-checked` | No reliable observation was made, including native discovery, hooks, authentication and delegation.        |
| `failed`      | Inspection encountered an invalid or unsafe surface, or another diagnostic failure.                        |

Exit code `1` reports a failed check or invalid request; `0` means the report was produced without a failed check. Missing artifacts and unverified host capabilities can still appear in a report that
exits `0`: read each check before working. File presence, vendor-documented support, executable availability and actual host behavior are distinct facts.

For a reproducible native-observation protocol and safe Claude/Codex handoffs, see [Agent coexistence and native verification](../guide/agent-coexistence.md).

### Initialize a session when hooks are missing or unverified

1. Load the chosen entrypoint (`CLAUDE.md`, `AGENTS.md` or `GEMINI.md`) and every project instruction it references. Read `.saasfoundry.json` for the workflow, SRS backend and output language.
   Reconcile missing or conflicting instructions before implementation.
2. Run `sf status --agent-friendly --no-network` and act on its preconditions. The friendly flag retains an exit code of zero for hook compatibility; a `fail` in its output still requires resolution.
   Existing `--claude-friendly` hooks remain compatible.
3. Run `sf agents doctor <tool-id>`. Read applicable skills explicitly if native discovery has not been verified. Reference-only adoption can intentionally keep procedures in the original
   `.claude/skills` or `.agents/skills` directory; an absent copy is not permission to invent a replacement process.
4. Read the project's workflow skill and current status document, then call the existing guarded workflow CLI with `status <ticket>`. Use the CLI selected by those instructions for transitions. A
   script's existence does not prove its guard ran. If required scripts are missing, resolve the prerequisite through `sf workflow` before transitions; never replace them with direct board mutations.
5. Validate required GitHub/SRS access through the configured connector or its existing read-only status command. Authentication, repository access and Projects permissions are separate checks. Let
   existing credential resolvers work; never paste tokens into diagnostic reports. Respect the host's sandbox, network and approval controls.
6. Verify hook events in the actual host before relying on them. Until then, repeat these initialization steps manually in each session and explicitly apply the SRS/workflow procedures when their
   triggers occur.

### Delegation and independent review

Use native delegation when the current host exposes it and the user's authorization permits it. CLI detection cannot establish that delegation is available, authorized or has remaining capacity. If it
is unavailable, disclose the limitation and perform eligible implementation or research steps sequentially.

Sequential self-review does **not** satisfy an independent-review requirement. For a complex ticket, report that requirement as incomplete and remain in AI testing until a separate authorized agent
context or independent human reviewer performs it. Do not downgrade complexity, bypass guards or count repeated self-reviews as independent reviewers. Model and effort choices remain host-side
decisions; this command does not configure routing rules.

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

Runtime availability, native hooks, and manually readable skills are reported as distinct capabilities. A runtime being installed does not prove its hooks ran; a Markdown file being readable does not
prove native skill discovery or workflow enforcement.

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
