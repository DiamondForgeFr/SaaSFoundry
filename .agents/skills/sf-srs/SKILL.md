---
name: sf-srs
description: "SaaSFoundry srs procedures. Follow the project workflow and CLI guards."
---

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


# SRS SaaSFoundry AI

Tool-agnostic SRS host — draft specs, spawn tickets, evaluate freshness via the configured `SrsAdapter`.

## Auto-trigger keywords

create SRS, draft SRS, draft FR, audit codebase for SRS, SRS status, evaluate SRS, spawn tickets from SRS, new epic, Notion SRS root URL, `srs:drafting` label event

## Responsibilities

- **Templates** — agnostic rendering of Epic / FR pages (`PageContent`) and GitHub ticket bodies
- **Drafters** — turn free-form input (Notion pages, codebase audit) into structured `EpicSpec` / `FrSpec`
- **Spawner** — from a published SRS, spawn the matching GitHub tickets
- **Eval hook** — continuously score SRS freshness vs. codebase drift
- **Dispatch** — route every backend call through the configured `SrsAdapter` ; no Notion / Confluence / local-markdown import ever leaks into `sf-srs`

## Cross-references

| Concern                 | Lives in                              | Owned by                   |
| ----------------------- | ------------------------------------- | -------------------------- |
| `SrsAdapter` interface  | `src/builders/srs/types.ts`           | SUB-1                      |
| Backend implementations | `src/tools/<backend>/srs.adapter.ts`  | `sf-tool-<backend>` skills |
| Dispatch / factory      | `src/srs/`                            | SUB-14.2                   |
| Workflow integration    | `sf-workflow` drafting lifecycle      | SUB-8                      |
| Architecture doc        | `.claude/docs/architecture-skills.md` | —                          |

## Directory map

```
sf-srs/
├── SKILL.md                         # this file
├── templates/
│   ├── pages/                       # Epic + FR page templates → PageContent   (SUB-3)
│   └── tickets/                     # GitHub ticket templates (srs-epic, srs-story)   (SUB-4)
│       └── examples/                # archetypal filled-in examples: epic.md | story.md | task.md | issue.md
└── scripts/
    └── srs-cli.sh                   # single orchestrator entrypoint           (SUB-14.3)
```

**Authoring guidance** — before drafting a real Epic / Story / Task / Issue body, skim the matching file under [`templates/tickets/examples/`](templates/tickets/examples/). Each example opens with a
`<!-- Why this example -->` preamble that names the pattern it illustrates and the anti-patterns to avoid. Import the **pattern** (tone, section density, title convention), not the fictional content.

TS entrypoints dispatched by `srs-cli.sh` live alongside the CLI source under `src/srs/bin/` (dogfood) or `node_modules/saasfoundryai-cli/dist/srs/bin/` (shipped). They are **not** duplicated inside
the skill folder — the skill is a thin orchestrator.

| Action                      | Bin entrypoint (`src/srs/bin/`) | Owner    |
| --------------------------- | ------------------------------- | -------- |
| `validate`                  | `validate.ts`                   | SUB-14.3 |
| `browse`                    | `browse-tree.ts`                | SUB-6    |
| `draft --from notion-pages` | `draft-from-notion-pages.ts`    | SUB-6    |
| `draft --from codebase`     | `draft-from-codebase.ts`        | SUB-13   |
| `write`                     | `write-srs.ts`                  | SUB-6    |
| `spawn`                     | `spawn-tickets.ts`              | SUB-9    |
| `apply-update`              | `apply-srs-update.ts`           | SUB-10   |
| `eval`                      | `eval-srs.ts`                   | SUB-16   |

Placeholder subfolders under `templates/` are kept with `.gitkeep` until their owning SUB populates them.

## Configuration

Reads `tools.srs.backend` from `.saasfoundry.json` to pick the right adapter — see [manifest schema](../../../.claude/docs/manifest-schema.md). Dispatch resolution happens inside `src/srs/` (SUB-14.2) — never
directly in this skill.

## Output language

SRS pages — features, versions, FRs — are written in **`language.srs`** from `.saasfoundry.json` (`jq -r '.language.srs // "en"'`), which defaults to English. The language spoken with the user is
irrelevant: a French conversation still writes an English SRS unless the project opted that surface out. A project may legitimately want a French SRS alongside English code comments, which is why the
surfaces are separate.

## Commands

**Use `sf srs <action> [args]`.** It is registered in Commander (see `src/commands/srs.ts`) and imports the entrypoints directly from the installed package, so it resolves the same way in this
checkout, in a generated project, in CI and in a script. Every example below uses it.

