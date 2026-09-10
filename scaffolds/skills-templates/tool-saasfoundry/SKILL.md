---
name: tool-saasfoundry
description: >-
  Use when the user wants to scaffold a new SaaSFoundryAI project, add or remove
  modules in an existing SaaSFoundryAI project, check project state or installed
  modules, file a module request, report a CLI or scaffold bug, or vote on
  community proposals. Triggers on keywords and phrases like "saasfoundry",
  "sf new", "sf update", "scaffold a SaaS", "add a module", "update my
  SaaSFoundryAI project", ".saasfoundry.json", "file a SaaSFoundryAI bug", or
  "vote on SaaSFoundryAI modules". Always orchestrates the `sf` CLI in
  non-interactive mode — never runs the interactive Inquirer prompts itself.
---

# tool-saasfoundry

Help the user scaffold, evolve, and give feedback on SaaSFoundryAI projects by orchestrating the `sf` CLI. Never bypass the CLI with direct file generation — it is the source of truth for blueprints, overlays, modules, and workflow configuration.

## When to activate

Activate on explicit SaaSFoundryAI intent:

- "scaffold a SaaS / SaaS project / Node+React stack with postgres"
- "I want to start a new SaaSFoundryAI project"
- **"I already have a POC / a prototype / some code and I want to start properly"** → the POC intake runs first (see below)
- "add the email / storage / analytics module"
- "update my SaaSFoundryAI project"
- "what modules do I have?" / "am I up to date?" / "what's in `.saasfoundry.json`?"
- "file a module request" / "report a SaaSFoundryAI bug" / "vote on roadmap"
- **Add/build/implement verbs inside a SaaSFoundryAI project** — "I want to add file uploads", "let's build an email flow", "I need to track usage" → the skill runs the anti-reinvention guardrail (see below) *before* letting the user custom-code.
- **Explicit feedback intent** — "file a module request for X", "I want to request Y", "this should be a first-party module" → the skill runs the Feedback — Module Request scorecard (see below) *before* calling `sf feedback request`.

Do NOT activate on:

- Generic Node.js / React / NestJS questions unrelated to SaaSFoundryAI
- Unrelated scaffolding tools (`create-next-app`, `degit`, `nx`, …)
- Questions about someone else's generated project where no `.saasfoundry.json` can be found

## CLI contract

The skill invokes the `sf` CLI exclusively in **non-interactive mode**:

- Scaffolding: `sf new --non-interactive --name <name> --structure <mono|multi> --apps <all|backend|frontend> [flags…]`
- Module updates: `sf update --non-interactive --add <m1,m2> --remove <m3> [--dry-run]`
- Catalogue lookups: `sf modules list --json` / `sf modules info <slug> --json` / `sf modules match <query> --json`
- Skill lifecycle: `sf skill install [--project]` / `sf skill update` / `sf skill uninstall`
- Feedback loop: `sf feedback request <name>` / `sf feedback bug --source cli|scaffold` / `sf feedback list` / `sf feedback vote --list` / `sf feedback vote <n> up|down|comment`

Before mutating, always prefer `--dry-run` where available (notably `sf update --dry-run`) to preview the plan for the user.

## Output language

Everything you write into the project — SRS pages, tickets and their comments, code comments, commit messages — follows the `language` block of `.saasfoundry.json`, which defaults to English on all
three surfaces (`srs`, `tickets`, `codeComments`). `sf status --claude-friendly` prints the resolved values.

**Never take the language of the conversation as the signal.** Talking with the user in French does not make the artefacts French.

## Available commands

| User intent | CLI command | Notes |
| --- | --- | --- |
| Read an existing POC | `scripts/read-poc.sh <dir>` | Read-only. Decides `recognisable` — never override it |
| File a POC into `POC/` | `scripts/plan-poc-move.sh` then `scripts/move-poc.sh <dir> --confirm` | Plan first, always. Nothing moves without `--confirm` |
| Challenge from what the POC showed | `scripts/plan-challenge.sh` then `scripts/record-intake.sh --out <path>` | Seeds only — never invent a question. An unseeded answer is refused |
| Resume a flow in progress | `scripts/recap.sh [workspace]` | Reads state, never chat history. Run it first on any resumed session |
| Frame what a release contains | `scripts/plan-milestone.sh` then `workflow-cli.sh milestone create/assign/associate` | Proposes only from evidence; never invents a version number |
| Start a new project | `sf new --non-interactive …` | Gather intent via conversation (Phase 2C) |
| Add / remove modules | `sf update --non-interactive --add … --remove …` | Consult `sf modules list --json` first (Phase 2D) |
| Inspect project state | Read `.saasfoundry.json` + `sf modules list --json` | Pure read, no mutation (Phase 2E) |
| File a module request | `sf feedback request "<slug>" --description "…"` | Checks dedup automatically |
| Report a bug | `sf feedback bug --source cli\|scaffold --title "…" --description "…" [--auto-repro]` | `--auto-repro` embeds `.saasfoundry.json` |
| List open feedback | `sf feedback list [--status open\|closed\|all] [--mine] [--json]` | 3-label fan-out: module-request, cli-bug, scaffold-bug |
| Rank module requests | `sf feedback vote --list [--limit N] [--stack-filter <term>]` | Ranked by 👍 |
| Cast a vote | `sf feedback vote <n> up\|down` | Recorded in `~/.saasfoundry/preferences.json` |
| Comment on a request | `sf feedback vote <n> comment --comment "<body>"` | No vote recorded, just a comment |

## Bootstrap

Before running user-facing SaaSFoundryAI commands, the skill verifies the environment using bundled helper scripts under `~/.claude/skills/tool-saasfoundry/scripts/`:

| Script | When to invoke | Contract |
| --- | --- | --- |
| `detect-env.sh` | Once per session, or whenever the skill needs to choose between `sf` and `npx saasfoundryai-cli` | Prints a JSON snapshot on stdout (`os`, `nodeVersion`, `ghInstalled`, `ghAuthed`, `sfGlobalInstalled`). Always exits 0. |
| `bootstrap-gh.sh` | Before any GitHub-dependent command (`sf feedback …`, voting, issue listing) | Exits 0 silently when `gh` is installed and authenticated. Exits 1 with guided install/login instructions on stderr otherwise. |
| `bootstrap-cli.sh` | Before any `sf` invocation | Prints the exact command token to use (`sf`, `saasfoundryai-cli`, or `npx saasfoundryai-cli`) on stdout. Always exits 0. |

Guidelines:

- **Run `detect-env.sh` first** when the conversation starts to cache environment facts (OS, node version, CLI presence) for the rest of the turn
- **Always gate `gh`-backed flows behind `bootstrap-gh.sh`** — on failure, surface its stderr verbatim to the user and stop rather than retrying blindly
- **Resolve the CLI invocation via `bootstrap-cli.sh`** — never hardcode `sf` in examples if the user might be running via `npx`

