# {{PROJECT_NAME}}

AI-assisted workflow harness installed by SaaSFoundryAI (CLI v{{VERSION}}). This project keeps its own technical stack — SaaSFoundryAI only manages the AI collaboration layer (workflow, skills, SRS).

## 🧭 Preconditions first (read before asking questions)

Before asking the user anything about scope, workflow, or tooling, **read the manifest and check the configured tools**:

1. Read `.saasfoundry.json` — source of truth for the workflow configuration, SRS backend, and installed modules. Never re-ask what is already declared there.
2. Run `sf status --claude-friendly --no-network` for a summary of the manifest and preconditions. On a configured session this is auto-injected via the `SessionStart` hook in `.claude/settings.json`.
3. If a precondition is `fail`, route the user to the relevant install/config CLI (`sf workflow`, `sf update --add-modules srs`, `sf skill install`) instead of asking scope questions.

## Coding-agent identity and onboarding

Use the coding-agent identity explicitly supplied by the current host or session. Never infer it from a model/provider name, executable, repository file, or PATH. If the identity is absent or
ambiguous, ask the user to choose a registered coding-agent profile and do not change the project.

Run `sf agents list --json`. When the current supported tool is undeclared, ask the user to choose one action: add it, replace the declaration with an explicitly named non-empty set, or leave the
project unchanged. Ask whether the choice is local to this checkout or shared through the repository only after add or replace is accepted. Use `sf agents enable` for add and `sf agents replace` for
exact replacement. No change runs no mutating command. Replacement changes inventory only and never deletes existing instructions, skills, hooks, settings, credentials, or exclusions.

## Output language

Everything you produce — SRS pages, tickets and their comments, code comments, commit messages — is written in the language declared in `.saasfoundry.json` → `language`, which defaults to English on all three surfaces (`srs`, `tickets`, `codeComments`).

**The language of the conversation is not the signal.** Talking with the user in French does not make the artefacts French. `sf status --claude-friendly` prints the resolved values.

## Git Workflow

- Main branch: `{{MAIN_BRANCH}}` (see `.saasfoundry.json` → `workflow.workingBranch` / `prTargetBranch` — never hardcode branch names)
- **Branch naming — the ticket number is mandatory.** Read the patterns from `.saasfoundry.json` → `workflow.branchNaming`; the defaults are `feature/{N}-{description}` and `fix/{N}-{description}`.
- **Why the `{N}` prefix is not cosmetic:** the workflow guards resolve a ticket's PR by matching `^(feature|fix)/<ticket>(-|$)` against open PR head branches. A branch without the ticket number matches nothing, so the `→ In Review` PR-existence guard and the `→ Done` PR-merged guard both fail — and the only way forward becomes `SF_WORKFLOW_BYPASS_*` on every ticket, silently disabling the guards project-wide. If the pattern and the regex ever disagree, realign `branchNaming`; never "fix" the regex.
- Commit format: see `.saasfoundry.json` → `workflow.commitFormat` (a ticket reference is required when `requireTicket` is true).

## Development Commands

Document this project's build, test, and lint commands here so the AI can validate its changes — SaaSFoundryAI does not manage this project's technical stack.