The shell wrapper `.claude/skills/sf-srs/scripts/srs-cli.sh <action> [args]` exposes the same actions and exists for one case: a session where `sf` is not on the `PATH`. It resolves the dispatch
library from `dist/srs/`, `src/srs/` or `node_modules/saasfoundryai-cli/dist/srs/`, searching upwards from both the script and the working directory.

> [!warning] The wrapper was unusable in generated projects until #525
>
> Its resolver only ever looked for `src/srs` or `dist/srs/index.js` — paths that exist in this checkout and nowhere else. Every SRS command through the wrapper failed for every user who enabled the
> module, and our own dogfooding could not see it, because we only ever run the wrapper from here. Prefer `sf srs`: one resolution path, exercised by everyone.

Run `sf srs help` to see the full action list.

### Writing the three levels

`write-srs` creates `feature → version → FR` in one run. Two fields carry the shape:

- **`epic.parentId`** — the logical id of the feature this page sits under, resolved within the batch, the mechanism `fr.parentEpicId` already uses. **Its presence is what makes the page a version.**
  The level comes from position, never from the title: call it `MVP`, `V1` or `v2 — Titre`, the tooling reads where it sits.
- **`epic.version.changes`** — what this version adds or changes relative to the previous one. Rendered on the version page.

Order matters: a page can only reference a logical id declared before it in the batch. See `templates/examples/example-three-levels.spec.json`.

**An FR attached to a feature is refused.**

```
✗ write-srs: candidate #2 (fr) is attached to "FEAT-LIVE", which is a feature, not a version.
  Epic = feature + version: an FR belongs to a version, so the batch must declare one.
```

Reading tolerates the flat shape — 25 real features are in it and their FRs must not be lost. Writing does not: there is no reason to create a new feature that already needs `sf srs normalize`. Any
existing spec that wrote a flat feature is rejected after this change, which is intended.

The feature page lists its versions, resolved from the batch before anything is written — the feature is created before its versions exist, and `updatePage` appends rather than replaces, so indexing
afterwards would duplicate the list on every re-run.

### Answering a conformance finding

`sf srs eval` reports structural deviations alongside drift. They are not conversational signals — they come from the tree, so the eval hook does not produce them and there is nothing to detect in
what the user says. The agent reads them from the report and acts:

| finding                         | what it means                                                                                                      | what to do                                                                                                            |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `feature-without-version`       | The feature holds its FRs directly, so it has no Epic identity and no place to record what a later version changes | `sf srs normalize --feature <page-url>` — read the dry run to the user, then re-run with `--apply` on their approval  |
| `feature-without-frs`           | The feature carries no spec at all                                                                                 | Ask whether it is a placeholder or a gap. Never normalize it — an empty version page is a level with nothing under it |
| `version-without-frs`           | A version page holds no FR, or the page is not a version at all                                                    | Show it to the user; the walk cannot tell the two apart, because the level is read from position                      |
| `unexpected-page-under-version` | A page sits where an FR was expected                                                                               | Rename it to the FR convention, or move it out. It is excluded from every score until then                            |
| `fr-at-root-level`              | An FR has no feature above it                                                                                      | Move it under a feature; `spawn` cannot reach it                                                                      |
| `nesting-too-deep`              | A page sits below the FR level                                                                                     | The FRs it hides are invisible to every score. Flatten it                                                             |

**`normalize` never writes without `--apply`.** Show the plan, get an answer, then apply — one feature at a time with `--feature` rather than a single 196-page sweep, so a failure is small and
legible.

The pages are **moved**, not recreated: ids, URLs, body and comments survive, so every existing link into the SRS keeps working.

### Spawning a versioned feature

`Epic = feature + version`, so a batch of tickets belongs to one version and never to the whole feature. Pointing `spawn` at a versioned feature is an error that lists the versions rather than a
licence to guess:

```
sf srs spawn --ticket 42 --epic <feature-url> --dry-run

✗ spawn: « Réunion live : transcript & notes » is a versioned feature, not an Epic.
  Pick the version to spawn:

    v1 — Existant                       (9 FR)  <url>
    v2 — Prise de notes vivante…        (4 FR)  <url>

  → sf srs spawn --ticket 42 --epic <url> --version "v2 — Prise de notes vivante"
```

`--version` accepts the version's title, id or URL. The Epic is named `<feature> - <version>`.

`--ticket` is optional. Omit it and spawn creates the Epic itself — named `<feature> - <version>` — then hangs the Stories under it, through `workflow-cli.sh create-epic`. Pass `--ticket` to attach to
an Epic that already exists. The naming convention becomes something the tool guarantees rather than something the agent has to remember.

### `--milestone` — spawning is when the release scope gets declared

```bash
sf srs spawn --epic <feature-url> --version "v1 — MVP" --milestone "v1.0.0"
```

The milestone is created or reused, the version page is linked to it, and the Epic plus every Story spawned in the run joins it. Re-running the same spawn does not produce a second release.

