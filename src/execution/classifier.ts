import { applyExecutionRequirementOverrides, finalizeExecutionRequirementSet, stableFingerprint } from './overrides'
import type {
  ClassifyTaskIntentOptions,
  ContextMode,
  ExecutionCapability,
  ExecutionRequirementSet,
  FailureTolerance,
  LatencyPriority,
  RequirementEffort,
  TaskCategory,
  TaskIntent,
  TaskOperation,
  TaskRiskLevel,
  ValidationCheck,
  ValidationRigor
} from './requirements'
import type { PrivacyBoundary, TrainingUse } from './types'

export const TASK_INTENT_CLASSIFIER_VERSION = '1.0.0'
export const EXECUTION_REQUIREMENT_POLICY_REVISION = 'execution-requirements-v1'

const RISK_ORDER: TaskRiskLevel[] = ['low', 'medium', 'high', 'critical']
const TOLERANCE_ORDER: FailureTolerance[] = ['high', 'medium', 'low']
const EFFORT_ORDER: RequirementEffort[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
const VALIDATION_ORDER: ValidationRigor[] = ['self-check', 'automated-checks', 'independent-review', 'independent-review-and-tests']
const LATENCY_ORDER: LatencyPriority[] = ['interactive', 'balanced', 'throughput']
const CONTEXT_ORDER: ContextMode[] = ['partitionable', 'single-candidate']
const ALL_BOUNDARIES: PrivacyBoundary[] = ['customer-controlled', 'local-device', 'provider-managed', 'unknown']
const ALL_TRAINING: TrainingUse[] = ['none', 'opt-in', 'opt-out', 'unknown']

interface CategoryProfile {
  risk: TaskRiskLevel
  failureTolerance: FailureTolerance
  minimumEffort: RequirementEffort
  capabilities: ExecutionCapability[]
  validation: ValidationRigor
  checks: ValidationCheck[]
  latency: { priority: LatencyPriority; maximumPlanP95Ms: number | null }
  context: { minimumWindowTokens: number; minimumOutputTokens: number; mode: ContextMode }
  privacy: { allowedBoundaries: PrivacyBoundary[]; allowedTrainingUse: TrainingUse[]; maxRetentionDays: number | null }
  tools: { required: string[]; forbidden: string[]; requireApproval: boolean }
}

const PROFILES: Record<TaskCategory, CategoryProfile> = {
  mechanical: {
    risk: 'low',
    failureTolerance: 'high',
    minimumEffort: 'low',
    capabilities: ['code', 'text'],
    validation: 'automated-checks',
    checks: ['automated-tests', 'self-review', 'type-check'],
    latency: { priority: 'interactive', maximumPlanP95Ms: 30_000 },
    context: { minimumWindowTokens: 8_000, minimumOutputTokens: 2_000, mode: 'partitionable' },
    privacy: { allowedBoundaries: ALL_BOUNDARIES, allowedTrainingUse: ALL_TRAINING, maxRetentionDays: null },
    tools: { required: [], forbidden: [], requireApproval: false }
  },
  implementation: {
    risk: 'medium',
    failureTolerance: 'medium',
    minimumEffort: 'medium',
    capabilities: ['code', 'repository-analysis', 'text', 'tool-use'],
    validation: 'automated-checks',
    checks: ['automated-tests', 'self-review', 'type-check'],
    latency: { priority: 'balanced', maximumPlanP95Ms: 120_000 },
    context: { minimumWindowTokens: 32_000, minimumOutputTokens: 4_000, mode: 'partitionable' },
    privacy: { allowedBoundaries: ALL_BOUNDARIES, allowedTrainingUse: ALL_TRAINING, maxRetentionDays: null },
    tools: { required: ['file-edit'], forbidden: [], requireApproval: true }
  },
  architecture: {
    risk: 'high',
    failureTolerance: 'low',
    minimumEffort: 'high',
    capabilities: ['long-context', 'repository-analysis', 'system-design', 'text'],
    validation: 'independent-review',
    checks: ['automated-tests', 'independent-review', 'self-review', 'type-check'],
    latency: { priority: 'throughput', maximumPlanP95Ms: null },
    context: { minimumWindowTokens: 128_000, minimumOutputTokens: 8_000, mode: 'single-candidate' },
    privacy: { allowedBoundaries: ALL_BOUNDARIES, allowedTrainingUse: ALL_TRAINING, maxRetentionDays: null },
    tools: { required: ['file-read'], forbidden: [], requireApproval: true }
  },
  security: {
    risk: 'critical',
    failureTolerance: 'low',
    minimumEffort: 'xhigh',
    capabilities: ['code', 'repository-analysis', 'security-analysis', 'text'],
    validation: 'independent-review-and-tests',
    checks: ['automated-tests', 'independent-review', 'security-tests', 'self-review', 'type-check'],
    latency: { priority: 'throughput', maximumPlanP95Ms: null },
    context: { minimumWindowTokens: 128_000, minimumOutputTokens: 8_000, mode: 'single-candidate' },
    privacy: { allowedBoundaries: ['customer-controlled', 'local-device'], allowedTrainingUse: ['none'], maxRetentionDays: 0 },
    tools: { required: ['file-read'], forbidden: ['network-publish'], requireApproval: true }
  },
  'data-sensitive': {
    risk: 'high',
    failureTolerance: 'low',
    minimumEffort: 'high',
    capabilities: ['repository-analysis', 'text'],
    validation: 'independent-review-and-tests',
    checks: ['automated-tests', 'independent-review', 'self-review'],
    latency: { priority: 'balanced', maximumPlanP95Ms: null },
    context: { minimumWindowTokens: 32_000, minimumOutputTokens: 4_000, mode: 'single-candidate' },
    privacy: { allowedBoundaries: ['customer-controlled', 'local-device'], allowedTrainingUse: ['none'], maxRetentionDays: 0 },
    tools: { required: ['file-read'], forbidden: ['network-publish'], requireApproval: true }
  }
}

const KEYWORDS: Record<TaskCategory, RegExp> = {
  mechanical: /\b(?:docs?|documentation|rename|typo|format|spelling|copy|orthographe|renommer|mise en forme)\b/i,
  implementation: /\b(?:implement|add|create|fix|change|code|feature|endpoint|module|impl[eé]ment|ajout|ajouter|cr[eé]er|corriger|modifier|fonctionnalit[eé])\b/i,
  architecture: /\b(?:architecture|architectural|design|refactor|restructure|migration|schema|conception|refonte|restructur(?:e|er|ation))\b/i,
  security: /\b(?:security|auth|credential|secret|token|encrypt|permission|rbac|vulnerabilit(?:y|ies)|s[eé]curit[eé]|authentification|identifiants?|chiffrement)\b/i,
  'data-sensitive': /\b(?:personal data|pii|health|payment|financial|confidential|customer data|donn[eé]es personnelles|sant[eé]|paiement|confidentiel)\b/i
}

const OPERATION_CATEGORIES: Partial<Record<TaskOperation, TaskCategory[]>> = {
  read: ['mechanical'],
  document: ['mechanical'],
  rename: ['mechanical'],
  edit: ['implementation'],
  generate: ['implementation'],
  refactor: ['implementation', 'architecture'],
  migrate: ['implementation', 'architecture'],
  deploy: ['implementation'],
  architecture: ['architecture'],
  'security-review': ['security']
}

function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right))
}