## The zero-to-project flow

The sections that follow describe individual capabilities. This one is the order they run in. A user handed the install line and dropped into a folder gets an *experience* only if the phases are sequenced; otherwise they get a set of tools and have to be their own project manager.

```
read the POC  →  challenge the intent  →  decide the setup  →  write the SRS
                                                                     ↓
                         features  ←  base setup  ←  create the tickets
```

### The phases

Each phase starts from what the previous one produced and ends on something **checkable** — not a feeling that it went well.

| # | Phase | Starts from | Ends on | Carried by |
| --- | --- | --- | --- | --- |
| 1 | Read the code | a folder holding code | a reading the user confirmed — and, on `full` only, the POC filed into `POC/` | `read-poc.sh`, then on `full` `plan-poc-move.sh` → `move-poc.sh --confirm` |
| 2 | Challenge the intent | the confirmed reading | `intake.json` holding answers traced to observations | `plan-challenge.sh` → `record-intake.sh` |
| 3 | Decide the setup | the intake record | a project directory holding `.saasfoundry.json` | `plan-new.sh` → the `sf new` command it prints |
| 4 | Write the SRS | the manifest and the intake | pages under the SRS root page | the **sf-srs** skill |
| 5 | Create the tickets | an SRS carrying FRs | the board carries tickets | `srs-cli.sh spawn` against a version page |
| 6 | Base setup | tickets on the board | the first ticket past Backlog | the **sf-workflow** skill |
| 7 | Features | a working base | — | the **sf-workflow** skill, one ticket at a time |

**Phase 3 comes before phase 4, and that is not an accident.** The SRS step needs a configured backend, and the backend is declared in the manifest — which only exists once the setup has run.

### Resuming — always start here

A user who closes the session and comes back must be told where they are. **Never reconstruct the phase from what was said earlier**: chat history is the one source that does not survive, and it is the one that lies most confidently.

```bash
scripts/recap.sh [workspace] [--no-network]
```

It reads `POC/`, `intake.json` and the manifest from disk, and takes the preconditions from `sf status --json` rather than re-deriving them. Then:

- **`current`** — the first phase not known to be done, and the command that carries it
- **`state`** per phase — `done`, `pending`, `unknown`, or `not-applicable`
- **`blockers`** — phases at or after the current one whose precondition fails, each carrying its own remediation

Three things it does that matter more than they look:

- **`unknown` is not `pending`.** Offline, the SRS and the board cannot be inspected, so they are reported as unverified rather than as undone — and the walk stops there. Claiming to be past a phase nobody checked is how written work gets written twice.
- **`not-applicable` is not `pending`.** A project with a manifest and no `POC/` never had a POC. Phases 1 and 2 did not apply to it; they are not outstanding work, and it must not be sent back to read something that never existed.
- **An occupied workspace with no manifest is `unknown`, not `pending`.** Code is there and nothing has been decided yet, so phases 1 and 2 cannot be read off disk: whether that code is a POC to file into `POC/` or a project the user keeps is the **profile question**, and `recap` prints that question instead of the move command. Handing `move-poc.sh --confirm` to someone building on an existing repository relocates everything they have, and the POC intake's warning applies with full force — there is often no remote and no history to restore from.
- **A blocked phase routes rather than fails.** The remediation printed is the one `sf status` already carries — `sf update --add-modules srs`, `sf workflow use <template>`, `sf new`. Route the user there and stop; never walk into a phase whose precondition is unmet and improvise around the error.

### Ask, do not assume

Three decisions are the user's, at the phase that needs them, and none of them has a safe default:

| Decision | Phase | Why it cannot be guessed |
| --- | --- | --- |
| `profile` | 3 | Getting it wrong scaffolds a full stack over an existing repository |
| SRS backend | 4 | It decides where every specification page is written, in someone else's workspace |
| workflow tool | 5 | It decides where every ticket lands |

When the manifest already answers one of them, **it is answered** — read it, do not re-ask. That is the whole reason the manifest is the source of truth.

### Never do these

- **Never skip a phase because its output could be improvised.** Writing an SRS without the intake record produces a specification about nothing in particular, which is what this flow exists to prevent.
- **Never report a phase from memory.** Run `recap.sh`. A session that "remembers" being at phase 4 and is actually at phase 2 will write a specification over an intake that was never done.
- **Never continue past a blocker.** Route to the remediation and stop.

## Discovery: code that is already here

Before anything else runs in a folder that already holds code, **that code has to be read**. This is the first flow of the zero-to-project path, and it runs *before* the `sf new` discovery below.

Reading and moving are two steps, and only the first one always applies:

| The user's answer to the profile question | Read | Move |
| --- | --- | --- |
| *"it's a throwaway POC, I'll rewrite it"* → `full` | yes | **yes** — into `POC/`, so the scaffold lands beside the experiment |
| *"it exists and I'm building on it"* → `harness` | yes | **never** — `sf new --profile harness` installs in place and creates no directory |

`read-poc.sh` reads **any** codebase and never writes: *"This script NEVER writes, moves or deletes anything. The move is a separate, confirmed step."* So the same reading serves both, and the move is what the profile decides.

The name says POC for historical reasons. It is not one — do not conclude from it that a user's live project is out of scope, and do not skip the reading because "this isn't a POC".

### When this flow triggers

- The starting-point question is answered with "it's a POC", "a prototype", "something I threw together"
- The user says they have some code but want to start properly
- **The user has a real project and wants the AI layer on it** — read it, then stop before the move
- The folder `sf new` is about to run in already holds files
- `recap.sh` reports phases 1–2 as `unknown` because the folder is occupied and nothing has been decided — ask the profile question, then come here

### Why it exists

`sf new --profile full` creates `<projectName>/` under the current folder and scaffolds into it. Run over a POC, the experiment and the generated project become siblings in a folder nobody organised — and the POC gets extended into production by accident, because it is the code that is already there.

The intake makes the POC a **reference**: it moves into `POC/`, the project is scaffolded beside it, and the boundary is visible from the first day.

```
my-thing/                  before          my-thing/                  after
├── src/                                   ├── POC/
├── package.json                           │   ├── src/
└── notes.md                               │   ├── package.json
                                           │   └── notes.md
                                           └── my-project/     ← sf new
```

### Workflow

1. **Read it** — `scripts/read-poc.sh <dir>`. Never list the folder and infer: the script decides whether there is anything to read, and that decision is not yours to override.
2. **Say what it is** — turn the evidence into a reading: what it does, what it proves, which parts are the experiment and which are scaffolding. Every claim must trace back to something in the report — a manifest, the README prose, the entry points, the dependencies.
   - **When `recognisable` is `false`, report the reason and do not guess.** A folder of loose files has no purpose to read. Say what is there, say why it cannot be read, and let the user tell you. This is the failure mode the whole flow exists to prevent.