**The name is the release, not the version page.** `v1.0.0`, not `v1 — MVP`. A release may carry several features' versions — that is why the link is an association and not an equality (#542 R2), and
why the CLI will not derive the name from the page it was handed. Ask the user for it; a version number is a decision.

Omit the flag and spawn behaves as before, but says so: `release: none — pass --milestone <name> to declare what these tickets ship in`. That line exists because a version spawned into no release is
the exact state #542 was filed to prevent, and the moment to raise it is while the tickets are being created — not when somebody later asks what v1 contains.

**Never assign the tickets one by one afterwards.** That loop is what `--milestone` replaces; running it by hand is how #562 was found.

Failure modes are ordered so they stay recoverable: the milestone is ensured _before_ any ticket exists, so a backend problem leaves an untouched board. If an assignment fails after the tickets are
created, the run reports which ones joined and exits 9 rather than leaving a half-assigned board implicit.

A feature holding its FRs directly still spawns from `--epic` alone — 25 real features are in that shape, and `sf srs normalize` is what moves them onto the model.

**A page that is neither an FR nor a version aborts the run and creates nothing.** Producing a ticket from a raw title is worse than failing: it looks planned and is empty.

| Action         | Purpose                                                               | Populated by |
| -------------- | --------------------------------------------------------------------- | ------------ |
| `help`         | Print available actions                                               | SUB-14.3     |
| `validate`     | Smoke-test the configured backend via `createSrsAdapter().init()`     | SUB-14.3     |
| `browse`       | List direct children of a backend page (tree navigation helper)       | SUB-6        |
| `draft`        | Run the drafter matching `--from <source>` (notion-pages \| codebase) | SUB-6, 13    |
| `write`        | Apply a `DraftCandidate[]` spec to the backend + clear pending flag   | SUB-6        |
| `spawn`        | Spawn GitHub tickets from a published SRS                             | SUB-9        |
| `apply-update` | Apply a conversational eval-hook patch (ADD-only : UR / FR / DS / TC) | SUB-10       |
| `eval`         | Compute freshness score comparing the SRS to the codebase (batch)     | SUB-16       |

## Freshness eval (SUB-16)

`sf srs eval` scores SRS drift against the codebase in batch mode — the complement to the conversational eval hook described above (which catches new decisions at conversation time ; eval catches
silent drift that already happened).

```bash
sf srs eval [--path <dir>] [--root-page <id>] [--threshold <pct>] [--json]
```

- `--path` defaults to the current working directory (same rules as `draft --from codebase` — honours `.gitignore`, skips `node_modules / dist / coverage / .git`).
- `--root-page` defaults to `tools.srs.rootPage.id` in `.saasfoundry.json`.
- `--threshold` is the minimum overall freshness score (default `80`). Exit code is `0` when the overall score ≥ threshold, `1` when below.
- `--json` emits the full `FreshnessReport` JSON for CI consumption instead of the human-readable summary.

### Heuristics (v1)

| Finding kind      | Trigger                                                                                                                        | Severity |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------- |
| `fr-without-code` | FR page exists but no scanner finding (endpoint / ui-flow / entity / test) matches its area token                              | error    |
| `orphan-area`     | Scanner area carries implementation findings (endpoint / ui-flow / entity) but no FR page exists for it                        | error    |
| `code-without-fr` | An implementation finding is outside the matched set but its area already carries other matches (or mismatches a hint filter)  | warn     |
| `fr-untested`     | FR is mapped to code findings in its area but no test coverage is detected (no `endpoint.hasTests`, no test finding, no hints) | warn     |

The overall score is the unweighted mean of FR coverage, endpoint coverage, and test coverage (each as a percentage). The per-category breakdown reports `FR` from the heuristics above.
`UR / DS / TC / NFR` are emitted with `score: null` and a note — deeper drift on those categories requires the Notion adapter to preserve table-row cells on `fetchPage`, which is a follow-up SUB.

### Three-layer matcher (L1 deterministic → L2 declarative → L3 AI review)

The eval is AI-augmented by design: the CLI runs deterministic checks so the skill can spend agent tokens only on the semantic review that tooling cannot do. No LLM is ever invoked from the tool
itself — cost for non-agent users stays at zero.

- **L1 — deterministic script.** `eval-srs` matches every FR against all scanner findings whose `area` overlaps (not just endpoints). `ui-flow`, `entity`, and `test` findings now count alongside
  `endpoint`, so frontend-only, data-only, and test-driven FRs are recognised without human intervention.
- **L2 — declarative hints on the FR page.** FR authors can narrow the match with two optional fields on `SrsFrEntry` :
  - `implementationKind: 'endpoint' | 'ui-flow' | 'entity' | 'mixed'` — filters impl findings to the declared kind (tests always count regardless).
  - `areaHints: string[]` — additional area tokens to match (handy when the scanner area and the FR ID diverge, e.g. FR area `billing` ↔ code area `payments`). Inventory builders populate these when
    the backend's page body carries them; today they are optional and unset.
