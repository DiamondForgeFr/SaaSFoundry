import type { ValidationCheck } from './requirements'
import type { NormalizedEffort, PriceDimensionKind, RuntimeKind } from './types'
import { assertExactCostEvidence, compareExactCosts, ExactRational } from './exact-cost'
import { stableFingerprint } from './overrides'

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
const EFFORTS: NormalizedEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'custom']
const RUNTIMES: RuntimeKind[] = ['cloud', 'local', 'hybrid']
const BOUNDARIES = ['local-device', 'customer-controlled', 'provider-managed', 'unknown'] as const
const DECISION_FIELDS = [
  'schemaVersion',
  'id',
  'status',
  'requirementsId',
  'catalogueGeneratedAt',
  'catalogueFingerprint',
  'planningAt',
  'policyFingerprint',
  'selected',
  'qualified',
  'exclusions',
  'tieBreakDecisions'
] as const
const QUALIFIED_FIELDS = [
  'proposalId',
  'proposalFingerprint',
  'rootCandidateId',
  'rootEffort',
  'rootRuntimeKind',
  'rootBoundary',
  'nodeCount',
  'maximumPathLatencyP95Ms',
  'approvalRequired',
  'checks',
  'evidenceRefs',
  'nodeCosts',
  'expectedAggregateP95',
  'maximumPathP95'
] as const
const NODE_COST_FIELDS = ['nodeId', 'candidateId', 'reachProbability', 'invocationP95', 'weightedP95'] as const
const PROBABILITY_FIELDS = ['numerator', 'denominator'] as const
const EXCLUSION_FIELDS = ['proposalId', 'proposalFingerprint', 'nodeId', 'candidateId', 'code', 'detailCode'] as const
const TIE_BREAK_FIELDS = ['winnerProposalId', 'loserProposalId', 'rule'] as const
const DECISION_STATUSES: ExecutionPlanDecision['status'][] = ['selected', 'unplannable', 'requirements-unsatisfiable']
const EXCLUSION_CODES: ExecutionPlanExclusionCode[] = [
  'requirements-unsatisfiable',
  'invalid-proposal',
  'candidate-missing',
  'candidate-stale',
  'capability-mismatch',
  'effort-mismatch',
  'context-mismatch',
  'privacy-mismatch',
  'retention-unknown',
  'retention-mismatch',
  'tool-mismatch',
  'validation-mismatch',
  'independence-mismatch',
  'latency-unknown',
  'latency-mismatch',
  'evidence-stale',
  'price-incomplete',
  'currency-uncomparable'
]
const TIE_BREAK_RULES: ExecutionPlanTieBreakDecision['rule'][] = [
  'expected-aggregate-p95',
  'lower-max-path-cost',
  'lower-p95-latency',
  'fewer-nodes',
  'prefer-local',
  'higher-effort',
  'canonical-proposal-id'
]
const FINGERPRINT = /^[a-f0-9]{64}$/

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
  rootRuntimeKind: RuntimeKind
  rootBoundary: string
  nodeCount: number
  maximumPathLatencyP95Ms: number | null
  approvalRequired: boolean
  checks: ValidationCheck[]
  evidenceRefs: string[]
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
  catalogueFingerprint: string
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
    super(`Invalid execution plan contract: ${issues.join('; ')}`)
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

function validateExact(value: unknown, label: string, issues: string[]): void {
  try {
    assertExactCostEvidence(value, label)
  } catch (error) {
    issues.push(error instanceof Error ? error.message : `${label} is invalid`)
  }
}

