import { resolve } from 'path'

export interface DbCredentials {
  host: string
  port: string
  user: string
  password: string
  database: string
  dbType: 'postgresql' | 'sql'
}

export interface S3Credentials {
  endpoint: string
  accessKey: string
  secretKey: string
  bucket: string
  region: string
}

export interface Answers {
  profile?: 'full' | 'harness' | 'stack'
  projectName: string
  projectDescription: string
  isMonorepo: boolean
  setupRepo: 'local' | 'create' | 'existing'
  gitProvider?: 'GitHub' | 'GitLab'
  mainBranch: 'main' | 'master'
  monorepoUrl?: string
  backendRepoUrl: string
  frontendRepoUrl?: string
  dbSetup: 'docker' | 'credentials' | 'manual'
  dbCredentials?: DbCredentials
  initDb: boolean
  emailService: 'none' | 'mailersend'
  mailersendApiKey?: string
  mailersendSenderEmail?: string
  mailersendSenderName?: string
  s3Setup: 'docker' | 'credentials' | 'manual'
  s3Credentials?: S3Credentials
  includeAnalytics: boolean
  includePwa: boolean
  /**
   * Language the AI writes in, collected once and applied to all three manifest
   * surfaces (`language.*`). `outputLanguageCustom` carries the free-text tag
   * when the user picks "Other"; neither is persisted as-is.
   */
  outputLanguage?: string
  outputLanguageCustom?: string
  advancedSkills?: string[]
  context7ApiKey?: string
  atlassianEmail?: string
  atlassianApiToken?: string
  atlassianSite?: string
  atlassianCloudId?: string
  notionApiToken?: string
  notionApiVersion?: string
  figmaApiToken?: string
  srsEnable?: boolean
  srsBackend?: 'notion'
  srsParentPageInput?: string
  srsIngestEnable?: boolean
  srsIngestParentInput?: string
  workflow?: WorkflowConfig
  /** Collection-only preset preselection from `--workflow <preset>`; never persisted. */
  workflowPreset?: 'saasfoundry' | 'solo'
  /** Collection-only flag from `--no-network`: tools-first checks degrade to presence only; never persisted. */
  toolsNoNetwork?: boolean
  aiRules?: AIRules
  /**
   * Tools-first step selections (FR-CONFIG-ENGINE-04), persisted into
   * `manifest.tools.{tracker,docs,design}`. Connection status is intentionally
   * ephemeral (shown ok/warn in-session, recomputed live by `sf status`).
   */
  toolSelections?: {
    tracker?: ToolSelection
    docs?: ToolSelection
    design?: ToolSelection[]
  }
}

export interface CreateApiAppParams {
  /** Resolved host ports. Absent means the defaults — see `DEFAULT_PORTS`. */
  ports?: ProjectPorts
  isMonorepo: boolean
  projectName: string
  projectDescription: string
  backendRepoUrl: string
  dbCredentials?: DbCredentials
  mainBranch: string
  emailService: 'none' | 'mailersend'
  mailersendApiKey?: string
  mailersendSenderEmail?: string
  mailersendSenderName?: string
  s3Setup: 'docker' | 'credentials' | 'manual'
  s3Credentials?: S3Credentials
  advancedSkills?: string[]
  context7ApiKey?: string
  atlassianEmail?: string
  atlassianApiToken?: string
  atlassianSite?: string
  atlassianCloudId?: string
  notionApiToken?: string
  notionApiVersion?: string
  figmaApiToken?: string
  workflow?: WorkflowConfig
  aiRules?: AIRules
}

export interface CreateWebAppParams {
  /** Resolved host ports. Absent means the defaults — see `DEFAULT_PORTS`. */
  ports?: ProjectPorts
  isMonorepo: boolean
  projectName: string
  projectDescription: string
  frontendRepoUrl: string
  mainBranch: string
  s3Setup: 'docker' | 'credentials' | 'manual'
  includeAnalytics: boolean
  includePwa: boolean
  advancedSkills?: string[]
  context7ApiKey?: string
  atlassianEmail?: string
  atlassianApiToken?: string
  atlassianSite?: string
  atlassianCloudId?: string
  notionApiToken?: string
  notionApiVersion?: string
  figmaApiToken?: string
  workflow?: WorkflowConfig
  aiRules?: AIRules
}

export interface CreateDbAppParams {
  isMonorepo: boolean
  projectName: string
  dbCredentials?: DbCredentials
}

export interface CreateS3AppParams {
  isMonorepo: boolean
  projectName: string
  s3Credentials?: S3Credentials
}

export interface CreateMonorepoRootParams {
  /** Resolved host ports. Absent means the defaults — see `DEFAULT_PORTS`. */
  ports?: ProjectPorts
  projectName: string
  projectDescription: string
  monorepoUrl?: string
  mainBranch: string
  workflow?: WorkflowConfig
  aiRules?: AIRules
}