- **L3 — AI review packet.** Pass `--review-packet <path>` to `eval-srs` and the tool writes a structured JSON alongside the usual report :
  ```bash
  sf srs eval --review-packet .srs-audit/review-packet.json
  ```
  The packet contains, per FR, its deterministic `status` (`matched` / `untested` / `unmatched`), the matched file list, and `promptHints` summarising the deterministic gaps. The skill feeds this
  packet into its own context and proposes :
  - matches the script missed (semantic mapping, e.g. an FR titled "Invoices" that should map to code area `billing`),
  - reclassifications (FR that looks matched but actually covers a different behaviour),
  - new UR / DS / TC / NFR items that the rendered report doesn't compute yet. The skill never edits the FR page silently — it uses the conversational eval hook (`apply-update`) to propose each change
    with the user.

### Sample output (human)

```
─── SRS freshness report ───
Root page   : 34aa31bb-4f3f-8170-8989-d8738f3356d8
Generated   : 2026-04-22T12:34:56.000Z
Threshold   : 80% (status = DRIFT)
Overall     : 62%

Per category:
  UR     n/a  (0/0)
       UR drift is not evaluated in v1 — rendered Notion tables return empty cells via fetchPage…
  FR    50%  (3/6)
  DS     n/a  (0/0)
  …

Counts:
  FR pages       : 6 (matched 3, untested 1)
  Endpoints      : 12 (matched 9, untested 4)

Drift findings (4):
  ✗ [fr-without-code] FR FR-BILLING-01 — "Invoice export" has no matching code finding in area "billing"
  ✗ [orphan-area] Code area "payments" carries 3 endpoint(s) but has no FR page (e.g. GET /charges) — api/src/modules/payments/payments.controller.ts
  ! [fr-untested] FR FR-AUTH-02 is mapped to 1 endpoint(s) but none carry tests — api/src/modules/auth/auth.controller.ts
  ! [code-without-fr] GET /session in "auth" is not covered by any FR in the SRS — api/src/modules/auth/session.controller.ts
```

### Exit codes

| Code | Meaning                                                                 |
| ---- | ----------------------------------------------------------------------- |
| 0    | Overall score ≥ threshold (FRESH) OR no FRs to evaluate                 |
| 1    | Overall score < threshold (DRIFT)                                       |
| 2    | Bad input (missing `--root-page`, malformed manifest, invalid `--path`) |
| 3    | `tools.srs.backend` missing from the manifest                           |
| 4    | Unknown / invalid backend name                                          |
| 5    | Adapter runtime error (`init()` / `listChildren` / scanner failure)     |

### CI integration pattern

Run eval as a nightly job or on `develop` pushes. Gate the pipeline on exit code `1` if strict mode is desired, or always allow through and surface the JSON in a step summary. The CI wiring itself is
project-side — this SUB only ships the eval contract.

The wrapper is intentionally thin — real logic lives in `src/srs/` and consumes only the `SrsAdapter` interface.

## Ingestion workflow (SUB-6)

When `sf new --srs-enable --srs-ingest-enable` is used (or the equivalent is picked interactively), the CLI bootstraps the SRS workspace and then stamps `tools.srs.pendingIngestion` into
`.saasfoundry.json` :

```jsonc
{
  "tools": {
    "srs": {
      "enabled": true,
      "backend": "notion",
      "rootPage": { "id": "...", "url": "...", "name": "Project" },
      "pendingIngestion": {
        "sourceBackend": "notion",
        "sourceParent": { "id": "...", "url": "...", "name": "Existing notes" },
        "createdAt": "2026-04-20T12:00:00.000Z"
      }
    }
  }
}
```

The flag is ephemeral — it signals "the user asked us to ingest existing notes next time they open the project in Claude Code". When the sf-srs skill sees it, it drives a conversational loop :

1. **Browse** — `sf srs browse --parent <sourceParent.id>` lists direct children. Claude and the user pick which ones are worth ingesting (rejecting TOC / index pages, drilling into sub-pages
   recursively via repeat browse calls).
2. **Draft** — `sf srs draft --from notion-pages --ids id1,id2,...` fetches the selected pages as `RawContent`. Claude then drafts one or more `DraftCandidate` entries (Epic or FR specs) in
   conversation with the user. No LLM call happens inside the CLI — the skill owns that step.
3. **Write** — once the user approves the drafted candidates, the skill serialises them to a temp JSON file and runs `sf srs write --spec <tmp.json>`. On success, `pendingIngestion` is cleared from
   the manifest.