function strictest<T extends string>(values: readonly T[], order: readonly T[]): T {
  return values.reduce((current, value) => (order.indexOf(value) > order.indexOf(current) ? value : current))
}

function intersect<T extends string>(left: readonly T[], right: readonly T[]): T[] {
  const allowed = new Set(right)
  return left.filter((entry) => allowed.has(entry)).sort((a, b) => a.localeCompare(b))
}

function normalizeText(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()
}

function validateIntent(intent: TaskIntent): void {
  if (typeof intent.text !== 'string' || !intent.text.trim()) throw new Error('Task intent text must be a non-empty string.')
  for (const value of [intent.signals?.estimatedInputTokens, intent.signals?.estimatedOutputTokens]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) throw new Error('Task intent token estimates must be positive safe integers.')
  }
}

function detectCategories(intent: TaskIntent): { categories: TaskCategory[]; evidence: string[] } {
  const categories = new Set<TaskCategory>(intent.categories ?? [])
  const evidence = new Set<string>((intent.categories ?? []).map((category) => `intent.category.${category}`))
  const normalizedText = normalizeText(intent.text)
  for (const [category, pattern] of Object.entries(KEYWORDS) as Array<[TaskCategory, RegExp]>) {
    if (pattern.test(normalizedText)) {
      categories.add(category)
      evidence.add(`intent.keyword.${category}`)
    }
  }
  const operation = intent.signals?.operation
  if (operation) {
    for (const category of OPERATION_CATEGORIES[operation] ?? []) categories.add(category)
    evidence.add(`signal.operation.${operation}`)
  }
  if (intent.signals?.handlesSecrets) {
    categories.add('security')
    categories.add('data-sensitive')
    evidence.add('signal.handles-secrets')
  }
  if (intent.signals?.dataMigration) {
    categories.add('implementation')
    categories.add('architecture')
    evidence.add('signal.data-migration')
  }
  if (intent.signals?.productionImpact) {
    categories.add('architecture')
    evidence.add('signal.production-impact')
  }
  if (intent.signals?.destructive) {
    categories.add('security')
    evidence.add('signal.destructive')
  }
  if (intent.signals?.dataSensitivity && ['confidential', 'restricted'].includes(intent.signals.dataSensitivity)) {
    categories.add('data-sensitive')
    evidence.add(`signal.data-sensitivity.${intent.signals.dataSensitivity}`)
  }
  if (!categories.size) {
    categories.add('implementation')
    evidence.add('intent.default-conservative')
  }
  return { categories: sortedUnique([...categories]), evidence: sortedUnique([...evidence]) }
}

