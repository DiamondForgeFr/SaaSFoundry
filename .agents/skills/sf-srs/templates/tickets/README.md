# sf-srs — ticket body templates

Agnostic Markdown templates for GitHub issue bodies linked to SRS pages. Each renderer consumes a typed spec (`EpicTicketBodySpec`, `StoryTicketBodySpec`, `TaskTicketBodySpec`, `IssueTicketBodySpec`)
and emits a Markdown string suitable for posting to any ticketing backend that accepts Markdown (GitHub Projects, Jira, Linear…).

## Runtime location

The TypeScript source lives in the CLI repository:

- `src/builders/srs/templates/tickets/epic.tpl.ts` — exports `renderEpicTicketBody(spec: EpicTicketBodySpec): string` and `renderEpicTicketTitle(spec): string`
- `src/builders/srs/templates/tickets/story.tpl.ts` — exports `renderStoryTicketBody(spec: StoryTicketBodySpec): string`
- `src/builders/srs/templates/tickets/task.tpl.ts` — exports `renderTaskTicketBody(spec: TaskTicketBodySpec): string`
- `src/builders/srs/templates/tickets/issue.tpl.ts` — exports `renderIssueTicketBody(spec: IssueTicketBodySpec): string`

The skill bundle ships this README as reference; the subtask spawner (SUB-9) loads the compiled module from `dist/` (or the TS source via `tsx` in dogfood mode).

## Spec contracts

```ts
interface EpicTicketBodySpec {
  epic: EpicSpec
  epicPageUrl?: string
  frPages?: { frId: string; frTitle: string; pageUrl?: string }[]
  scopeIncluded?: string[]
  scopeExcluded?: string[]
  dependencies?: string[]
  constraints?: string[]
  assumptions?: string[]
  definitionOfDone?: string[]
}

interface StoryTicketBodySpec {
  fr: FrItem
  frPageUrl?: string
  mainSpecUrl?: string
  urRefs?: UrItem[]
  frRefs?: { id: string; title?: string }[]
  acceptanceCriteria?: { id: string; text: string; sourceFr?: string }[]
  dsRefs?: { id: string; title?: string }[]
  dependencies?: string[]
  constraints?: string[]
}

interface TaskTicketBodySpec {
  title: string
  objective?: string
  context?: string
  parentEpicUrl?: string
  parentStoryUrl?: string
  scopeIncluded?: string[]
  scopeExcluded?: string[]
  completionCriteria?: { id: string; text: string }[]
  specLinks?: { label: string; url: string }[]
  dependencies?: string[]
  constraints?: string[]
}

interface IssueTicketBodySpec {
  title: string
  behaviorObserved?: string
  expectedBehavior?: string
  stepsToReproduce?: string[]
  environment?: string[]
  impact?: string
  severity?: 'low' | 'medium' | 'high' | 'critical'
  evidence?: string[]
}
```

## Epic ticket sections

Produced by `renderEpicTicketBody(spec)` in this order:

1. `## Goal` — `spec.epic.title`
2. `## Business Value` — `spec.epic.businessValue` (placeholder when absent)
3. `## Scope` — `### Included` + `### Excluded` bulleted lists (placeholders when empty)
4. `## Specifications` — main SRS page link + Markdown table `[FR | Title | Page]`
5. `## Dependencies` — bulleted list (placeholder when empty)
6. `## Constraints` — bulleted list (placeholder when empty)
7. `## Assumptions` — bulleted list (placeholder when empty)
8. `## Definition of Done` — bulleted list (placeholder when empty)

## Story ticket sections

Produced by `renderStoryTicketBody(spec)` in this order:

1. `## Objective` — `spec.fr.description` (fallback: `Implement {FR-id} — {title}.`)
2. `## Context (User Requirements)` — `UR-XXX` bulleted list with narratives (placeholder when empty)
3. `## Scope (Functional Requirements)` — `FR-XXX` bulleted list (defaults to the current FR when `frRefs` is absent)
4. `## Acceptance Criteria` — Markdown table `[AC | Criterion | Source FR]` (placeholder when empty)
5. `## Specifications` — FR page link + optional Epic spec link
6. `## Dependencies` — bulleted list (placeholder when empty)
7. `## Constraints` — bulleted list (placeholder when empty)
8. `## Design References` — `DS-XXX` bulleted list (placeholder when empty)

## Task ticket sections

Produced by `renderTaskTicketBody(spec)` in this order:

1. `## Objective` — `spec.objective` (fallback: `Deliver {title}.`)
2. `## Context` — `spec.context` (placeholder when empty)
3. `## Scope` — `### Included` + `### Excluded` bulleted lists (placeholders when empty)
4. `## Completion Criteria` — Markdown table `[CC | Criterion]` (placeholder when empty)
5. `## Specifications` — parent Epic/Story links + external spec links (placeholder when empty)
6. `## Dependencies` — bulleted list (placeholder when empty)
7. `## Constraints` — bulleted list (placeholder when empty)

## Issue ticket sections

Produced by `renderIssueTicketBody(spec)` in this order:

1. `## Behavior observed` — `spec.behaviorObserved` (placeholder when empty)
2. `## Expected Behavior` — `spec.expectedBehavior` (placeholder when empty)
3. `## Steps to Reproduce / Trigger Conditions` — numbered list (placeholder when empty)
4. `## Environment / Configuration` — bulleted list (placeholder when empty)
5. `## Impact / Severity` — optional `**Severity:**` line + free-form impact paragraph (placeholder when both are empty)
6. `## Evidence / Data` — bulleted list (placeholder when empty)

## Authoring examples

Filled-in archetypal examples — one per type — live under `examples/` and are the reference a writing agent should skim before drafting a real ticket:

- [`examples/epic.md`](examples/epic.md) — Epic archetype (multi-tenant workspace isolation)
- [`examples/story.md`](examples/story.md) — Story archetype (invite teammate to workspace)
- [`examples/task.md`](examples/task.md) — Task archetype (extract shared email validation)
- [`examples/issue.md`](examples/issue.md) — Issue archetype (register form swallows `E_EMAIL_TAKEN`)

Each example opens with a `<!-- Why this example -->` preamble that names the pattern it illustrates and the anti-patterns to avoid. Import the **pattern** (tone, density, section usage, title
convention) — not the literal content, which is fictional.

## Adding a new ticket body variant

Add a new template under `src/builders/srs/templates/tickets/`, export it from `src/srs/index.ts`, and wire the subtask spawner (SUB-9) to dispatch to the right renderer based on the parent label
(`srs:drafting`, `srs:new`, …). The Markdown output is backend-agnostic — the body string is posted verbatim.
