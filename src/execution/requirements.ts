import type { NormalizedEffort, PrivacyBoundary, TrainingUse } from './types'

export type TaskCategory = 'mechanical' | 'implementation' | 'architecture' | 'security' | 'data-sensitive'
export type TaskOperation = 'read' | 'document' | 'rename' | 'edit' | 'generate' | 'refactor' | 'migrate' | 'deploy' | 'architecture' | 'security-review'
export type TaskRiskLevel = 'low' | 'medium' | 'high' | 'critical'
export type FailureTolerance = 'low' | 'medium' | 'high'
export type ValidationRigor = 'self-check' | 'automated-checks' | 'independent-review' | 'independent-review-and-tests'
export type ValidationCheck = 'self-review' | 'type-check' | 'automated-tests' | 'integration-tests' | 'independent-review' | 'security-tests'
export type LatencyPriority = 'interactive' | 'balanced' | 'throughput'
export type ContextMode = 'partitionable' | 'single-candidate'
export type DataSensitivity = 'public' | 'internal' | 'confidential' | 'restricted'
export type RequirementEffort = Exclude<NormalizedEffort, 'none' | 'custom'>
export type ExecutionCapability = 'text' | 'code' | 'repository-analysis' | 'system-design' | 'security-analysis' | 'tool-use' | 'long-context'

export interface TaskIntent {
  /** Raw task text is classified in memory and never copied into a requirement set. */
  text: string
  /** Explicit normalized categories supplied by the active agent or workflow. */
  categories?: TaskCategory[]
  signals?: {
    operation?: TaskOperation
    productionImpact?: boolean
    handlesSecrets?: boolean
    destructive?: boolean
    dataMigration?: boolean
    estimatedInputTokens?: number
    estimatedOutputTokens?: number
    requiredCapabilities?: ExecutionCapability[]
    requiredTools?: string[]
    dataSensitivity?: DataSensitivity
  }
}

export interface ExecutionRequirementPatch {
  minimumEffort?: RequirementEffort
  requiredCapabilities?: ExecutionCapability[]
  validationMinimum?: ValidationRigor
  requiredChecks?: ValidationCheck[]
  maximumPlanP95Ms?: number
  minimumWindowTokens?: number
  minimumOutputTokens?: number
  contextMode?: ContextMode
  allowedPrivacyBoundaries?: PrivacyBoundary[]
  allowedTrainingUse?: TrainingUse[]
  maxRetentionDays?: number
  requiredTools?: string[]
  forbiddenTools?: string[]
  requireApproval?: boolean
}

export interface ExecutionRequirementOverride {
  /** Stable, non-secret identifier used for deterministic ordering and audit. */
  id: string
  source: 'workflow' | 'user'
  /** Workflow rule or user-action identifier; never raw user text. */
  reference: string
  appliesTo: 'this-task' | 'future-replans'
  changes: ExecutionRequirementPatch
}

export type RequirementDecisionReason =
  | 'constraint-applied'
  | 'already-satisfied'
  | 'would-weaken-required-floor'
  | 'would-widen-privacy-boundary'
  | 'would-disable-required-approval'
  | 'constraint-conflict'

export interface RequirementDecision {
  overrideId: string
  source: ExecutionRequirementOverride['source']
  reference: string
  appliesTo: ExecutionRequirementOverride['appliesTo']
  field: keyof ExecutionRequirementPatch
  status: 'applied' | 'rejected'
  reason: RequirementDecisionReason
}

export interface ExecutionRequirementSet {
  schemaVersion: 1
  /** SHA-256 of the complete canonical requirement payload. */
  id: string
  /** SHA-256 of normalized task input; raw task text is not retained. */
  taskFingerprint: string
  policyRevision: string
  classifier: {
    version: string
    categories: TaskCategory[]
    assessedRisk: TaskRiskLevel
    evidence: string[]
  }
  effective: {
    capabilities: {
      required: ExecutionCapability[]
      minimumEffort: RequirementEffort
    }
    acceptableRisk: {
      failureTolerance: FailureTolerance
    }
    validation: {
      minimum: ValidationRigor
      requiredChecks: ValidationCheck[]
    }
    latency: {
      priority: LatencyPriority
      maximumPlanP95Ms: number | null
    }
    context: {
      minimumWindowTokens: number
      minimumOutputTokens: number
      mode: ContextMode
    }
    privacy: {
      allowedBoundaries: PrivacyBoundary[]
      allowedTrainingUse: TrainingUse[]
      maxRetentionDays: number | null
    }
    tools: {
      required: string[]
      forbidden: string[]
      requireApproval: boolean
    }
  }
  resolution: {
    status: 'resolved' | 'unsatisfiable'
    decisions: RequirementDecision[]
  }
}

export interface ClassifyTaskIntentOptions {
  policyRevision?: string
  workflowConstraints?: ExecutionRequirementOverride[]
  userConstraints?: ExecutionRequirementOverride[]
}