function intentFingerprint(intent: TaskIntent): string {
  return stableFingerprint({
    text: normalizeText(intent.text),
    categories: sortedUnique(intent.categories ?? []),
    signals: {
      ...intent.signals,
      requiredCapabilities: sortedUnique(intent.signals?.requiredCapabilities ?? []),
      requiredTools: sortedUnique(intent.signals?.requiredTools ?? [])
    }
  })
}

function baseline(intent: TaskIntent, policyRevision: string): ExecutionRequirementSet {
  const detected = detectCategories(intent)
  const profiles = detected.categories.map((category) => PROFILES[category])
  const highestLatency = strictest(
    profiles.map((profile) => profile.latency.priority),
    LATENCY_ORDER
  )
  const retention = profiles.map((profile) => profile.privacy.maxRetentionDays).filter((value): value is number => value !== null)
  const capabilities = sortedUnique([...profiles.flatMap((profile) => profile.capabilities), ...(intent.signals?.requiredCapabilities ?? [])])
  if ((intent.signals?.estimatedInputTokens ?? 0) > 32_000 && !capabilities.includes('long-context')) capabilities.push('long-context')
  const requirement: ExecutionRequirementSet = {
    schemaVersion: 1,
    id: '',
    taskFingerprint: intentFingerprint(intent),
    policyRevision,
    classifier: {
      version: TASK_INTENT_CLASSIFIER_VERSION,
      categories: detected.categories,
      assessedRisk: strictest(
        profiles.map((profile) => profile.risk),
        RISK_ORDER
      ),
      evidence: detected.evidence
    },
    effective: {
      capabilities: {
        required: sortedUnique(capabilities),
        minimumEffort: strictest(
          profiles.map((profile) => profile.minimumEffort),
          EFFORT_ORDER
        )
      },
      acceptableRisk: {
        failureTolerance: strictest(
          profiles.map((profile) => profile.failureTolerance),
          TOLERANCE_ORDER
        )
      },
      validation: {
        minimum: strictest(
          profiles.map((profile) => profile.validation),
          VALIDATION_ORDER
        ),
        requiredChecks: sortedUnique(profiles.flatMap((profile) => profile.checks))
      },
      latency: {
        priority: highestLatency,
        maximumPlanP95Ms: highestLatency === 'throughput' ? null : Math.min(...profiles.map((profile) => profile.latency.maximumPlanP95Ms ?? Number.MAX_SAFE_INTEGER))
      },
      context: {
        minimumWindowTokens: Math.max(...profiles.map((profile) => profile.context.minimumWindowTokens), intent.signals?.estimatedInputTokens ?? 0),
        minimumOutputTokens: Math.max(...profiles.map((profile) => profile.context.minimumOutputTokens), intent.signals?.estimatedOutputTokens ?? 0),
        mode: strictest(
          profiles.map((profile) => profile.context.mode),
          CONTEXT_ORDER
        )
      },
      privacy: {
        allowedBoundaries: profiles.map((profile) => profile.privacy.allowedBoundaries).reduce(intersect),
        allowedTrainingUse: profiles.map((profile) => profile.privacy.allowedTrainingUse).reduce(intersect),
        maxRetentionDays: retention.length ? Math.min(...retention) : null
      },
      tools: {
        required: sortedUnique([...profiles.flatMap((profile) => profile.tools.required), ...(intent.signals?.requiredTools ?? [])]),
        forbidden: sortedUnique(profiles.flatMap((profile) => profile.tools.forbidden)),
        requireApproval: profiles.some((profile) => profile.tools.requireApproval)
      }
    },
    resolution: { status: 'resolved', decisions: [] }
  }
  return finalizeExecutionRequirementSet(requirement)
}

export function classifyTaskIntent(intent: TaskIntent, options: ClassifyTaskIntentOptions = {}): ExecutionRequirementSet {
  validateIntent(intent)
  const workflow = options.workflowConstraints ?? []
  const user = options.userConstraints ?? []
  if (workflow.some((constraint) => constraint.source !== 'workflow')) throw new Error('workflowConstraints may contain only workflow overrides.')
  if (user.some((constraint) => constraint.source !== 'user')) throw new Error('userConstraints may contain only user overrides.')
  const requirement = baseline(intent, options.policyRevision ?? EXECUTION_REQUIREMENT_POLICY_REVISION)
  return applyExecutionRequirementOverrides(requirement, [...workflow, ...user])
}