3. **Confirm the reading** — show it and let the user correct it. Their correction is the reading; yours was a proposal.
4. **Propose the move** — `scripts/read-poc.sh <dir> | scripts/plan-poc-move.sh`. Show the entries that move, the resulting tree, and any warnings. If the plan refuses, relay the refusal verbatim and stop — every refusal guards work that exists in no other copy.
5. **Move only on approval** — `scripts/move-poc.sh <dir> --confirm`. Without `--confirm` it is a dry run that changes nothing, which is also the right thing to run when the user asks "what would this do?".
6. **Then scaffold** — run the `sf new` discovery below from the same folder. The project directory lands beside `POC/` on its own, because that is what `sf new` already does.

**Steps 4–6 are the `full` path only.** On `harness`, the reading is the end of it: go straight to the challenge, then to `sf new --profile harness` in place.

### The `harness` path, end to end

```bash
# 1. Read what is there. Nothing is written.
scripts/read-poc.sh .

# 2. Confirm the reading with the user, then seed the challenge from it.
scripts/read-poc.sh . | scripts/plan-challenge.sh
scripts/record-intake.sh --out intake.json

# 3. Install the AI layer in place. No directory is created, nothing moves.
sf new --profile harness --non-interactive ...
```

`plan-challenge` takes a reading, not a `POC/` folder — it requires `report.inventory` and nothing more. So the questions it seeds come from **this project's** manifest, README and entry points, which is the whole difference between a specification about this product and a generic intake any project would get.

**Never run `plan-poc-move.sh` on this path.** There is nothing to move, and offering it to someone building on an existing repository is how the flow proposes to relocate everything they have.

### Report shape (from `read-poc.sh`)

| Field | Meaning |
| --- | --- |
| `recognisable` | Whether there is enough here to read a purpose from. **`false` is a finding, not an error** — the script still exits 0 |
| `reason` | Why it is not recognisable. Say this to the user, in these terms |
| `anchors` | What makes it readable: a manifest, a README with prose, source files with authored company |
| `stacks`, `manifests` | Detected stacks and the manifest files that prove them |
| `package` | `name`, `description`, `scripts`, `dependencies` — the closest thing to a stated intent |
| `readme.firstParagraph` | The first real paragraph, headings and badges skipped |
| `entryPoints`, `tests` | Where it starts, and whether anyone tested it |
| `git` | `ownRepo:false` with `isRepo:true` means the POC sits inside somebody else's repository |
| `inventory` | Counts, top-level entries, generated directories seen but not walked |

### Plan shape (from `plan-poc-move.sh`)

`moves` lists whole top-level entries, dotfiles and `.git` included — that is what makes the move reversible. `refused` with `refusals` means stop. `warnings` never block. `undo` says how to reverse it.

The repository travels with its files: git resolves tracked paths relative to its own root, so a POC that had a `.git` keeps a clean tree and its full history at the new location, with nothing rewritten.

### Output language

The reading is an artefact, so it is written in the manifest's output language — and at intake time there is no manifest yet, which resolves it to the default, **English**. The conversation's language is not the signal here any more than it is anywhere else.

### Never do these

- **Never move anything before the user has approved the plan.** The POC is normally local-only: no remote, often no history. There is no copy to restore from.
- **Never invent a purpose when `recognisable` is `false`.** Report the reason instead. A confident-sounding reading of a folder that cannot be read is worse than saying you cannot read it.
- **Never work around a refusal.** Do not pick a different destination to dodge "already exists", do not run the intake from a parent folder to dodge "inside another repository". Relay it and let the user decide.
- **Never run `sf new` inside the POC folder.** The whole point is that they end up beside each other. This applies to `full`; on `harness` there is no POC folder and `sf new` runs exactly where the code is.
- **Never propose the move before the profile question is answered.** Reading is always safe; moving is only correct for a POC the user is rewriting. Getting it backwards relocates a live project that often has no remote and no history to restore from.
- **Never delete anything.** The intake only ever relocates. If something looks like it should go, say so and leave it.

## Discovery: challenge what the code revealed

Runs after the POC intake and before `sf new`. It is the step that makes the rest worth anything: once the POC has been read, you know things the user has not said, and those things are questions only someone who read the code could ask.

Not *"what do you want"*. **"Your POC does X — does that mean Y?"**

### When this flow triggers

- The POC intake has produced a reading and the user has confirmed it
- The user is about to describe what they want built

### What it replaces

The generic intake: a list of questions any project would get, answered vaguely, producing a specification that says nothing specific about this product. The list feels thorough and produces nothing, because none of it came from looking.

### Workflow

1. **Seed from the reading** — `scripts/read-poc.sh <dir> | scripts/plan-challenge.sh`. A seed is an observation plus the dimension it opens up. **You may refine a seed, merge two, or drop one. You may not invent one.**
2. **When `revealing` is `false`, say so** — the POC reveals too little to challenge. Tell the user that, in the terms `reason` gives, and ask directly instead. Padding it out with questions any project would get is the exact failure this flow exists to prevent.
3. **Ask, one at a time** — turn each seed into a real question that names its observation. "Your POC processes audio with a local model rather than an API — was that a privacy decision that has to hold in the product, or just the quickest thing to get working?" The observation is what makes the question worth answering; a question without it is the generic intake wearing a costume.
4. **Read `notes`** — they say what could not be probed. A python POC yields fewer seeds because only `package.json` is parsed today; that is a limit of the reading, not a verdict on the POC, and the user deserves to hear the difference.
5. **Record the answers** — pipe `{seeds, answers, root, notes}` into `scripts/record-intake.sh --out <workspace>/intake.json`. Each answer carries the `dimension` of the seed it came from. **An answer that references no seed is refused**, which is how the link to the observation survives into the artefact instead of only living in the conversation.
6. **Carry it into the SRS step** — the record is what the SRS drafting reads. Nothing in it gets asked twice.

### Seed shape (from `plan-challenge.sh`)

| Field | Meaning |
| --- | --- |
| `revealing` | Whether there is enough to build a challenge from. `false` is a finding — the script still exits 0 |
| `reason` | Why it reveals too little. Say this, in these terms |
| `seeds[].observation` | A fact quoted from the reading — this is what the question must name |
| `seeds[].evidence` | The report field it came from, so the claim is checkable |
| `seeds[].probe` | The opening. You write the question |
| `cap` / `considered` / `dropped` | The bound, and what did not fit. **`dropped > 0` means questions were left out** — say so if the conversation goes deep |
| `notes` | What could not be probed, and why |

