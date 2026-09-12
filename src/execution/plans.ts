import type { ValidationCheck } from './requirements'
import type { NormalizedEffort, PriceDimensionKind } from './types'

const SAFE_ID = /^[a-z0-9][a-z0-9._:/-]{0,127}$/i
const SECRET_LIKE = /(?:\bBearer\s+|\b(?:sk|gh[pousr]|github_pat|xox[baprs])[_-]|\beyJ[a-zA-Z0-9_-]{8,}\.)/i
const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/
const PLAN_FIELDS = ['schemaVersion', 'id', 'rootNodeId', 'nodes'] as const
const NODE_FIELDS = ['id', 'role', 'candidateId', 'estimate', 'tools', 'checks', 'outcomes'] as const
const ESTIMATE_FIELDS = ['usageP95', 'latencyP95Ms', 'observedAt', 'validUntil', 'evidenceRef', 'independenceDomain'] as const
const OUTCOME_FIELDS = ['code', 'conditionalProbability', 'nextNodeId', 'evidenceRef'] as const
const ROLES: ExecutionPlanNodeRole[] = ['primary', 'validation', 'retry', 'fallback']
const OUTCOMES: ExecutionOutcomeCode[] = ['success', 'execution-failed', 'validation-failed', 'candidate-unavailable']
const CHECKS: ValidationCheck[] = ['self-review', 'type-check', 'automated-tests', 'integration-tests', 'independent-review', 'security-tests']
const PRICE_DIMENSIONS: PriceDimensionKind[] = ['input-token', 'output-token', 'cached-input-token', 'request', 'second', 'minute', 'tool-call']

export type ExecutionPlanNodeRole = 'primary' | 'validation' | 'retry' | 'fallback'
export type ExecutionOutcomeCode = 'success' | 'execution-failed' | 'validation-failed' | 'candidate-unavailable'

/** Provider-neutral p95 quantities for every billable dimension used by a node. */
export type BillableUsageP95 = Partial<Record<PriceDimensionKind, string>>

export interface ExecutionPlanOutcome {
  code: ExecutionOutcomeCode
  /** Exact decimal in `(0, 1]`; outcomes on a node must sum to exactly one. */
  conditionalProbability: string
  /** Omitted when this outcome terminates the execution tree. */
  nextNodeId?: string
  /** Stable public evidence identifier, never an observation payload. */
  evidenceRef: string
}

export interface ExecutionPlanNodeEstimate {
  usageP95: BillableUsageP95
  /** `null` means latency evidence is unavailable and cannot satisfy a latency ceiling. */
  latencyP95Ms: number | null
  observedAt: string
  validUntil: string
  evidenceRef: string
  /** Separate domains are required for independent validation. */
  independenceDomain: string
}

export interface ExecutionPlanNode {
  id: string
  role: ExecutionPlanNodeRole
  candidateId: string
  estimate: ExecutionPlanNodeEstimate
  /** Tools this node will invoke, not every tool the candidate supports. */
  tools: string[]
  /** Checks performed by this node. */
  checks: ValidationCheck[]
  outcomes: ExecutionPlanOutcome[]
}

/** A finite, fully unrolled execution tree submitted for qualification and ranking. */
export interface ExecutionPlanProposal {
  schemaVersion: 1
  id: string
  rootNodeId: string
  nodes: ExecutionPlanNode[]
}

export type ExecutionPlanTieBreaker = 'lower-max-path-cost' | 'lower-p95-latency' | 'fewer-nodes' | 'prefer-local' | 'higher-effort'

export interface ExecutionPlanSelectionPolicy {
  schemaVersion: 1
  /** Explicit deterministic planning time used for all freshness checks. */
  planningAt: string
  /** ISO 4217 code shared by every plan entering price comparison. */
  settlementCurrency: string
  /** Decimal places used only for final upward-rounded display amounts. */
  displayScale: number
  tieBreakers: ExecutionPlanTieBreaker[]
}

export interface ExactCostEvidence {
  currency: string
  /** Reduced exact rational used for comparison. */
  numerator: string
  denominator: string
  /** Human-readable amount, rounded upward once to `scale`. */
  amount: string
  scale: number
  rounding: 'ceiling'
}

export interface ExecutionPlanNodeCost {
  nodeId: string
  candidateId: string
  reachProbability: { numerator: string; denominator: string }
  invocationP95: ExactCostEvidence
  weightedP95: ExactCostEvidence
}

