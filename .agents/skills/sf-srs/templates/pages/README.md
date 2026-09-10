# sf-srs — page templates

Agnostic page rendering for SRS documents. Each template consumes a typed spec (`EpicSpec`, `FrSpec`) and emits a backend-agnostic `PageContent`. The per-backend adapter (e.g. `NotionSrsAdapter`) maps
`PageContent` to its native block model.

## Runtime location

The TypeScript source lives in the CLI repository:

- `src/builders/srs/templates/pages/epic.tpl.ts` — exports `renderEpicPage(spec: EpicSpec): PageContent`
- `src/builders/srs/templates/pages/fr.tpl.ts` — exports `renderFrPage(spec: FrSpec): PageContent`

The skill bundle ships this README as reference; `srs-cli.sh draft` loads the compiled module from `dist/` (or the TS source via `tsx` in dogfood mode).

## `PageContent` contract

```ts
interface PageContent {
  title?: string
  blocks: PageBlock[]
}

type PageBlock =
  | { kind: 'heading'; level: 1 | 2 | 3; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'bulleted_list'; items: string[] }
  | { kind: 'numbered_list'; items: string[] }
  | { kind: 'table'; header: string[]; rows: string[][] }
  | { kind: 'code'; language?: string; text: string }
  | { kind: 'divider' }
```

## Epic page sections

Produced by `renderEpicPage(spec)` in this order (five-category shape):

1. `Traceability` (H2) + plain-text code block (ASCII tree `UR → FR → { DS, TC, NFR }`) + explanatory paragraph
2. `Requirement Types` (H2) + definitions table `Prefix | Type | Description | Example` with one row per UR/FR/DS/TC/NFR
3. `User Requirements (UR)` (H2) + table `ID | Requirement | Priority | Related FR`, with group-header rows when items carry a `group`
4. `Functional Requirements (FR)` (H2) + table `ID | Requirement | Priority | Related UR | Related DS`, grouped
5. `Design Specifications (DS)` (H2) + table `ID | Specification | Related FR`, grouped
6. `Test Cases (TC)` (H2) + table `ID | Title | Steps | Expected Result | Related FR`
7. `Non-Functional Requirements (NFR)` (H2) + table `ID | Requirement | Target | Priority | Related FR`, grouped

Empty sections emit a placeholder paragraph (e.g. `No user requirements yet.`) instead of the table. Missing optional fields render as the em-dash cell `—`. Group headers appear as a single-cell row
carrying the group id followed by empty cells matching the table arity.

## FR page sections

Produced by `renderFrPage(spec)` in this order (five-category shape):

1. `Summary` (H2) + table `ID | Requirement | Priority | Related UR | Related DS | Related TC` — one row per FR item on the page
2. Divider
3. Per FR item: `{FR-id} — {title}` (H2) + vertical detail table `Field | Value` with canonical rows (in order): `ID`, `Title`, `Endpoint`, `Priority`, `Related UR`, `Related DS`, `Related TC`,
   `Description`, `Request Body`, `Acceptance Criteria`, `Validation Rules`, `Security Rationale`
4. Divider **between** items (not after the last item)

List-typed fields (`acceptanceCriteria`, `validationRules`) render as newline-joined `• item` entries within a single cell — Notion preserves newlines in table cells. Missing optional fields render as
`—`. The page title is `{FR-id} — {title}` of `spec.fr`.

`FrSpec.fr` is currently singular (one FR per page); the template wraps it as `[spec.fr]` internally so a future type extension to multi-FR pages is a single-line change.

## Adding a new backend

Backends add a `renderPageContentTo{Backend}Blocks(content: PageContent)` mapper and register via `registerSrsBackend` from `src/srs/registry.ts`. No template changes needed — the agnostic surface is
stable.