### Never do these

- **Never ask a question that names no observation.** If it does not come from a seed, it is not part of this step. It may still be a good question — it belongs in the SRS conversation that follows.
- **Never manufacture a challenge from a thin POC.** `revealing: false` means ask directly and say why. An invented implication is worse than an honest blank, because the user will answer it as though it were grounded.
- **Never run through all the seeds mechanically.** The cap is an upper bound, not a quota. Two good questions beat six dutiful ones, and the user's answer to the first often kills the third.
- **Never re-ask what the record already holds.** The intake exists so the SRS step inherits the answers instead of running the same conversation again.

## Discovery: `sf new`

When the user wants to start a new SaaSFoundryAI project, the skill replaces the CLI's Inquirer prompts with a conversational discovery flow. The goal is to produce a complete **intent** object that `plan-new.sh` can translate into a single `sf new --non-interactive …` command. The intent schema and flag mapping are documented in `reference/new-flags.json` — consult it before inventing field names.

### Three discovery modes

Pick the mode from the user's first message, not from a menu:

| Mode | When it fits | Flow |
| --- | --- | --- |
| **Guided** *(default)* | User says "I want a new SaaS project" with little detail, or explicitly asks for help choosing | Ask one question at a time, explain each choice briefly, recommend based on the table below, allow bail-out |
| **Express** | User gives enough signal upfront ("scaffold a monorepo with mailersend and analytics") | Infer the intent, echo it back as a plan, ask for single-shot validation |
| **Expert** | User pastes a full or partial `sf new --non-interactive …` command | Pass it through verbatim after sanity-checking flag names against the manifest |

### Discovery workflow

1. **Bootstrap** — run `bootstrap-cli.sh` to resolve the invocation token (`sf` / `npx saasfoundryai-cli`). Cache for the rest of the turn.
1. **Establish the starting point FIRST** — before anything else, determine `profile`. It is the CLI's first question and it gates which later questions apply at all. Ask plainly: *does a codebase already exist here that you intend to keep?*
   - **Yes, and I'm building on it** → `harness`. Deposits the AI layer onto the existing repository. **No stack is scaffolded and no project directory is created.** Getting this wrong scaffolds a full stack over the user's project.
   - **No, or it's a throwaway POC I'll rewrite** → `full`. If there *is* a POC in the folder, run the **POC intake above first** — read it, then file it into `POC/` — so the scaffold lands
     beside the experiment instead of tangled with it.
   - **I want the stack without the AI layer** → `stack` (rare — confirm it is deliberate)

   On `harness`, skip every stack question (database, storage, email, installable app): there is nothing to scaffold.
2. **Gather intent** — build a JSON object matching the `fields` in `reference/new-flags.json`. Only include fields the user has either stated or confirmed via a recommendation.
3. **Materialize the plan** — pipe the intent JSON into `scripts/plan-new.sh`. It returns the full command on stdout or exits non-zero with a validation message on stderr.
4. **Present the plan** — show the command *and* a short human summary built from the intent (structure, database, modules, post-setup apps). Never run the command yet.
5. **Confirm and execute** — wait for explicit user approval before running. If the user tweaks a field, rebuild the intent and re-run `plan-new.sh` rather than editing the command string by hand.

### Intent schema (summary)

Full specification: `reference/new-flags.json`. Essentials:

- **Always required:** `projectName` (kebab-case), `structure` (`monorepo` | `multirepo`)
- **Recommended to set explicitly:** `mainBranch`, `dbSetup`, `emailService`, `analytics`
- **Only set when user opts in:** `advancedSkills` (CSV of `context7`, `atlassian`, `notion`, `figma`) and their credential fields; `agents` (CSV of registered coding-tool IDs) when the user wants an explicit multi-agent declaration
- **Secrets** (marked `"secret": true` in the manifest): never echo them back, never log them

### Recommendation rules

Use these defaults when the user has no strong opinion:

| Dimension | Default | Condition to override |
| --- | --- | --- |
| `profile` | `full` | Use `harness` as soon as the user has an existing codebase they are keeping — this is the highest-consequence field in the intent |
| `pwa` | `true` | Leave on: invisible to anyone who does not install the app, no credentials, no external service. Only `false` when the product should deliberately not be installable |
| `structure` | `monorepo` | Recommend `multirepo` only when backend/frontend are owned by separate teams or deploy on separate schedules |
| `mainBranch` | `main` | Only `master` when the user's org standard says so |
| `dbSetup` | `docker` | Recommend `credentials` for staging/prod stacks, `manual` when DB is provisioned elsewhere |
| `emailService` | `none` | Recommend `mailersend` as soon as the product needs transactional email (password reset, invites, receipts) |
| `analytics` | `false` | Recommend `true` only when metrics are on the roadmap from day one — otherwise `sf update --add-modules analytics` later is a one-liner |
| `startApps` / `startServices` | `none` / `false` | Offer to start services when the user says they want to "try it immediately" |

The full rationale for each recommendation is in the `recommendations` block of `reference/new-flags.json` — lean on it when the user asks "why?".

### Never do these