export interface QualifiedExecutionPlan {
  proposalId: string
  proposalFingerprint: string
  rootCandidateId: string
  rootEffort: NormalizedEffort
  rootBoundary: string
  nodeCount: number
  maximumPathLatencyP95Ms: number | null
  approvalRequired: boolean
  checks: ValidationCheck[]
  nodeCosts: ExecutionPlanNodeCost[]
  expectedAggregateP95: ExactCostEvidence
  maximumPathP95: ExactCostEvidence
}

export type ExecutionPlanQualificationResult = { status: 'qualified'; plan: QualifiedExecutionPlan } | { status: 'excluded'; exclusions: ExecutionPlanExclusion[] }

export type ExecutionPlanExclusionCode =
  | 'requirements-unsatisfiable'
  | 'invalid-proposal'
  | 'candidate-missing'
  | 'candidate-stale'
  | 'capability-mismatch'
  | 'effort-mismatch'
  | 'context-mismatch'
  | 'privacy-mismatch'
  | 'retention-unknown'
  | 'retention-mismatch'
  | 'tool-mismatch'
  | 'validation-mismatch'
  | 'independence-mismatch'
  | 'latency-unknown'
  | 'latency-mismatch'
  | 'evidence-stale'
  | 'price-incomplete'
  | 'currency-uncomparable'

export interface ExecutionPlanExclusion {
  proposalId: string
  proposalFingerprint?: string
  nodeId?: string
  candidateId?: string
  code: ExecutionPlanExclusionCode
  detailCode?: string
}

export interface ExecutionPlanTieBreakDecision {
  winnerProposalId: string
  loserProposalId: string
  rule: 'expected-aggregate-p95' | ExecutionPlanTieBreaker | 'canonical-proposal-id'
}

export interface ExecutionPlanDecision {
  schemaVersion: 1
  id: string
  status: 'selected' | 'unplannable' | 'requirements-unsatisfiable'
  requirementsId: string
  catalogueGeneratedAt: string
  planningAt: string
  policyFingerprint: string
  selected?: QualifiedExecutionPlan
  qualified: QualifiedExecutionPlan[]
  exclusions: ExecutionPlanExclusion[]
  tieBreakDecisions: ExecutionPlanTieBreakDecision[]
}

export class ExecutionPlanContractError extends Error {
  readonly issues: string[]

  constructor(issues: string[]) {
    super(`Invalid execution plan proposal: ${issues.join('; ')}`)
    this.name = 'ExecutionPlanContractError'
    this.issues = [...issues]
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function safeId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID.test(value) && !SECRET_LIKE.test(value)
}

function timestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value
}

function rejectUnknown(value: Record<string, unknown>, allowed: readonly string[], label: string, issues: string[]): void {
  const unknown = Object.keys(value).filter((field) => !allowed.includes(field))
  if (unknown.length) issues.push(`${label} contains unsupported fields: ${unknown.sort().join(', ')}`)
}

function validateUniqueIds(value: unknown, allowed: readonly string[] | null, label: string, issues: string[]): void {
  if (!Array.isArray(value) || value.some((entry) => !safeId(entry))) {
    issues.push(`${label} must contain safe public identifiers`)
    return
  }
  if (allowed && value.some((entry) => !allowed.includes(entry as string))) issues.push(`${label} contains unsupported values`)
  if (new Set(value).size !== value.length) issues.push(`${label} must not contain duplicates`)
}