On partial failure during `write`, `write-srs.ts` emits a JSON report with a `rollbackHint` listing the pages it already created — Notion has no transactional rollback, so the skill surfaces this list
to the user and suggests either archiving manually or retrying from where it failed.

### Single-pass Epic + FR writes (logical IDs, #245)

FRs reference their parent Epic via one of two fields :

- `parentEpicPageId` — an explicit Notion page ID. Use when attaching an FR to an Epic that already exists (incremental writes, post-import).
- `parentEpicId` — a **logical ID** that matches the `epic.id` of an Epic appearing earlier in the same batch. `write-srs` resolves it on the fly by building a logical-id → page-id map as Epics are
  created.

> **An epic candidate alone creates ONE page and zero FR child pages.** The epic's inline `frs[]` — like `urs`/`dsItems`/`tcItems`/`nfrItems` — is only rendered into the Epic page body (FR table
> included). The FR child pages that `spawn` enumerates to create tickets come exclusively from `kind: 'fr'` candidates. To write an Epic and its FR pages in one pass, ship one `fr` candidate per FR
> alongside the epic candidate (example below) — an epic candidate alone yields a single page with nothing to spawn. Note that `templates/examples/example-epic.spec.json` is a bare `EpicSpec` kept as
> a page-shape reference: it is NOT a valid `--spec` payload (`--spec` takes a `DraftCandidate[]`).

Example mixed spec (a single `write` call creates both Epic and FRs, no intermediate page-id collection) :

```json
[
  {
    "kind": "epic",
    "confidence": "high",
    "source": { "kind": "notion-pages" },
    "epic": {
      "id": "EPIC-AUTH",
      "title": "Authentication",
      "parentPageId": "<workspace-root-id>",
      "urs": [],
      "frs": []
    }
  },
  {
    "kind": "fr",
    "confidence": "high",
    "source": { "kind": "notion-pages" },
    "fr": {
      "parentEpicId": "EPIC-AUTH",
      "fr": { "id": "FR-1", "title": "Login endpoint" }
    }
  }
]
```

If `parentEpicId` references an Epic that is neither in the batch nor resolved via `parentEpicPageId`, `write-srs` exits 6 with an error listing every logical id known so far — easy to spot typos and
missing Epics.

### Exit codes

Every TS entrypoint under `src/srs/bin/` honours the same contract. The skill must branch on these codes rather than parsing stderr :

| Code | Meaning                                                                              |
| ---- | ------------------------------------------------------------------------------------ |
| 0    | Success                                                                              |
| 2    | Bad input — missing / malformed flag, zero candidates, empty `--ids`, bad spec shape |
| 3    | SRS backend missing from the manifest (`tools.srs` absent)                           |
| 4    | Unknown / invalid backend name declared in the manifest                              |
| 5    | Backend runtime error (network, adapter `init()` failure, fetch failure)             |
| 6    | `write` only — partial failure, JSON payload carries `rollbackHint`                  |
| 7    | `write` only — pages created successfully but clearing `pendingIngestion` failed     |

## Drafting from codebase (SUB-13)

For projects where the codebase already exists and Notion is empty (or sparse), `sf srs draft --from codebase` scans the repo and emits structured `ScannerFinding[]` that Claude clusters into
`DraftCandidate[]` conversationally with the user. The CLI never calls an LLM — it only surfaces what it can prove from the source tree.

> **Stack coverage — the scanner is best-effort, the agent is the backstop.** The deterministic scanner parses a SUBSET of stacks today (NestJS controllers, React pages, Prisma models, Jest/Vitest
> tests). On any other stack — Rust/Tauri, Go, Python/FastAPI, Rails, mobile, raw SQL — it returns sparse or empty `endpoint`/`entity` findings. **That is not evidence the surface is empty.** When the
> findings look thin for a non-parsed stack, the agent MUST read the project's own operation/model registry directly (a Tauri `generate_handlerrun ` list, a Go/Express router, a FastAPI app, SQL
> migrations, a gRPC service) and synthesise the findings itself before clustering. The finding ` and read its outputkind`s are concepts, not frameworks — `endpoint` is any invocable operation (HTTP route, RPC/command,
> CLI command, queue handler), `entity` is any persistent record (any ORM, raw DDL, a struct, a protobuf message), `ui-flow` is any user-facing view (web/native/TUI/CLI). See
> `data/clustering-rules.json` for the full stack-neutral mapping.

### When to trigger `--from codebase`

> **Precondition — "install" vs "initialise" are two different flows.** Before firing any drafter, verify `tools.srs` exists in `.saasfoundry.json`. If it does not, the user is asking to **install the
> SRS module**, not to draft content — route them to `sf update --add-modules srs` (owned by `sf-update` / `sf-workflow`), **not** to this skill. The keyword "bootstrap" routinely conflates the two;
> always check the manifest first.