function validateQualifiedPlan(value: unknown, label: string, issues: string[]): value is QualifiedExecutionPlan {
  if (!object(value)) {
    issues.push(`${label} must be an object`)
    return false
  }
  rejectUnknown(value, QUALIFIED_FIELDS, label, issues)
  if (!safeId(value.proposalId)) issues.push(`${label}.proposalId must be a safe public identifier`)
  if (typeof value.proposalFingerprint !== 'string' || !FINGERPRINT.test(value.proposalFingerprint)) issues.push(`${label}.proposalFingerprint must be a SHA-256 fingerprint`)
  if (!safeId(value.rootCandidateId)) issues.push(`${label}.rootCandidateId must be a safe public identifier`)
  if (!EFFORTS.includes(value.rootEffort as NormalizedEffort)) issues.push(`${label}.rootEffort is unsupported`)
  if (!RUNTIMES.includes(value.rootRuntimeKind as RuntimeKind)) issues.push(`${label}.rootRuntimeKind is unsupported`)
  if (!BOUNDARIES.includes(value.rootBoundary as (typeof BOUNDARIES)[number])) issues.push(`${label}.rootBoundary is unsupported`)
  if (!Number.isSafeInteger(value.nodeCount) || Number(value.nodeCount) < 1) issues.push(`${label}.nodeCount must be a positive safe integer`)
  if (value.maximumPathLatencyP95Ms !== null && (!Number.isSafeInteger(value.maximumPathLatencyP95Ms) || Number(value.maximumPathLatencyP95Ms) < 0))
    issues.push(`${label}.maximumPathLatencyP95Ms must be a non-negative safe integer or null`)
  if (typeof value.approvalRequired !== 'boolean') issues.push(`${label}.approvalRequired must be a boolean`)
  validateUniqueIds(value.checks, CHECKS, `${label}.checks`, issues)
  validateUniqueIds(value.evidenceRefs, null, `${label}.evidenceRefs`, issues)
  if (!Array.isArray(value.nodeCosts) || value.nodeCosts.length === 0) issues.push(`${label}.nodeCosts must be a non-empty array`)
  else {
    const nodeIds = new Set<string>()
    value.nodeCosts.forEach((rawCost, index) => {
      const costLabel = `${label}.nodeCosts[${index}]`
      if (!object(rawCost)) {
        issues.push(`${costLabel} must be an object`)
        return
      }
      rejectUnknown(rawCost, NODE_COST_FIELDS, costLabel, issues)
      if (!safeId(rawCost.nodeId)) issues.push(`${costLabel}.nodeId must be a safe public identifier`)
      else if (nodeIds.has(rawCost.nodeId)) issues.push(`${costLabel}.nodeId must be unique`)
      else nodeIds.add(rawCost.nodeId)
      if (!safeId(rawCost.candidateId)) issues.push(`${costLabel}.candidateId must be a safe public identifier`)
      if (!object(rawCost.reachProbability)) issues.push(`${costLabel}.reachProbability must be an object`)
      else {
        rejectUnknown(rawCost.reachProbability, PROBABILITY_FIELDS, `${costLabel}.reachProbability`, issues)
        try {
          if (typeof rawCost.reachProbability.numerator !== 'string' || typeof rawCost.reachProbability.denominator !== 'string') throw new Error()
          const probability = ExactRational.evidence({ numerator: rawCost.reachProbability.numerator, denominator: rawCost.reachProbability.denominator })
          if (probability.compare(new ExactRational(1n)) > 0) issues.push(`${costLabel}.reachProbability must not exceed one`)
        } catch {
          issues.push(`${costLabel}.reachProbability must be a reduced non-negative rational`)
        }
      }
      validateExact(rawCost.invocationP95, `${costLabel}.invocationP95`, issues)
      validateExact(rawCost.weightedP95, `${costLabel}.weightedP95`, issues)
    })
    if (Number.isSafeInteger(value.nodeCount) && value.nodeCosts.length !== value.nodeCount) issues.push(`${label}.nodeCount must match nodeCosts length`)
  }
  validateExact(value.expectedAggregateP95, `${label}.expectedAggregateP95`, issues)
  validateExact(value.maximumPathP95, `${label}.maximumPathP95`, issues)
  try {
    if (compareExactCosts(value.expectedAggregateP95 as ExactCostEvidence, value.maximumPathP95 as ExactCostEvidence) > 0) issues.push(`${label}.maximumPathP95 must cover expectedAggregateP95`)
  } catch {
    // Individual evidence validation reports the actionable issue.
  }
  return true
}