/** Validates the closed provider-neutral boundary before graph qualification or costing. */
export function assertExecutionPlanProposal(value: unknown): asserts value is ExecutionPlanProposal {
  const issues: string[] = []
  if (!object(value)) throw new ExecutionPlanContractError(['proposal must be an object'])
  rejectUnknown(value, PLAN_FIELDS, 'proposal', issues)
  if (value.schemaVersion !== 1) issues.push('schemaVersion must equal 1')
  if (!safeId(value.id)) issues.push('id must be a safe public identifier')
  if (!safeId(value.rootNodeId)) issues.push('rootNodeId must be a safe public identifier')
  if (!Array.isArray(value.nodes) || value.nodes.length === 0) issues.push('nodes must be a non-empty array')
  else {
    const nodeIds = new Set<string>()
    value.nodes.forEach((rawNode, nodeIndex) => {
      const label = `nodes[${nodeIndex}]`
      if (!object(rawNode)) {
        issues.push(`${label} must be an object`)
        return
      }
      rejectUnknown(rawNode, NODE_FIELDS, label, issues)
      if (!safeId(rawNode.id)) issues.push(`${label}.id must be a safe public identifier`)
      else if (nodeIds.has(rawNode.id)) issues.push(`${label}.id must be unique`)
      else nodeIds.add(rawNode.id)
      if (!ROLES.includes(rawNode.role as ExecutionPlanNodeRole)) issues.push(`${label}.role is unsupported`)
      if (!safeId(rawNode.candidateId)) issues.push(`${label}.candidateId must be a safe public identifier`)
      validateUniqueIds(rawNode.tools, null, `${label}.tools`, issues)
      validateUniqueIds(rawNode.checks, CHECKS, `${label}.checks`, issues)
      if (!object(rawNode.estimate)) issues.push(`${label}.estimate must be an object`)
      else {
        rejectUnknown(rawNode.estimate, ESTIMATE_FIELDS, `${label}.estimate`, issues)
        if (!object(rawNode.estimate.usageP95)) issues.push(`${label}.estimate.usageP95 must be an object`)
        else {
          rejectUnknown(rawNode.estimate.usageP95, PRICE_DIMENSIONS, `${label}.estimate.usageP95`, issues)
          for (const [dimension, quantity] of Object.entries(rawNode.estimate.usageP95)) {
            if (typeof quantity !== 'string' || !DECIMAL.test(quantity)) issues.push(`${label}.estimate.usageP95.${dimension} must be a non-negative decimal string`)
          }
        }
        if (rawNode.estimate.latencyP95Ms !== null && (!Number.isSafeInteger(rawNode.estimate.latencyP95Ms) || Number(rawNode.estimate.latencyP95Ms) < 0))
          issues.push(`${label}.estimate.latencyP95Ms must be a non-negative safe integer or null`)
        if (!timestamp(rawNode.estimate.observedAt)) issues.push(`${label}.estimate.observedAt must be a canonical UTC timestamp`)
        if (!timestamp(rawNode.estimate.validUntil)) issues.push(`${label}.estimate.validUntil must be a canonical UTC timestamp`)
        if (timestamp(rawNode.estimate.observedAt) && timestamp(rawNode.estimate.validUntil) && rawNode.estimate.validUntil <= rawNode.estimate.observedAt)
          issues.push(`${label}.estimate.validUntil must be later than observedAt`)
        if (!safeId(rawNode.estimate.evidenceRef)) issues.push(`${label}.estimate.evidenceRef must be a safe public identifier`)
        if (!safeId(rawNode.estimate.independenceDomain)) issues.push(`${label}.estimate.independenceDomain must be a safe public identifier`)
      }
      if (!Array.isArray(rawNode.outcomes) || rawNode.outcomes.length === 0) issues.push(`${label}.outcomes must be a non-empty array`)
      else
        rawNode.outcomes.forEach((rawOutcome, outcomeIndex) => {
          const outcomeLabel = `${label}.outcomes[${outcomeIndex}]`
          if (!object(rawOutcome)) {
            issues.push(`${outcomeLabel} must be an object`)
            return
          }
          rejectUnknown(rawOutcome, OUTCOME_FIELDS, outcomeLabel, issues)
          if (!OUTCOMES.includes(rawOutcome.code as ExecutionOutcomeCode)) issues.push(`${outcomeLabel}.code is unsupported`)
          if (typeof rawOutcome.conditionalProbability !== 'string' || !DECIMAL.test(rawOutcome.conditionalProbability))
            issues.push(`${outcomeLabel}.conditionalProbability must be a non-negative decimal string`)
          if (rawOutcome.nextNodeId !== undefined && !safeId(rawOutcome.nextNodeId)) issues.push(`${outcomeLabel}.nextNodeId must be a safe public identifier when present`)
          if (!safeId(rawOutcome.evidenceRef)) issues.push(`${outcomeLabel}.evidenceRef must be a safe public identifier`)
        })
    })
    if (safeId(value.rootNodeId) && !nodeIds.has(value.rootNodeId)) issues.push('rootNodeId must reference a declared node')
  }
  if (issues.length) throw new ExecutionPlanContractError(issues)
}