Fire the flow when **any** of the following matches (all assume the SRS module is already installed) :

| Signal                                                                             | Example utterance                                                      |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| User wants to **initialise SRS content** from the codebase (module already in use) | "draft an SRS from my codebase", "audit the repo for SRS material"     |
| User mentions **drift** between code and docs                                      | "my Notion SRS is stale, rebuild it from the code"                     |
| User asks for **coverage gaps**                                                    | "what's in the code but not in Notion?"                                |
| First-time drafter run on a mature repo                                            | empty / sparse Notion root + non-empty `src/` — propose it proactively |

Skip the flow when Notion is the source of truth (run `--from notion-pages` instead), when the user is describing a **new** feature that doesn't yet exist in code (use the conversational eval hook),
or when the SRS module has not yet been installed (route to `sf update --add-modules srs` first).

### Running the drafter

```bash
sf srs draft --from codebase [--path <repo>]
```

`--path` defaults to the current working directory. The CLI walks the tree (honouring `.gitignore` and excluding `node_modules / dist / coverage / .git / .vitepress/cache`), runs every registered
scanner, and writes the result to stdout :

**Tuning the scan for noise-heavy repos.** CLI/library/template projects (SaaSFoundryAI itself, monorepos shipping `scaffolds/`, heavily-documented repos with large `docs/` trees) can drown the signal
under fixture code the scanners treat as production source. Two ways to opt out:

- **`.srsignore`** — a gitignore-style file at the scan root. Same syntax as `.gitignore`, additive to it.
- **`tools.srs.scan.exclude`** in `.saasfoundry.json` — a `string[]` of gitignore-style patterns applied on top of `.gitignore` + `.srsignore`.

```jsonc
// .saasfoundry.json
{
  "tools": {
    "srs": {
      "enabled": true,
      "backend": "notion",
      "scan": {
        "exclude": ["scaffolds/", "docs/", ".claude/"]
      }
    }
  }
}
```

Both layers stack. Use `.srsignore` for local/developer tuning (it stays out of other projects generated from this repo), and `tools.srs.scan.exclude` for project-wide defaults the whole team should
share.

Output example:

```jsonc
{
  "source": "codebase",
  "findings": [
    /* ScannerFinding[] */
  ]
}
```

Scanner kinds, clustering steps, DS/TC/NFR seeding rules, coverage-table template, and review-loop prompt shape live as structured data in [`data/clustering-rules.json`](data/clustering-rules.json).
Read that file once per drafting session — it is the source of truth. The JSON replaces prose that used to span ~180 lines of this SKILL.md.

Operational quick-reference (full detail in the JSON):

- **Five scanner kinds** (`endpoint`, `ui-flow`, `entity`, `test`, `doc-context`) — see `docs/srs/scanner-findings.md` for the JSON shape. These are stack-neutral concepts (see
  `data/clustering-rules.json`): `endpoint` = any invocable operation (HTTP route, RPC/Tauri command, CLI command, queue handler), not just a NestJS controller; `entity` = any persistent record, not
  just a Prisma model; `ui-flow` = any user-facing view, not just a React page.
- **Clustering**: work Epic-by-Epic, then FR-by-FR. Group by `area` — whatever structural unit the project uses (module, package, crate, feature folder), not a fixed `src/modules/` path. One Epic per
  coherent area, one FR per operation (or tight operation cluster).
- **Five-category seeding** (UR + FR + DS + TC + NFR): scanners surface raw material, the agent synthesises, the user validates before write. NFRs are always marked `priority: P3` and
  `target: '<proposed — needs human validation>'` until the reviewer accepts.
- **Untested endpoints** emit a TODO TC item so drift is auditable — never silently drop them.
- **Review loop**: one Epic per prompt, branches `[accept / edit / reject / skip-area]`. Never batch-accept. Never write without confirmation.

### Exit codes

`draft --from codebase` reuses the standard envelope :

| Code | Meaning                                                               |
| ---- | --------------------------------------------------------------------- |
| 0    | Success — findings emitted on stdout                                  |
| 2    | `--path` does not exist, is not a directory, or manifest is malformed |
| 3    | `tools.srs.backend` missing from the manifest                         |
| 4    | Unknown / invalid backend name                                        |
| 5    | Unexpected scanner runtime error                                      |

## Conversational eval hook (SUB-10)

When the project declares `tools.srs.enabled = true` in `.saasfoundry.json`, Claude interjects during conversation turns whose content looks like a new Software Requirement. There is no message parser
baked into the runtime — the "hook" is Claude reading the rules and self-invoking. The `sf-workflow` skill's SKILL.md references this section and stays out of the way.

Detection heuristics, confirmation prompt, patch shape, and v1 scope limits live as structured rules in [`scripts/detect-eval-signals.sh`](scripts/detect-eval-signals.sh). Two modes:

- `detect-eval-signals.sh --rules` — emits the full rules + patch shape as JSON. Read this once per session; it is the source of truth.
- `detect-eval-signals.sh --classify "<text>"` (or stdin) — crude regex prefilter over a turn, returns `{signal, confidence, target}`. Use it to cheap-skip trivial turns; the agent still has the final
  say on whether to fire.

Fire at most **once per conversation turn**. On a signal hit, propose a diff in plain text, wait for `accept / edit / reject`, and — on accept — pipe the patch through `sf srs apply-update`. v1 is
ADD-only and appends to an "Added …" heading on the target page; the reviewer folds it back into the canonical section during the next human SRS review.

After any change to the rules or classifier, run a short dogfood session: 5 utterances (one per signal row + one trivial control), confirm the hook fires exactly on the four signals and skips the
trivial one.

### Auto-fire via Claude Code `UserPromptSubmit` hook (#316)

The classifier above is also wired into Claude Code's `UserPromptSubmit` event so the agent never has to remember to self-invoke. The shell hook
[`scripts/srs-intent-hook.sh`](scripts/srs-intent-hook.sh) runs on every prompt the user sends, pipes it through `detect-eval-signals.sh --classify`, and emits a `<system-reminder>` only when the
classifier returns `signal ∈ {ur, fr, ds, tc, revision}` AND `confidence != "low"`. The reminder points the agent at this skill — it does not act on its own.

The hook is registered under the `UserPromptSubmit` block of `.claude/settings.json` in every scaffold (root, api blueprint, web blueprint, monorepo overlay). It always exits 0 (`UserPromptSubmit`
hooks are non-blocking by contract) and degrades silently when prerequisites are missing (no `jq`, classifier removed, garbage stdin).

**Three opt-out paths**, in priority order:

1. **Per-shell, ephemeral** — `export SF_DISABLE_SRS_HOOK=1`. Useful when you're doing a long exploration / debugging session and don't want the reminders. Survives until the shell exits.
2. **Per-project, persistent** — set `tools.srs.intentDetectorEnabled = false` in `.saasfoundry.json`. The classifier still runs (other skills may use it) but the auto-fire is suppressed.
3. **Per-project, full kill-switch** — set `tools.srs.enabled = false` in `.saasfoundry.json`. Disables both the auto-fire AND the conversational eval flow above.

A malformed manifest, a missing manifest, or a manifest with `tools.srs.backend` set but no `enabled` flag all **fail open** — the hook fires. This is intentional: the only way to silence it is an
explicit opt-out, so a botched config doesn't leave the user wondering why the SRS guidance disappeared.

Performance budget: ≤250ms p95 in a real shell (mostly classifier regex + jq parsing — no network, no node). Regression-tested in `src/__tests__/unit/skill/srs-intent-hook.spec.ts`.

## How other skills hand off to `sf-srs`

- **`sf-workflow`** — when a ticket enters `Backlog` with the `srs:drafting` label, the workflow skill calls `sf srs draft` (or the appropriate action) and stays out of the way otherwise
- **`sf-tool-*`** skills expose a `SrsAdapter` implementation but never call `sf-srs` themselves. Dispatch is one-way : `sf-srs` → `sf-tool-<backend>` via `createSrsAdapter()`

## Critical rules

1. **Never import a concrete adapter class** from within `sf-srs` — always go through `createSrsAdapter()` in `src/srs/`
2. **Never hardcode backend branches** (`if backend === 'notion'`) ; the registry in `src/srs/` is the only place that knows about concrete backends
3. **Never call `gh`, the Notion SDK, or any tool-specific CLI directly** ; delegate through the adapter or through `sf-tool-<backend>`
4. **Every new SUB under #174 ships its artefact in the directory map above** — do not invent new locations

## Lessons learned — #203 capstone dogfood (2026-04-23)

Running the full `sf srs` chain end-to-end on SaaSFoundryAI itself surfaced 12 gaps consolidated under parent #235. Key takeaways agents should know about:

- **Matcher covers all finding kinds (#236 — landed).** `matcher.ts` now counts `endpoint`, `ui-flow`, `entity`, and `test` findings when scoring an FR. Frontend-only, data-only, and test-driven FRs
  no longer score 0 purely because there is no endpoint. FR authors can further steer the match via `implementationKind` / `areaHints` (L2 hints) and the skill gets a `--review-packet` JSON for L3 AI
  refinement. See "Three-layer matcher" above.
- **Epics land directly under rootPage (#237 — landed).** Earlier bootstrap inserted a `User flows & Specifications` category between rootPage and the Epics, which broke eval (`FR.total = 0` without
  `--root-page <category.id>`). The category layer is now removed — `bootstrapSrs` creates only the project root, Epics are its direct children, and eval works on the standard manifest with no
  override.
- **Scan from CWD ratisse scaffolds/ + docs/ (#238 — landed).** On CLI / library projects, run `draft --from codebase --path src` — a full-repo scan drowns real findings with template code. A
  `.srsignore` file (glob syntax, loaded from `scanRoot`) further narrows what the walker visits.
- **Bootstrap persists `NOTION_API_TOKEN` to `.env` (#239 — landed).** `sf update --add-modules srs` now writes the token to `.env` (gitignored) so non-interactive / Claude bash sessions pick it up
  automatically. No more `set -a && source .env && set +a` dance in new projects.
- **Preconditions first — no silent re-install (#240 — landed).** Before asking the user scope questions (backend choice, Notion parent page, etc.), read `.saasfoundry.json` — the answers are almost
  always already there. `sf update --add-modules srs` on an already-installed module now refuses the re-install instead of silently re-bootstrapping and duplicating Notion pages.
- **`write-srs` supports single-pass Epic + FR writes via logical IDs (#245 — landed).** Mix Epics (with `epic.id`) and FRs (with `parentEpicId`) in one spec — `write-srs` resolves the references as
  it goes. `parentEpicPageId` remains as an escape hatch for incremental writes against pre-existing Epics.
- **FR page-title separator is the em-dash (#246 — landed).** The canonical title shape is `FR-AREA-NN — Title` using U+2014 wrapped in spaces — the shared constant `FR_TITLE_SEPARATOR` lives in
  `src/builders/srs/constants.ts` and is imported by both the page renderer and the inventory parser. Do not substitute an ASCII hyphen. See also Contributor notes below.
- **SRS completeness is now five-category (#247 — landed).** Historically DS / TC / NFR were not generated — only UR+FR. The five-category shape (UR+FR+DS+TC+NFR) is seeded by the drafter, reusing the
  L1+L2+L3 matcher architecture — see the "Seeding DS / TC / NFR" section above for the full mapping.
- **`sf srs` has a first-class CLI surface (#241 — landed).** Prefer `sf srs eval` / `sf srs draft` / `sf srs write` / `sf srs spawn` / `sf srs apply-update` over calling the internal TS entrypoints;
  the CLI layer wires logging, manifest resolution, and backend selection for you.
- **`sf status` is the preflight (#242 — landed).** Run `sf status --claude-friendly --no-network` (auto-injected by the SessionStart hook, see #243) before proposing work — it reports manifest
  version, installed modules, SRS backend, git cleanliness, and blocking preconditions. Do not re-derive these from scratch.
- **SessionStart hook preloads preconditions (#243 — landed).** `.claude/settings.json` fires `sf status --claude-friendly --no-network` on session start so the manifest + precondition summary is in
  context from turn 1. If you see stale output, re-run the command; do not ask the user to re-describe their setup.
- **sf-srs skill triggers split install vs draft (#244 — landed).** The skill no longer conflates "bootstrap the Notion backend" with "draft SRS content" — install/configuration is owned by
  `sf update --add-modules srs`, the skill handles drafting / eval / writes on an already-installed backend. Route users to the install CLI when the backend is not configured yet.

Artefacts from the capstone (kept for reference):

- `.srs-audit/follow-ups.md` — full lessons-learned analysis
- `.srs-audit/baseline-report-fixed-root.json` — first eval baseline (score 32, all FRs flagged fr-without-code due to #236)

## Contributor notes

- **FR page title format.** The canonical separator between the FR id and the title is the em-dash character (U+2014) wrapped in spaces: `FR-AREA-NN — Title`. It lives as the shared constant
  `FR_TITLE_SEPARATOR` in `src/builders/srs/constants.ts`, imported by both the page renderer (`src/builders/srs/templates/pages/fr.tpl.ts`) and the inventory parser (`src/srs/eval/inventory.ts`). Do
  not substitute an ASCII hyphen (U+002D) — it round-trips through Notion as the same glyph visually but breaks the byte-level identity the tests enforce. If you change the separator, update the
  constant in one place and both sites follow.

## Where this sits in the zero-to-project flow

This skill carries **phase 4, _write the SRS_** of the flow a user walks when they arrive with a POC and no project. The map — every phase, its entry, its checkable exit, and how to resume mid-way —
lives in the `tool-saasfoundry` skill under "The zero-to-project flow".

It starts from a manifest that already declares the backend and from the intake record produced by the challenge phase, and it ends when pages exist under the SRS root page. It never runs before phase
3: the backend it writes to is declared in `.saasfoundry.json`, which the setup creates.

On a resumed session, run `tool-saasfoundry`'s `scripts/recap.sh` before assuming anything: it reads the phase from the manifest and the board, never from chat history.