/** Validates an immutable planner ledger after a JSON or process boundary. */
export function assertExecutionPlanDecision(value: unknown): asserts value is ExecutionPlanDecision {
  const issues: string[] = []
  if (!object(value)) throw new ExecutionPlanContractError(['decision must be an object'])
  rejectUnknown(value, DECISION_FIELDS, 'decision', issues)
  if (value.schemaVersion !== 1) issues.push('decision.schemaVersion must equal 1')
  if (typeof value.id !== 'string' || !FINGERPRINT.test(value.id)) issues.push('decision.id must be a SHA-256 fingerprint')
  if (!DECISION_STATUSES.includes(value.status as ExecutionPlanDecision['status'])) issues.push('decision.status is unsupported')
  if (!safeId(value.requirementsId)) issues.push('decision.requirementsId must be a safe public identifier')
  if (typeof value.catalogueFingerprint !== 'string' || !FINGERPRINT.test(value.catalogueFingerprint)) issues.push('decision.catalogueFingerprint must be a SHA-256 fingerprint')
  if (typeof value.policyFingerprint !== 'string' || !FINGERPRINT.test(value.policyFingerprint)) issues.push('decision.policyFingerprint must be a SHA-256 fingerprint')
  const selectedStatus = value.status === 'selected'
  if (selectedStatus) {
    if (!timestamp(value.catalogueGeneratedAt)) issues.push('decision.catalogueGeneratedAt must be a canonical UTC timestamp')
    if (!timestamp(value.planningAt)) issues.push('decision.planningAt must be a canonical UTC timestamp')
    if (timestamp(value.catalogueGeneratedAt) && timestamp(value.planningAt) && value.catalogueGeneratedAt > value.planningAt)
      issues.push('decision.catalogueGeneratedAt must not be later than planningAt')
  } else {
    if (!safeId(value.catalogueGeneratedAt)) issues.push('decision.catalogueGeneratedAt must be a safe timestamp or failure identifier')
    if (!safeId(value.planningAt)) issues.push('decision.planningAt must be a safe timestamp or failure identifier')
  }
  let selectedValid = false
  if (value.selected !== undefined) selectedValid = validateQualifiedPlan(value.selected, 'decision.selected', issues)
  if (selectedStatus !== (value.selected !== undefined)) issues.push('decision.selected must exist exactly when status is selected')
  if (!Array.isArray(value.qualified)) issues.push('decision.qualified must be an array')
  else {
    value.qualified.forEach((plan, index) => validateQualifiedPlan(plan, `decision.qualified[${index}]`, issues))
    const proposalIds = value.qualified
      .filter(object)
      .map((plan) => plan.proposalId)
      .filter((id): id is string => typeof id === 'string')
    if (new Set(proposalIds).size !== proposalIds.length) issues.push('decision.qualified proposal IDs must be unique')
    if (!selectedStatus && value.qualified.length !== 0) issues.push('decision.qualified must be empty without a selected plan')
    if (selectedStatus && (value.qualified.length === 0 || !selectedValid || stableFingerprint(value.selected) !== stableFingerprint(value.qualified[0])))
      issues.push('decision.selected must equal the first qualified plan')
  }
  if (!Array.isArray(value.exclusions)) issues.push('decision.exclusions must be an array')
  else
    value.exclusions.forEach((rawExclusion, index) => {
      const label = `decision.exclusions[${index}]`
      if (!object(rawExclusion)) {
        issues.push(`${label} must be an object`)
        return
      }
      rejectUnknown(rawExclusion, EXCLUSION_FIELDS, label, issues)
      if (!safeId(rawExclusion.proposalId)) issues.push(`${label}.proposalId must be a safe public identifier`)
      if (rawExclusion.proposalFingerprint !== undefined && (typeof rawExclusion.proposalFingerprint !== 'string' || !FINGERPRINT.test(rawExclusion.proposalFingerprint)))
        issues.push(`${label}.proposalFingerprint must be a SHA-256 fingerprint`)
      if (rawExclusion.nodeId !== undefined && !safeId(rawExclusion.nodeId)) issues.push(`${label}.nodeId must be a safe public identifier`)
      if (rawExclusion.candidateId !== undefined && !safeId(rawExclusion.candidateId)) issues.push(`${label}.candidateId must be a safe public identifier`)
      if (!EXCLUSION_CODES.includes(rawExclusion.code as ExecutionPlanExclusionCode)) issues.push(`${label}.code is unsupported`)
      if (rawExclusion.detailCode !== undefined && !safeId(rawExclusion.detailCode)) issues.push(`${label}.detailCode must be a safe public identifier`)
    })
  if (!Array.isArray(value.tieBreakDecisions)) issues.push('decision.tieBreakDecisions must be an array')
  else
    value.tieBreakDecisions.forEach((rawTieBreak, index) => {
      const label = `decision.tieBreakDecisions[${index}]`
      if (!object(rawTieBreak)) {
        issues.push(`${label} must be an object`)
        return
      }
      rejectUnknown(rawTieBreak, TIE_BREAK_FIELDS, label, issues)
      if (!safeId(rawTieBreak.winnerProposalId)) issues.push(`${label}.winnerProposalId must be a safe public identifier`)
      if (!safeId(rawTieBreak.loserProposalId)) issues.push(`${label}.loserProposalId must be a safe public identifier`)
      if (!TIE_BREAK_RULES.includes(rawTieBreak.rule as ExecutionPlanTieBreakDecision['rule'])) issues.push(`${label}.rule is unsupported`)
    })
  if (typeof value.id === 'string' && FINGERPRINT.test(value.id)) {
    const payload = { ...value }
    delete payload.id
    if (value.id !== stableFingerprint(payload)) issues.push('decision.id does not match its canonical payload')
  }
  if (issues.length) throw new ExecutionPlanContractError(issues)
}