export interface CreateDevServicesParams {
  apiPath: string
  projectName: string
  dbSetup: 'docker' | 'credentials' | 'manual'
  dbCredentials?: DbCredentials
  s3Setup: 'docker' | 'credentials' | 'manual'
  s3Credentials?: S3Credentials
  /** Resolved host ports for MinIO. Absent falls back to the template's 9000/9001 (#623). */
  s3Ports?: { api?: number; console?: number }
}

// Workflow Configuration Interfaces
export type GitHubProjectColor = 'GRAY' | 'YELLOW' | 'BLUE' | 'PURPLE' | 'ORANGE' | 'PINK' | 'GREEN' | 'RED'

export interface WorkflowStatus {
  name: string
  description?: string
  color?: GitHubProjectColor
}

export interface WorkflowIssueType {
  name: string
  description?: string
  color?: GitHubProjectColor
}

export interface WorkflowConfig {
  tool: 'github-projects' | 'jira' | 'notion' | 'linear' | 'none'
  projectUrl?: string
  workingBranch?: string
  prTargetBranch?: string
  requireCodeReview?: boolean
  statuses?: WorkflowStatus[]
  issueTypes?: WorkflowIssueType[]
  branchNaming?: {
    feature?: string
    fix?: string
    release?: string
  }
  commitFormat?: {
    pattern?: string
    requireTicket?: boolean
    types?: string[]
  }
  template?: string
  validated?: boolean
  lastValidated?: string
}

export interface AIRules {
  alwaysCreateBranchFromWorking?: boolean
  alwaysCreateTicketBeforeCode?: boolean
  autoUpdateTicketStatus?: boolean
  requireHumanCheckOnPushedBranch?: boolean
}

export interface WorkflowTemplate extends WorkflowConfig {
  name: string
  description?: string
  aiRules?: AIRules
}

export interface SrsPageRef {
  id: string
  url: string
  name: string
}

export interface PendingIngestion {
  sourceBackend: 'notion'
  sourceParent: SrsPageRef
  createdAt: string
}

export interface SrsScanConfig {
  exclude?: string[]
}

export interface SrsToolConfig {
  enabled: boolean
  backend: 'notion'
  rootPage?: SrsPageRef
  pendingIngestion?: PendingIngestion
  scan?: SrsScanConfig
}

/**
 * One selected entry-point tool in the category registry. `name` is the
 * canonical catalogue id (see `src/tools/catalogue.ts`); `account` is the
 * `~/.claude/credentials/<bucket>/<account>.env` name when one was chosen.
 */
export interface ToolSelection {
  name: string
  account?: string
}

export interface ToolsConfig {
  srs?: SrsToolConfig
  // Tools-first selection registry (FR-CONFIG-ENGINE-04), grouped by category.
  // Additive and optional: a manifest written before this field omits it, and
  // readers fall back to the legacy fields (`workflow.tool` for the tracker,
  // `tools.srs.backend` for docs). No migration — see migration-framework.md
  // "When NOT to add a migration". Deep unification (folding workflow/srs into
  // these blocks) is a dedicated follow-up Epic that ships its own migration.
  tracker?: ToolSelection
  docs?: ToolSelection
  design?: ToolSelection[]
}

/** BCP-47 language tag for AI-produced artefacts — `en`, `fr`, `pt-BR`… */
export type LanguageTag = string

/**
 * Language of what the AI writes, split by surface. Every key is optional and
 * resolves to English — see `resolveOutputLanguages` in `src/language.ts`.
 *
 * The surfaces are separate because they do not always agree: a French-speaking
 * team may well want a French SRS while keeping code comments and commit
 * messages in English, because the codebase outlives the team that wrote it.
 */
export interface LanguageConfig {
  /** SRS pages — features, versions, FRs. */
  srs?: LanguageTag
  /** Ticket titles, bodies and comments on the board. */
  tickets?: LanguageTag
  /** Comments in source files, and commit messages. */
  codeComments?: LanguageTag
}

/**
 * The host ports a generated project runs on, resolved once at `sf new` (#584).
 * Every file that names a port reads it from here, so the .env, the compose, the
 * Vite server and the docs cannot drift apart.
 */
export interface ProjectPorts {
  db: number
  api: number
  web: number
  /**
   * MinIO's two published ports, present only when the project hosts its own storage.
   * Absent on `--s3-setup credentials` (the bucket is someone else's) and on manifests
   * written before #623, whose projects run on 9000/9001.
   */
  s3?: number
  s3Console?: number
}

export type HarnessAgent = 'claude-code' | 'codex' | 'kimi'