- **Don't fabricate flags.** Every flag you pass must exist in the manifest's `fields` section.
- **Don't ask for every field in Guided mode.** Skip fields whose defaults are obvious for the user's context (e.g. don't ask about `mainBranch` for a hobby project).
- **Don't re-serialize the plan by hand.** Always round-trip through `plan-new.sh` so the command stays consistent with the manifest.
- **Don't stash secrets in the intent you echo back.** Collect them, pass them through to `plan-new.sh`, but redact in any user-facing summary.

## Discovery: `sf update`

When the user wants to evolve an existing SaaSFoundryAI project (add a module, apply template updates), the skill replaces the CLI's Inquirer prompts with the same conversational flow pattern as `sf new`. The intent is produced as a JSON object, materialized into a single `sf update --non-interactive …` command via `plan-update.sh`. The intent schema is documented in `reference/update-flags.json`.

> **Scope note** — `sf update` is **add-only** today. Module removal is not yet supported by the CLI; if the user asks to remove a module, point them at `sf feedback request` to track the request and keep the conversation unblocked.

### Three discovery modes

Same triage as `sf new`:

| Mode | When it fits | Flow |
| --- | --- | --- |
| **Guided** *(default)* | User says "I want to add email" or "what's missing from my project?" | Read `.saasfoundry.json` + catalogue, recommend 1–2 modules with rationale, ask one question at a time |
| **Express** | User says exactly what they want: "add email and analytics" | Build intent, echo back as a plan, single-shot confirmation |
| **Expert** | User pastes a full or partial `sf update --non-interactive …` command | Pass through after sanity-checking flag names + module values against the manifest |

### Discovery workflow

1. **Bootstrap** — run `bootstrap-cli.sh` to resolve the invocation token. Cache for the rest of the turn.
2. **Read project state** — parse `.saasfoundry.json` to know what modules are already installed. Pass that list in the intent as `alreadyInstalled` so `plan-update.sh` can reject silent no-ops.
3. **Consult the catalogue** — `sf modules list --json` for the full list, `sf modules info <slug> --json` for drill-down. Never invent module names.
4. **Gather intent** — build a JSON object matching `fields` in `reference/update-flags.json`. Only include fields the user has confirmed.
5. **Dry-run first** — set `dryRun: true` in the intent and show the output to the user. Only rebuild the intent with `dryRun: false` after explicit approval.
6. **Materialize the plan** — pipe the intent JSON into `scripts/plan-update.sh`. It emits the command on stdout or exits non-zero with a validation message on stderr.
7. **Present and confirm** — show the command + a human summary of what will be added + which credentials were captured (redact secret values). Wait for approval before running.

### Intent schema (summary)

Full specification: `reference/update-flags.json`. Essentials:

- **`addModules`** (CSV) — values must match `sf modules list --json`; collision with `alreadyInstalled` is an error, not a warning
- **`dryRun`** (boolean) — recommend `true` for the first round; flip to `false` only after user approves the plan
- **`conflictStrategy`** (enum: `keep` | `replace` | `save-new`) — default `save-new`; only change if the user has strong preferences about their local edits
- **Credential pass-throughs** — only collect the ones required by the modules being added (`mailersend*` when adding email, `s3*` when adding storage, `*ApiToken` when adding advanced skills). All `secret: true` fields must be redacted in any echo-back

### Recommendation rules

| Dimension | Default | Condition to override |
| --- | --- | --- |
| `dryRun` | `true` on first run | Skip only when the user explicitly says "just do it" and the change is small |
| `conflictStrategy` | `save-new` | Recommend `keep` when the user has significant local edits they don't want touched; `replace` only when they ask for "latest upstream, overwrite mine" |
| Which modules to propose | None unless user asks | If the user asks "what should I add next?", consult `recommendations.modules` in the manifest for guidance anchored to product needs |

### Never do these

- **Don't propose a module already in `.saasfoundry.json`.** Check `alreadyInstalled` before building the intent; suggesting a silent no-op erodes user trust.
- **Don't skip the dry-run round** unless the user explicitly waives it.
- **Don't suggest module removal as if it were supported.** Redirect to `sf feedback request` and note the limitation.
- **Don't fabricate module names.** Every value in `addModules` must exist in `sf modules list --json`.
- **Don't echo credentials.** Collect them, pass to `plan-update.sh`, redact in any user-facing summary.

## Project Awareness

Project Awareness is the read-only surface of the skill. When the user asks a question about the *current* state of their SaaSFoundryAI project, the skill answers from a consolidated snapshot — it never writes, never installs, never mutates anything.

### Supported questions

| User asks | How the skill answers |
| --- | --- |
| "What's my SaaSFoundryAI version? Am I up to date?" | `report.project.cliVersion` + `report.upToDate`. If `false`, list `report.modules.obsolete` with their `minCliVersion` and recommend `sf skill update` + `sf update`. |
| "What modules do I have?" | `report.modules.installed` — read verbatim. If the user wants details on a specific one, run `sf modules info <slug> --json`. |
| "What would `sf update` do right now?" | Do **not** answer from the snapshot alone. Run `sf update --dry-run --non-interactive` and show the plan (this is a CLI call, not a mutation). |
| "Are there new modules since my install?" | `report.modules.newlyAvailable` — list with one-line descriptions from the catalogue (`sf modules info <name> --json` for the `description` field). |
| "Where was this project generated / when?" | `report.project.generatedAt` + `report.project.structure` + `report.project.name`. |

### Workflow

1. **Bootstrap** — run `bootstrap-cli.sh` to resolve the invocation token (`sf` / `npx saasfoundryai-cli`).
2. **Gather snapshot** — run `scripts/read-project.sh` from the project root. It reads `.saasfoundry.json`, calls `sf modules list --json`, and emits a consolidated JSON report on stdout.
3. **Answer from the report** — never invent facts about the project; if a field is missing in the report, tell the user you don't know rather than guessing.
4. **Stay read-only** — if the user's follow-up becomes "add X", "remove Y", "upgrade Z", route through Phase 2D's `plan-update.sh`. Never let a "tell me about…" thread slip into a mutation without explicit intent.

### Report shape (from `read-project.sh`)

```json
{
  "project": { "name": "…", "structure": "monorepo", "cliVersion": "1.0.0-beta", "generatedAt": "…" },
  "modules": {
    "installed": ["email", "storage", "sf-skill-context7"],
    "available": ["email", "storage", "analytics", …],
    "newlyAvailable": ["analytics"],
    "obsolete": [{ "name": "email", "minCliVersion": "1.1.0" }]
  },
  "upToDate": true
}
```

### Never do these

- **Don't write anything.** Project Awareness is read-only by design; mutations live in Phase 2C (`sf new`) and Phase 2D (`sf update`).
- **Don't trust a stale snapshot across turns.** Re-run `read-project.sh` when the user signals they've made changes (commits, CLI runs, etc.).
- **Don't fabricate module descriptions.** If the user wants "what does module X do?", call `sf modules info X --json` and read from the catalogue.
- **Don't answer "am I up to date?" from cached intuition.** Always use `report.upToDate` — it's the only field that cross-checks installed modules against `catalogue.minCliVersion`.

## Anti-Reinvention Guardrail

When the user expresses intent to build, add, or implement a capability **inside a SaaSFoundryAI project**, the skill MUST check the catalogue first. The guardrail exists because users often reach for custom code out of reflex when an opinionated SaaSFoundryAI module would ship faster, stay maintained upstream, and keep the generated project on the paved path.

### When the guardrail triggers

- Verbs: "add", "build", "implement", "setup", "integrate", "plug in", "need to" + any feature.
- Nouns that commonly map to catalogue modules: email, transactional mail, file upload, object storage, S3, analytics, usage tracking, telemetry, plus every `sf-skill-*` tool integration.
- Triggers only when a `.saasfoundry.json` is present (i.e. the user is inside a SaaSFoundryAI project). Outside a project, treat the intent normally.

### Workflow

1. **Bootstrap** — run `bootstrap-cli.sh` to resolve the invocation token.
2. **Classify the intent** — run `scripts/check-catalogue.sh "<user intent>"`. The script wraps `sf modules match <intent> --json`, normalizes the top result, and emits a tiered recommendation.
3. **Read the `tier` field** and act accordingly:
   - `HIGH` (score ≥ 6) → Propose `sf update --add-modules <name>` **before** writing a single line of custom code. Present the tradeoff: what the module ships (routes, adapters, docs, tests, CI) vs what a hand-rolled impl costs the user (maintenance, drift from blueprint, no upstream updates).
   - `MEDIUM` (score 3–5) → Surface the candidate, ask the user to confirm it matches their intent (use `AskUserQuestion`), and only then propose `sf update`.
   - `LOW` (score 1–2) or `NONE` (no results) → Route to **Feedback — Module Request** below: run the scorecard before offering `sf feedback request`, then fall back to custom dev with eyes open.
4. **Stay honest** — if the user insists on custom code even with a HIGH match, do it. But log the decision explicitly ("we're building X custom despite a HIGH catalogue match for module Y"), so future-you doesn't re-propose it every turn.

### Recommendation shape (from `check-catalogue.sh`)

```json
{
  "intent": "send transactional emails",
  "tier": "HIGH",
  "topMatch": { "name": "email", "displayName": "Email Service", "category": "…", "score": 15, "reasons": ["keywords: …"] },
  "recommendation": {
    "action": "propose-update",
    "command": "sf update --add-modules email",
    "message": "Strong match: \"Email Service\" (score 15). Propose `sf update` before letting the user custom-code this."
  }
}
```

### Never do these

- **Don't skip the guardrail on `add / build / implement` verbs.** Custom-coding first and offering the module second is the anti-pattern the guardrail exists to prevent.
- **Don't invent scores.** Always consult `check-catalogue.sh`; never eyeball the match yourself. The skill should not outsmart the CLI's scoring.
- **Don't force a HIGH-tier proposal.** If the user confirms they want custom dev, move on. The guardrail informs, it doesn't block.
- **Don't conflate `LOW` with `NONE`.** A LOW-tier match is still a signal — surface it as "closest neighbor" when routing to `sf feedback request`, so the user's request can reference existing work.

## Milestone Guardrail

A project that chains SRS → tickets and never declares what a **version** contains cannot say when to cut. The guardrail exists because nobody thinks to frame a release until they are already trying to ship one, and by then the scope is whatever happens to be finished.

Like the Anti-Reinvention Guardrail, it **informs and does not block**. A milestone reports; it never refuses a release.

### When the guardrail triggers

- The user talks about **releasing, cutting, tagging, shipping a version**, or asks what is left before one — **pass `--version-named "<what they called it>"`**. The threshold below does not apply once they have said it out loud.
- A **version Epic was just spawned** from the SRS — the scope exists in the product and not yet on the board.
- Tickets are accumulating with no milestone and none is open. `plan-milestone.sh` decides whether that has crossed the threshold; do not eyeball it.
- Triggers only when `.saasfoundry.json` declares a workflow tool. Without one there is no board to scope.

**Do not fire on every turn.** A guardrail that greets is a guardrail that gets ignored, then disabled. `shouldPropose: false` means stay quiet — including when it comes with candidates, which happens when a milestone is already open and the right move is to re-scope rather than add another.

### Workflow

1. **Read the board and the SRS** — `scripts/plan-milestone.sh`. It gathers tickets, milestones, sub-issue relationships **and the versions the SRS declares**, and returns candidates with the evidence each grouping rests on. The SRS read degrades to nothing on a missing module, a missing network or an adapter error — a release proposal never becomes an error because a remote page was slow.
2. **Check `shouldPropose` before saying anything.** `true` → raise it, quoting `trigger`. `false` → say nothing about milestones; if the user asked directly, answer with `reason`.

   **When the user named a version, `--version-named` is not optional.** Without it the script judges a young board on ticket count alone, returns `shouldPropose: false`, and the rule below turns that into silence — so someone who just said *"I want to ship an MVP"* gets a quoted threshold, with the right candidate sitting unused in the output. That is the contradiction this flag removes: silence is not an option once they have raised it.
3. **Propose from the candidates, never around them.** Each carries `evidence` — a sub-issue relationship, an SRS version page, or an admission of being a leftover pile. A proposal that cites none of those is invented.
4. **Name the release yourself.** `name` is always `null`: the script will not invent a version number, because choosing one is a decision. Propose it, and say what it is based on.
5. **Read `droppedCandidates` before presenting.** The cap hides nothing, but it does put things below the fold. On this project's own board the release Epic was in the dropped set — see #551.
6. **Create only on approval** — `workflow-cli.sh milestone create <name>`, then `assign` per ticket, then `associate` for any SRS version page.

### Saying it in their words, not the tracker's

A milestone is **a version of the product**. When you raise it, say what it buys them rather than what it is called in GitHub: grouping the features that go into a release bounds the work, turns a vague ambition into steps, and makes progress toward it readable. `MVP`, `v1`, `v2` are the vocabulary — "milestone" is the implementation.

Propose the name from what they said. Never invent a version number, and never derive one from an SRS page title.

### Recommendation shape (from `plan-milestone.sh`)

```json
{
  "shouldPropose": true,
  "trigger": "51 open tickets carry no milestone and none is open — the next release has no declared scope",
  "reason": null,
  "candidates": [
    {
      "source": "epic",
      "name": null,
      "rationale": "Epic #482 holds 16 tickets, 1 still open",
      "evidence": "grouped by sub-issue relationship to #482 — \"[EPIC] Release v1.0.0 …\"",
      "tickets": [483, 484, 486],
      "scopeSize": 16,
      "openCount": 1
    }
  ],
  "droppedCandidates": [{ "source": "unaffiliated", "rationale": "30 open tickets belong to no Epic and no milestone", "scopeSize": 30, "openCount": 30 }],
  "cap": 3,
  "considered": 6,
  "dropped": 3,
  "counts": { "tickets": 410, "open": 51, "unassigned": 51, "openMilestones": 0 },
  "notes": []
}
```

**An `srs-version` candidate is the strongest evidence there is**, and it is the only source whose trigger ignores the ticket-count threshold. A version the product declared is a scope somebody already decided; a large pile of tickets is only a pile. When one appears, its `scopeSize` counts **FR pages in the SRS**, not tickets on the board — the release has been framed but not necessarily spawned yet.

`scopeSize` and `openCount` answer different questions. **What a release contains** is `scopeSize` — that is what a milestone records, and what people read after the release, when everything in it is closed. **What is left to do** is `openCount` — the right question when re-scoping something already in flight. Use the one the conversation is actually about.

**`scopeSize` is a floor, not a total, while #560 and #561 are open.** The retrofit on this project's own board (#554) framed a release the engine put at 16 tickets and the human record put at 33: it cannot see a finished Epic, and it names one Epic where a release spans four. Before quoting `scopeSize` for a release, ask whether closed Epics or sibling Epics belong to it — the engine will not raise either.

### Never do these

- **Never propose a milestone whose grouping cites no evidence.** If it did not come from a candidate, it is a guess with a confident tone. Ask instead.
- **Never speak up when `shouldPropose` is `false` — but never let that be the answer to a version the user named.** Run with `--version-named` first; if it *still* comes back `false`, there is genuinely nothing groundable, and the honest reply is to ask what they want in it rather than to propose a scope you invented.
- **Never speak up when `shouldPropose` is `false`.** Especially not when a milestone is already open: the answer there is to re-scope it, and proposing a second is how a board ends up with three overlapping releases.
- **Never treat a milestone as a gate.** It reports where a release stands and asks for an acknowledgement to continue; it does not refuse one. A gate that blocks a hotfix behind an unfinished milestone gets disabled permanently, and it would contradict a standing decision that the tag is a joint call.
- **Never read `counts` as exact when `notes` says the board was truncated.** Every number is then a floor, and a grouping may be missing tickets outright.
- **Never read "the SRS declares no version pages" as "this product has no versions".** It usually means the features hold their FRs directly and `sf srs normalize` has not run. `notes` distinguishes that from *"the SRS could not be read"*, which is a gap in the evidence — do not treat the second as the first.
- **Never present a candidate as the whole release without checking for the parts it cannot see.** A closed Epic produces no candidate at all, and no `droppedCandidates` entry either — silence here means "not looked at", not "nothing there". See #560, #561.

## Feedback — Module Request

When the user wants to file a module request — either because the anti-reinvention guardrail routed them here (LOW/NONE tier), or because they explicitly asked to — the skill MUST run a 5-criterion scorecard **before** calling `sf feedback request`. The scorecard exists because a catalogue slot is a long-term maintenance commitment: the skill can and should **refuse** requests that don't fit, with clear reasoning, rather than filing noise.

### When this flow triggers

- Anti-reinvention guardrail returned `LOW` or `NONE` tier and the user wants to push for catalogue inclusion.
- User says explicitly: "file a module request", "request this as a module", "submit this to SaaSFoundryAI", etc.
- **Does NOT trigger** on bug reports (that's Phase 3C) or voting (Pillar 6 — `sf feedback vote --list`).

### The 5-criterion scorecard

Ask each criterion as a natural question during the conversation — don't hand the user a dry form. Each criterion answers `yes` / `no` / `unclear`. **One `no` or one `unclear` refuses the filing.**

| Criterion | The question behind it | What `yes` looks like |
| --- | --- | --- |
| `scopeFit` | "Is this something every SaaS eventually wants?" | The feature belongs to the SaaS baseline (auth, billing, email, storage, observability, comms, admin tooling). |
| `reusability` | "Would 3+ unrelated projects plausibly want this?" | Broad SaaS relevance, not specific to one product or industry. |
| `notAlreadySolvable` | "Can't this already be done cleanly with existing modules or a small custom impl?" | Existing modules don't cover it, and a hand-rolled version would be non-trivial (>2 days work). |
| `opinionOwnership` | "Is there a clear opinionated 'right way' to do this in SaaSFoundryAI?" | You can name the stack, the vendor(s), the integration surface without hedging. |
| `maintenanceRealism` | "Can this be maintained long-term?" | Stable deps, non-fragile upstream, vendor is unlikely to pivot/shutter within 2 years. |

If any criterion is `no` or `unclear`, the skill **refuses** the filing and explains which criteria blocked it. The refusal is not a snub — it's the skill protecting the catalogue from scope creep. Explain the red flag, and suggest alternatives (custom code, existing module, wait-and-see).

### Workflow

1. **Bootstrap** — run `bootstrap-cli.sh` to resolve the invocation token and `bootstrap-gh.sh` to confirm GitHub auth (filing requires it).
2. **Gather the scorecard** — walk through the 5 criteria conversationally. Ask each one in plain language; translate the answer into `yes` / `no` / `unclear` yourself. Use `AskUserQuestion` for the user-facing choices when possible.
3. **Propose a module name** — infer a kebab-case slug from the intent (e.g. "real-time chat" → `chat`). Confirm with the user before finalizing.
4. **Classify** — pipe the intent + name + scorecard + optional description into `scripts/plan-feedback-request.sh`. The script fetches open module-request issues via `sf feedback list --status open --json`, detects duplicates, and emits a decision.
5. **Act on the `decision` field**:
   - `file-request` → Present the emitted `sf feedback request …` command, get explicit approval, then run it. Quote the scorecard answers in the issue description so future reviewers can see the rationale.
   - `route-to-existing` → Point the user at the duplicate issue (number + title + url). Offer `sf feedback vote <n> up` or `sf feedback vote <n> comment --comment "…"` so the existing issue gathers traction instead of a parallel noise thread.
   - `refuse` → List the `redFlags` array verbatim. Don't soft-pedal — the criteria are in place for a reason. If the user pushes back with new info, rebuild the scorecard (they may have just unblocked a criterion) and re-classify.

### Recommendation shape (from `plan-feedback-request.sh`)

```json
{
  "intent": "real-time chat between project members",
  "name": "chat",
  "decision": "refuse",
  "redFlags": [
    {
      "criterion": "reusability",
      "answer": "no",
      "reason": "Low reusability — at least 3 unrelated projects should plausibly want this before it earns a slot in the catalogue."
    }
  ],
  "duplicate": null,
  "recommendation": {
    "action": "refuse",
    "command": null,
    "message": "Refused: the scorecard has 1 red flag (reusability=no). Explain the red flags to the user before filing anything."
  }
}
```

### Never do these

- **Don't skip the scorecard.** Even when routed here from anti-reinvention, run all 5 criteria — the guardrail's LOW tier is not a green light to file, it's a "worth evaluating" signal.
- **Don't soft-pass an `unclear` answer.** `unclear` is a refusal, just like `no`. Treat it as "come back when you know" rather than "probably fine".
- **Don't echo the scorecard without the decision.** The user should always hear the outcome (file / route / refuse) plus the reasoning, never a raw JSON dump.
- **Don't skip dedup.** Always let `plan-feedback-request.sh` enrich the payload with `sf feedback list` — catching a duplicate before filing is the entire point of the orchestration.
- **Don't file without `bootstrap-gh.sh`.** A filing attempt against an unauthenticated `gh` produces a confusing failure; surface the install/login guidance from `bootstrap-gh.sh` first.

## Feedback — Bug Report

When something goes wrong — a `sf` command exits non-zero, a generated project fails to build, a three-way merge produces something weird — the skill **passively notices** and offers to file a bug. The skill must never file silently: detection is a proposal, the user is the gate. Orchestration runs through `scripts/plan-feedback-bug.sh`, which classifies the label (`cli-bug` vs `scaffold-bug`), scrubs credentials from any captured stderr, and emits the exact `sf feedback bug` command to run.

### When this flow triggers

- **Passive signals** — the skill saw one of these and should propose filing:
  - `sf` command exited non-zero under `--non-interactive` (a flow the skill is driving). Source = `cli-invocation`.
  - Generated project failed a post-setup check (`npm install`, `tsc`, `nest build`, `vite build`, Docker compose up). Source = `scaffold-build`.
  - Three-way merge inside `sf update` produced a `.saasfoundry.new` conflict file or a schema-validation error on `.saasfoundry.json`. Source = `scaffold-build` with a one-line description of the anomaly.
- **User-initiated** — the user says "file a bug", "report this", "sf crashed". Source = `manual`. Use the `context` field (`cli` / `scaffold`) when the user identifies the surface; otherwise default to `cli-bug`.
- **Does NOT trigger** on module requests (that's `Feedback — Module Request`) or on voting workflows.

### Label routing: `cli-bug` vs `scaffold-bug`

- **`cli-bug`** — defects in the `sf` CLI itself: argument parsing, prompt flows, orchestration of external tools, generator logic that throws *before* writing files.
- **`scaffold-bug`** — defects visible in the generated project: incorrect template content, dependency resolution failures, broken post-setup steps, merge artifacts from `sf update`.
- **When in doubt** — if the command exited inside `sf` but the error points at the freshly-written project (e.g. "cannot find module in the generated api"), prefer `scaffold-bug`; the user's repro lives in the project tree.

### Auto-repro payload

`sf feedback bug --auto-repro` collects a repro envelope for free: CLI version, Node version, platform, `.saasfoundry.json` contents. The skill's job is to **supplement** that envelope with the captured failure evidence:

- The exact command that was run (or the trigger action, for user-initiated reports)
- The exit code when available
- A **redacted** excerpt of the stderr (handled by `plan-feedback-bug.js` — never paste raw stderr yourself)

Redaction covers GitHub/OpenAI/Stripe/Slack tokens, Bearer/Basic headers, JWTs, `--token=` / `--password=` / `--secret=` CLI args, environment variables ending in `_TOKEN` / `_SECRET` / `_PASSWORD` / `API_KEY`, query-string credentials, home-directory paths (`/Users/<user>`, `/home/<user>`, `C:\Users\<user>`), and email addresses. The classifier applies this scrub even when the decision is `refuse`, so nothing sensitive leaks via the refusal message either.

### Workflow

1. **Bootstrap** — run `bootstrap-cli.sh` to resolve the `sf` invocation token and `bootstrap-gh.sh` to confirm GitHub auth (filing requires it).
2. **Compose the detection event** — build a JSON object the classifier understands:
   - `source` (required) — one of `cli-invocation` / `scaffold-build` / `manual`
   - `title` (required) — short human-readable, e.g. "sf new crashes on empty project name"
   - `command`, `exitCode`, `stderr`, `description` — best-effort, as much as the skill captured
   - `context` — `cli` or `scaffold`, only meaningful for `manual` reports when the user identifies the surface
   - `userConfirmed` — `true` ONLY after the user explicitly approved filing. Any other value forces a refusal.
3. **Classify** — pipe the detection event JSON into `scripts/plan-feedback-bug.sh`. The script redacts the stderr, picks the label, and emits the `sf feedback bug …` command with the envelope pre-wired.
4. **Act on the `decision` field**:
   - `file-bug` → Present the emitted `sf feedback bug …` command along with the redacted stderr excerpt so the user sees what will be posted. On explicit go-ahead, run it.
   - `refuse` → Explain why (almost always: `userConfirmed !== true`). Do not "try again silently" — ask the user directly and re-classify only after they confirm.

### Recommendation shape (from `plan-feedback-bug.sh`)

```json
{
  "source": "cli-invocation",
  "label": "cli-bug",
  "title": "sf new crashes on empty project name",
  "description": "Reproducing failure for triage.\n\n**Command:** `sf new --non-interactive --name=\"\"`\n\n**Exit code:** 1\n\n**Stderr (credentials redacted):**\n\n```\nError: required name\nat /Users/<user>/Projects/app/src/index.js:12\n```",
  "redactedStderr": "Error: required name\nat /Users/<user>/Projects/app/src/index.js:12",
  "decision": "file-bug",
  "recommendation": {
    "action": "run-command",
    "command": "sf feedback bug --source cli --title 'sf new crashes on empty project name' --description '…' --auto-repro --yes",
    "message": "Confirmed. File the cli-bug with: sf feedback bug --source cli --title '…' --description '…' --auto-repro --yes"
  }
}
```

### Never do these

- **Don't file without `userConfirmed: true`.** Detection is a proposal, never an action. The classifier will refuse automatically, but the skill must also surface the user's go-ahead in the conversation before passing `userConfirmed: true` to the script.
- **Don't paste raw stderr** anywhere the user sees it before it has been through `plan-feedback-bug.sh`. Redaction is the script's job — do not duplicate or shortcut it.
- **Don't guess the label.** If the source is `manual` and you can't tell whether it's `cli` or `scaffold`, ask the user. Wrong routing means the wrong reviewers see the issue.
- **Don't file a bug when the user wanted to request a module.** Scope keywords: "crashed", "broken", "error", "fails" → bug. "I wish", "we should have", "add a module" → request. Re-route rather than file the wrong kind.
- **Don't swallow the failure after filing.** The original error the skill detected is usually still blocking the user's real task. After the bug is filed, offer workarounds or next steps — filing does not resolve the underlying failure.

## Interaction principles

1. **Never bypass the CLI.** If the user asks for a file or layout that the CLI can generate, generate it via `sf`. Do not hand-write blueprints.
2. **Always verify prerequisites first.** Run `bootstrap-gh.sh` before GitHub calls and `bootstrap-cli.sh` before any `sf` command. Project-scoped awareness (reading `.saasfoundry.json`) lands in Phase 2E.
3. **Use `AskUserQuestion` for multi-choice.** Do not emulate Inquirer with plain prose questions — use the structured tool when presenting enumerated options (fleshed out in Phase 2C/2D).
4. **Prefer `--dry-run` before mutations.** Especially for `sf update`, always show the user what would change before doing it.
5. **Respect user preferences.** `~/.saasfoundry/preferences.json` tracks opt-out choices (skill prompts, voting surveys) — honor them across sessions.

## Future capabilities

This SKILL.md is the foundation (Phase 2A, ticket #102). The following capabilities will be layered on in subsequent tickets:

- **Phase 4 — Community voting polish** (Pillar 6): skill-side UX for ranking and voting on open module requests.
- **Phase 5 — Event handling** (Pillar 7): cmux/IDE/terminal adaptation for browser flows and multi-server launches.

All tracked under epic #18.