export interface SaaSFoundryManifest {
  $schema?: string
  // Schema-shape version, monotonic integer, bumped by registered manifest migrations.
  // Treat absence as 0 (manifest predates the migration framework).
  manifestVersion?: number
  version: string
  generatedAt: string
  structure: 'monorepo' | 'multirepo' | 'cli'
  projectName: string
  // Git main branch chosen at `sf new` (main/master). Optional: manifests
  // written before this field exists omit it — read sites must fall back
  // (no migration; see .claude/docs/migration-framework.md "When NOT to add").
  mainBranch?: string
  // Host ports the generated project runs on, chosen at `sf new` (#584). Absent on
  // manifests written before this field existed — readers must fall back to
  // `DEFAULT_PORTS` (5435/3500/5173), which is what those projects actually run,
  // so no migration is needed (see .claude/docs/migration-framework.md,
  // "When NOT to add a migration").
  ports?: ProjectPorts
  // Every key is optional: scaffolded projects carry the five stack keys,
  // harness-only projects carry just `harness`. Scaffold-only code paths must
  // gate on `isScaffoldManifest()` (modules.email present), never on the mere
  // presence of the modules block.
  modules?: {
    // Email module — versioned shape introduced in manifestVersion 2.
    // `provider` replaces the old flat `emailService` field; `version` is
    // the per-module installed version, used by module-level migrations
    // (Epic #310 — see installers' currentVersion + migrations array).
    email?: {
      provider: 'none' | 'mailersend'
      version: number
    }
    s3Setup?: 'docker' | 'credentials' | 'manual'
    dbSetup?: 'docker' | 'credentials' | 'manual'
    includeAnalytics?: boolean
    advancedSkills?: string[]
    // AI harness deposits (skills, docs, workflow artefacts) — versioned so
    // `sf update` can refresh them and module migrations can target them.
    harness?: {
      version: number
      /** Additive shared support; absence preserves legacy behavior. */
      agents?: HarnessAgent[]
    }
    // PWA module — makes the generated web app installable as a desktop
    // application through the browser's own flow. Versioned shape (not the flat
    // legacy boolean like `includeAnalytics`) so module migrations can target it.
    pwa?: {
      version: number
    }
  }
  // Language of AI-produced artefacts, per surface. Optional with an English
  // default resolved at read time (`resolveOutputLanguages`), so manifests
  // written before this field keep validating and behave identically — which
  // is why it ships without a migration (see migration-framework.md,
  // "When NOT to add a migration").
  language?: LanguageConfig
  skillsAccounts?: Record<string, string>
  fileHashes?: Record<string, string>
  workflow?: WorkflowConfig
  aiRules?: AIRules
  tools?: ToolsConfig
}

/** Modules block of a project scaffolded by `sf new` (full/stack profile) — the five stack keys are guaranteed. */
export type ScaffoldModules = Required<Pick<NonNullable<SaaSFoundryManifest['modules']>, 'email' | 's3Setup' | 'dbSetup' | 'includeAnalytics' | 'advancedSkills'>> & {
  harness?: { version: number; agents?: HarnessAgent[] }
  // Optional, not part of the guaranteed stack keys: projects scaffolded before the module
  // existed have no `pwa` entry, and `--no-pwa` projects never get one.
  pwa?: { version: number }
}

/** Manifest of a scaffolded project — see `isScaffoldManifest`. */
export interface ScaffoldManifest extends SaaSFoundryManifest {
  modules: ScaffoldModules
}

/**
 * Scaffold marker: a project generated by `sf new` (full/stack profile)
 * carries the five stack keys; a harness-only manifest carries just
 * `modules.harness`. Every scaffold-only code path (template regeneration,
 * stack-module installs, apps/* path derivation) MUST gate on this —
 * the mere presence of the `modules` block is not a scaffold signal.
 */
export function isScaffoldManifest(manifest: SaaSFoundryManifest): manifest is ScaffoldManifest {
  return manifest.modules?.email !== undefined
}

// JSON Schema URL stamped into .saasfoundry.json so IDEs pick up live validation.
// Points at master on the canonical repo — scaffolded projects don't ship a local
// copy of the schema; drift is prevented by a Jest guard on the source of truth.
export const manifestSchemaUrl = 'https://raw.githubusercontent.com/DiamondForgeFr/SaasFoundryAI/master/schemas/saasfoundry-manifest.schema.json'

// Paths
export const blueprintsPath = resolve(__dirname, '../scaffolds/blueprints')
export const overlaysPath = resolve(__dirname, '../scaffolds/overlays')
export const skillsTemplatesPath = resolve(__dirname, '../scaffolds/skills-templates')
export const scaffoldsDocsPath = resolve(__dirname, '../scaffolds/docs')
