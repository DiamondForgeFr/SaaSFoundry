import { assertExecutionCandidate } from './catalogue'
import { assertExactCostEvidence, calculateExactUsageCost, compareExactCosts, ExactRational, exactCostEvidence } from './exact-cost'
import { stableFingerprint } from './overrides'
import { assertExecutionPlanDecision, type BillableUsageP95, type ExactCostEvidence, type ExecutionPlanDecision, type ExecutionPlanSelectionPolicy } from './plans'
import { fingerprintExecutionCandidateCatalogue } from './planner'
import type { ExecutionCandidateCatalogueSnapshot, NormalizedEffort, PriceDimensionKind } from './types'

const SAFE_ID = /^[a-z0-9][a-z0-9._:/-]{0,127}$/i
const SECRET_LIKE = /(?:\bBearer\s+|\b(?:sk|gh[pousr]|github_pat|xox[baprs])[_-]|\beyJ[a-zA-Z0-9_-]{8,}\.)/i
const FINGERPRINT = /^[a-f0-9]{64}$/
const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/
const DIMENSIONS: PriceDimensionKind[] = ['input-token', 'output-token', 'cached-input-token', 'request', 'second', 'minute', 'tool-call']
const EFFORTS: NormalizedEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'custom']
const REASONS = ['quality-requirement', 'validation-requirement', 'fallback-resilience', 'tool-capability', 'privacy-requirement', 'latency-requirement'] as const
const BENEFITS = ['higher-quality', 'independent-validation', 'fallback-resilience', 'required-tool-access', 'privacy-compliance', 'latency-compliance'] as const
const SESSION_FIELDS = ['schemaVersion', 'sessionId', 'candidateId', 'usageP95', 'observedAt', 'validUntil', 'evidenceRef', 'authorityRevision'] as const
const ENVELOPE_FIELDS = [
  'schemaVersion',
  'id',
  'sessionId',
  'candidateId',
  'effort',
  'workloadFingerprint',
  'catalogueFingerprint',
  'policyFingerprint',
  'authorityRevision',
  'planningAt',
  'observedAt',
  'validUntil',
  'currency',
  'displayScale',
  'baselineP95'
] as const
const JUSTIFICATION_FIELDS = ['reasonCode', 'expectedBenefitCodes', 'evidenceRefs'] as const
const GRANT_FIELDS = ['schemaVersion', 'id', 'challengeId', 'sessionId', 'planDecisionId', 'expectedIncrement', 'pathIncrement', 'approvedAt', 'validUntil', 'approvedByRef'] as const
const AUTHORIZATION_FIELDS = ['evaluatedAt', 'justification', 'approval'] as const

export type ExecutionBudgetApprovalReasonCode = (typeof REASONS)[number]
export type ExecutionBudgetBenefitCode = (typeof BENEFITS)[number]
export type ExecutionBudgetDecisionReasonCode =
  | 'within-session-authority'
  | 'plan-exceeds-session-authority'
  | 'approval-granted'
  | 'approval-scope-mismatch'
  | 'requirements-unsatisfiable'
  | 'no-qualified-plan'

export interface SessionWorkloadEvidence {
  schemaVersion: 1
  sessionId: string
  /** Canonical provider/runtime/model/effort identity of the user-facing session. */
  candidateId: string
  usageP95: BillableUsageP95
  observedAt: string
  validUntil: string
  evidenceRef: string
  /** Host-owned revision for the current user-facing session authority. */
  authorityRevision: string
}

export interface SessionBudgetEnvelope {
  schemaVersion: 1
  id: string
  sessionId: string
  candidateId: string
  effort: NormalizedEffort
  workloadFingerprint: string
  catalogueFingerprint: string
  policyFingerprint: string
  authorityRevision: string
  planningAt: string
  observedAt: string
  /** Exclusive freshness boundary. */
  validUntil: string
  currency: string
  displayScale: number
  /** Automatic expected and maximum-path caps both equal this session-derived cost. */
  baselineP95: ExactCostEvidence
}

export interface ExecutionBudgetJustification {
  reasonCode: ExecutionBudgetApprovalReasonCode
  expectedBenefitCodes: ExecutionBudgetBenefitCode[]
  /** Stable safe references only; the host renders human-readable explanations. */
  evidenceRefs: string[]
}

export interface ExecutionBudgetApprovalChallenge {
  schemaVersion: 1
  id: string
  sessionId: string
  authorityRevision: string
  planDecisionId: string
  proposalFingerprint: string
  requirementsId: string
  catalogueFingerprint: string
  policyFingerprint: string
  workloadFingerprint: string
  currency: string
  quotedAt: string
  validUntil: string
  baselineP95: ExactCostEvidence
  expectedAggregateP95: ExactCostEvidence
  maximumPathP95: ExactCostEvidence
  expectedIncrement: ExactCostEvidence
  pathIncrement: ExactCostEvidence
  justification: ExecutionBudgetJustification
  nonMonetaryApprovalRequired: boolean
}

/** Authenticated by the execution host; this contract validates its exact scope. */
export interface ExecutionBudgetApprovalGrant {
  schemaVersion: 1
  /** Unique host approval-event ID or nonce; never derived from public quote inputs. */
  id: string
  challengeId: string
  sessionId: string
  planDecisionId: string
  expectedIncrement: ExactCostEvidence
  pathIncrement: ExactCostEvidence
  approvedAt: string
  validUntil: string
  approvedByRef: string
}

export interface ExecutionBudgetDecision {
  schemaVersion: 1
  id: string
  status: 'authorized' | 'approval-required' | 'rejected'
  mode: 'automatic' | 'approved-increment' | null
  reasonCode: ExecutionBudgetDecisionReasonCode
  evaluatedAt: string
  planDecisionId: string
  proposalFingerprint?: string
  sessionEnvelopeId: string
  sessionId: string
  sessionCandidateId: string
  sessionEffort: NormalizedEffort
  workloadFingerprint: string
  authorityRevision: string
  currency: string
  expectedAggregateP95?: ExactCostEvidence
  maximumPathP95?: ExactCostEvidence
  baselineP95: ExactCostEvidence
  nonMonetaryApprovalRequired: boolean
  challenge?: ExecutionBudgetApprovalChallenge
  approvalEventId?: string
}

export interface ExecutionBudgetAuthorizationInput {
  evaluatedAt: string
  justification?: unknown
  approval?: unknown
}

export class ExecutionBudgetContractError extends Error {
  readonly issues: string[]

  constructor(issues: string[]) {
    super(`Invalid execution budget contract: ${issues.join('; ')}`)
    this.name = 'ExecutionBudgetContractError'
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

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const entry of Object.values(value as Record<string, unknown>)) freeze(entry)
    Object.freeze(value)
  }
  return value
}

function finalize<T extends object>(value: T): T & { id: string } {
  return freeze({ ...value, id: stableFingerprint(value) })
}

function canonicalUsage(value: unknown, issues: string[]): BillableUsageP95 {
  if (!object(value)) {
    issues.push('session.usageP95 must be an object')
    return {}
  }
  rejectUnknown(value, DIMENSIONS, 'session.usageP95', issues)
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
  if (entries.length === 0) issues.push('session.usageP95 must declare every priced dimension')
  for (const [dimension, quantity] of entries)
    if (typeof quantity !== 'string' || quantity.length > 256 || !DECIMAL.test(quantity)) issues.push(`session.usageP95.${dimension} must be a bounded non-negative decimal string`)
  return Object.fromEntries(entries) as BillableUsageP95
}

function validateSelectionPolicy(policy: ExecutionPlanSelectionPolicy): void {
  const issues: string[] = []
  if (policy.schemaVersion !== 1) issues.push('policy.schemaVersion must equal 1')
  if (!timestamp(policy.planningAt)) issues.push('policy.planningAt must be a canonical UTC timestamp')
  if (!/^[A-Z]{3}$/.test(policy.settlementCurrency)) issues.push('policy.settlementCurrency must be an ISO 4217 code')
  if (!Number.isSafeInteger(policy.displayScale) || policy.displayScale < 0 || policy.displayScale > 12) issues.push('policy.displayScale must be a safe integer from 0 to 12')
  const allowedTieBreakers = ['lower-max-path-cost', 'lower-p95-latency', 'fewer-nodes', 'prefer-local', 'higher-effort']
  if (!Array.isArray(policy.tieBreakers) || new Set(policy.tieBreakers).size !== policy.tieBreakers.length || policy.tieBreakers.some((entry) => !allowedTieBreakers.includes(entry)))
    issues.push('policy.tieBreakers must contain unique supported rules')
  if (issues.length) throw new ExecutionBudgetContractError(issues)
}

/** Derives implicit authority from the current user-facing candidate and workload. */
export function deriveSessionBudgetEnvelope(sessionValue: unknown, catalogue: ExecutionCandidateCatalogueSnapshot, policy: ExecutionPlanSelectionPolicy): SessionBudgetEnvelope {
  validateSelectionPolicy(policy)
  const issues: string[] = []
  if (!object(sessionValue)) throw new ExecutionBudgetContractError(['session must be an object'])
  rejectUnknown(sessionValue, SESSION_FIELDS, 'session', issues)
  if (sessionValue.schemaVersion !== 1) issues.push('session.schemaVersion must equal 1')
  if (!safeId(sessionValue.sessionId)) issues.push('session.sessionId must be a safe public identifier')
  if (!safeId(sessionValue.candidateId)) issues.push('session.candidateId must be a safe public identifier')
  if (!safeId(sessionValue.evidenceRef)) issues.push('session.evidenceRef must be a safe public identifier')
  if (!safeId(sessionValue.authorityRevision)) issues.push('session.authorityRevision must be a safe public identifier')
  if (!timestamp(sessionValue.observedAt)) issues.push('session.observedAt must be a canonical UTC timestamp')
  if (!timestamp(sessionValue.validUntil)) issues.push('session.validUntil must be a canonical UTC timestamp')
  if (timestamp(sessionValue.observedAt) && timestamp(sessionValue.validUntil) && sessionValue.observedAt >= sessionValue.validUntil) issues.push('session.validUntil must be later than observedAt')
  const usageP95 = canonicalUsage(sessionValue.usageP95, issues)
  if (!timestamp(catalogue.generatedAt) || catalogue.generatedAt > policy.planningAt) issues.push('catalogue.generatedAt must be a current canonical timestamp')
  const matchingCandidates = catalogue.eligible.filter((entry) => entry.id === sessionValue.candidateId)
  const candidate = matchingCandidates[0]
  if (matchingCandidates.length > 1) issues.push('session candidate must be unique in the eligible catalogue')
  if (!candidate) issues.push('session candidate must exist in the eligible catalogue')
  else {
    try {
      assertExecutionCandidate(candidate)
    } catch {
      issues.push('session candidate must satisfy the public candidate contract')
    }
    if (candidate.availability.state !== 'available') issues.push('session candidate must be available')
    if (!(candidate.availability.checkedAt <= policy.planningAt && policy.planningAt < candidate.availability.validUntil)) issues.push('session candidate availability must be current')
    if (!(candidate.pricing.observedAt <= policy.planningAt && policy.planningAt < candidate.pricing.validUntil)) issues.push('session candidate pricing must be current')
  }
  if (!(String(sessionValue.observedAt) <= policy.planningAt && policy.planningAt < String(sessionValue.validUntil))) issues.push('session workload evidence must be current at planning time')
  if (issues.length || !candidate) throw new ExecutionBudgetContractError(issues)
  const priced = calculateExactUsageCost(usageP95, candidate, policy.settlementCurrency)
  if (!(priced instanceof ExactRational)) throw new ExecutionBudgetContractError([`session workload cannot establish authority: ${priced.code}/${priced.detail}`])
  const workloadFingerprint = stableFingerprint({
    candidateId: sessionValue.candidateId,
    usageP95,
    observedAt: sessionValue.observedAt,
    validUntil: sessionValue.validUntil,
    evidenceRef: sessionValue.evidenceRef
  })
  const catalogueFingerprint = fingerprintExecutionCandidateCatalogue(catalogue)
  const policyFingerprint = stableFingerprint(policy)
  const observedAt = [catalogue.generatedAt, candidate.availability.checkedAt, candidate.pricing.observedAt, sessionValue.observedAt as string].sort().at(-1)!
  const validUntil = [candidate.availability.validUntil, candidate.pricing.validUntil, sessionValue.validUntil as string].sort()[0]
  return finalize({
    schemaVersion: 1 as const,
    sessionId: sessionValue.sessionId as string,
    candidateId: candidate.id,
    effort: candidate.effort.normalized,
    workloadFingerprint,
    catalogueFingerprint,
    policyFingerprint,
    authorityRevision: sessionValue.authorityRevision as string,
    planningAt: policy.planningAt,
    observedAt,
    validUntil,
    currency: policy.settlementCurrency,
    displayScale: policy.displayScale,
    baselineP95: exactCostEvidence(priced, policy.settlementCurrency, policy.displayScale)
  })
}

export function assertSessionBudgetEnvelope(value: unknown): asserts value is SessionBudgetEnvelope {
  const issues: string[] = []
  if (!object(value)) throw new ExecutionBudgetContractError(['session envelope must be an object'])
  rejectUnknown(value, ENVELOPE_FIELDS, 'session envelope', issues)
  if (value.schemaVersion !== 1) issues.push('session envelope schemaVersion must equal 1')
  for (const field of ['sessionId', 'candidateId', 'authorityRevision'] as const) if (!safeId(value[field])) issues.push(`session envelope ${field} must be a safe public identifier`)
  if (!EFFORTS.includes(value.effort as NormalizedEffort)) issues.push('session envelope effort is unsupported')
  for (const field of ['workloadFingerprint', 'catalogueFingerprint', 'policyFingerprint'] as const)
    if (typeof value[field] !== 'string' || !FINGERPRINT.test(value[field])) issues.push(`session envelope ${field} must be a SHA-256 fingerprint`)
  if (!timestamp(value.planningAt) || !timestamp(value.observedAt) || !timestamp(value.validUntil)) issues.push('session envelope timestamps must be canonical UTC timestamps')
  if (timestamp(value.observedAt) && timestamp(value.planningAt) && value.observedAt > value.planningAt) issues.push('session envelope observedAt must not be later than planningAt')
  if (timestamp(value.planningAt) && timestamp(value.validUntil) && value.planningAt >= value.validUntil) issues.push('session envelope validUntil must be later than planningAt')
  if (!/^[A-Z]{3}$/.test(String(value.currency))) issues.push('session envelope currency must be an ISO 4217 code')
  if (!Number.isSafeInteger(value.displayScale) || Number(value.displayScale) < 0 || Number(value.displayScale) > 12) issues.push('session envelope displayScale must be a safe integer from 0 to 12')
  try {
    assertExactCostEvidence(value.baselineP95, 'session envelope baselineP95')
    if (object(value.baselineP95) && value.baselineP95.currency !== value.currency) issues.push('session envelope baseline currency must match the envelope')
    if (object(value.baselineP95) && value.baselineP95.scale !== value.displayScale) issues.push('session envelope baseline scale must match displayScale')
  } catch (error) {
    issues.push(error instanceof Error ? error.message : 'session envelope baselineP95 is invalid')
  }
  if (typeof value.id !== 'string' || !FINGERPRINT.test(value.id)) issues.push('session envelope id must be a SHA-256 fingerprint')
  else {
    const payload = { ...value }
    delete payload.id
    if (value.id !== stableFingerprint(payload)) issues.push('session envelope id does not match its canonical payload')
  }
  if (issues.length) throw new ExecutionBudgetContractError(issues)
}

function validateJustification(value: unknown): ExecutionBudgetJustification {
  const issues: string[] = []
  if (!object(value)) throw new ExecutionBudgetContractError(['approval justification is required above the session authority'])
  rejectUnknown(value, JUSTIFICATION_FIELDS, 'approval justification', issues)
  if (!REASONS.includes(value.reasonCode as ExecutionBudgetApprovalReasonCode)) issues.push('approval justification reasonCode is unsupported')
  if (!Array.isArray(value.expectedBenefitCodes) || value.expectedBenefitCodes.length === 0 || value.expectedBenefitCodes.some((entry) => !BENEFITS.includes(entry as ExecutionBudgetBenefitCode)))
    issues.push('approval justification expectedBenefitCodes must be a non-empty supported list')
  else if (new Set(value.expectedBenefitCodes).size !== value.expectedBenefitCodes.length) issues.push('approval justification expectedBenefitCodes must not contain duplicates')
  if (!Array.isArray(value.evidenceRefs) || value.evidenceRefs.length === 0 || value.evidenceRefs.some((entry) => !safeId(entry)))
    issues.push('approval justification evidenceRefs must be non-empty safe public identifiers')
  else if (new Set(value.evidenceRefs).size !== value.evidenceRefs.length) issues.push('approval justification evidenceRefs must not contain duplicates')
  if (issues.length) throw new ExecutionBudgetContractError(issues)
  return {
    reasonCode: value.reasonCode as ExecutionBudgetApprovalReasonCode,
    expectedBenefitCodes: [...(value.expectedBenefitCodes as ExecutionBudgetBenefitCode[])].sort(),
    evidenceRefs: [...(value.evidenceRefs as string[])].sort()
  }
}

function positiveIncrement(cost: ExactCostEvidence, baseline: ExactCostEvidence, scale: number): ExactCostEvidence {
  const difference = ExactRational.evidence(cost).subtract(ExactRational.evidence(baseline))
  return exactCostEvidence(difference.maximum(new ExactRational(0n)), cost.currency, scale)
}

function challenge(decision: ExecutionPlanDecision, envelope: SessionBudgetEnvelope, justification: ExecutionBudgetJustification): ExecutionBudgetApprovalChallenge {
  const selected = decision.selected!
  const validUntil = [selected.validUntil, envelope.validUntil].sort()[0]
  return finalize({
    schemaVersion: 1 as const,
    sessionId: envelope.sessionId,
    authorityRevision: envelope.authorityRevision,
    planDecisionId: decision.id,
    proposalFingerprint: selected.proposalFingerprint,
    requirementsId: decision.requirementsId,
    catalogueFingerprint: decision.catalogueFingerprint,
    policyFingerprint: decision.policyFingerprint,
    workloadFingerprint: envelope.workloadFingerprint,
    currency: envelope.currency,
    quotedAt: envelope.planningAt,
    validUntil,
    baselineP95: envelope.baselineP95,
    expectedAggregateP95: selected.expectedAggregateP95,
    maximumPathP95: selected.maximumPathP95,
    expectedIncrement: positiveIncrement(selected.expectedAggregateP95, envelope.baselineP95, envelope.displayScale),
    pathIncrement: positiveIncrement(selected.maximumPathP95, envelope.baselineP95, envelope.displayScale),
    justification,
    nonMonetaryApprovalRequired: selected.approvalRequired
  })
}

function validateGrant(value: unknown, expected: ExecutionBudgetApprovalChallenge, evaluatedAt: string): value is ExecutionBudgetApprovalGrant {
  if (!object(value)) return false
  const issues: string[] = []
  rejectUnknown(value, GRANT_FIELDS, 'approval grant', issues)
  if (value.schemaVersion !== 1 || !safeId(value.id) || !safeId(value.approvedByRef)) return false
  if (value.challengeId !== expected.id || value.sessionId !== expected.sessionId || value.planDecisionId !== expected.planDecisionId) return false
  if (
    !timestamp(value.approvedAt) ||
    !timestamp(value.validUntil) ||
    value.approvedAt < expected.quotedAt ||
    value.approvedAt > evaluatedAt ||
    evaluatedAt >= value.validUntil ||
    value.validUntil > expected.validUntil
  )
    return false
  try {
    assertExactCostEvidence(value.expectedIncrement, 'approval grant expectedIncrement')
    assertExactCostEvidence(value.pathIncrement, 'approval grant pathIncrement')
    if (compareExactCosts(value.expectedIncrement, expected.expectedIncrement) !== 0 || compareExactCosts(value.pathIncrement, expected.pathIncrement) !== 0) return false
  } catch {
    return false
  }
  return issues.length === 0
}

function decision(value: Omit<ExecutionBudgetDecision, 'id'>): ExecutionBudgetDecision {
  return finalize(value)
}

/** Applies the session-derived monetary gate without weakening other approvals. */
export function authorizeExecutionPlan(
  planValue: unknown,
  sessionValue: unknown,
  catalogue: ExecutionCandidateCatalogueSnapshot,
  policy: ExecutionPlanSelectionPolicy,
  input: ExecutionBudgetAuthorizationInput
): ExecutionBudgetDecision {
  assertExecutionPlanDecision(planValue)
  const plan = planValue
  const envelope = deriveSessionBudgetEnvelope(sessionValue, catalogue, policy)
  if (!object(input)) throw new ExecutionBudgetContractError(['authorization input must be an object'])
  const inputIssues: string[] = []
  rejectUnknown(input, AUTHORIZATION_FIELDS, 'authorization input', inputIssues)
  if (inputIssues.length) throw new ExecutionBudgetContractError(inputIssues)
  if (!timestamp(input.evaluatedAt)) throw new ExecutionBudgetContractError(['evaluatedAt must be a canonical UTC timestamp'])
  const common = {
    schemaVersion: 1 as const,
    evaluatedAt: input.evaluatedAt,
    planDecisionId: plan.id,
    sessionEnvelopeId: envelope.id,
    sessionId: envelope.sessionId,
    sessionCandidateId: envelope.candidateId,
    sessionEffort: envelope.effort,
    workloadFingerprint: envelope.workloadFingerprint,
    authorityRevision: envelope.authorityRevision,
    currency: envelope.currency,
    baselineP95: envelope.baselineP95,
    nonMonetaryApprovalRequired: plan.selected?.approvalRequired ?? false
  }
  if (plan.status !== 'selected' || !plan.selected)
    return decision({
      ...common,
      status: 'rejected',
      mode: null,
      reasonCode: plan.status === 'requirements-unsatisfiable' ? 'requirements-unsatisfiable' : 'no-qualified-plan'
    })
  const selected = plan.selected
  if (plan.catalogueFingerprint !== envelope.catalogueFingerprint || plan.policyFingerprint !== envelope.policyFingerprint || plan.planningAt !== envelope.planningAt)
    throw new ExecutionBudgetContractError(['session envelope and selected plan must share the same planning evidence'])
  if (selected.expectedAggregateP95.currency !== envelope.currency || selected.maximumPathP95.currency !== envelope.currency)
    throw new ExecutionBudgetContractError(['session envelope and selected plan must share one settlement currency'])
  const validUntil = [selected.validUntil, envelope.validUntil].sort()[0]
  if (input.evaluatedAt < envelope.planningAt || input.evaluatedAt >= validUntil) throw new ExecutionBudgetContractError(['execution budget evidence is stale at evaluatedAt'])
  const withinExpected = compareExactCosts(selected.expectedAggregateP95, envelope.baselineP95) <= 0
  const withinPath = compareExactCosts(selected.maximumPathP95, envelope.baselineP95) <= 0
  const selectedCommon = {
    ...common,
    proposalFingerprint: selected.proposalFingerprint,
    expectedAggregateP95: selected.expectedAggregateP95,
    maximumPathP95: selected.maximumPathP95,
    nonMonetaryApprovalRequired: selected.approvalRequired
  }
  if (withinExpected && withinPath) {
    if (input.approval !== undefined) throw new ExecutionBudgetContractError(['approval must not be attached when the plan is within session authority'])
    return decision({ ...selectedCommon, status: 'authorized', mode: 'automatic', reasonCode: 'within-session-authority' })
  }
  const approvalChallenge = challenge(plan, envelope, validateJustification(input.justification))
  if (input.approval === undefined) return decision({ ...selectedCommon, status: 'approval-required', mode: null, reasonCode: 'plan-exceeds-session-authority', challenge: approvalChallenge })
  if (!validateGrant(input.approval, approvalChallenge, input.evaluatedAt))
    return decision({ ...selectedCommon, status: 'rejected', mode: null, reasonCode: 'approval-scope-mismatch', challenge: approvalChallenge })
  return decision({
    ...selectedCommon,
    status: 'authorized',
    mode: 'approved-increment',
    reasonCode: 'approval-granted',
    challenge: approvalChallenge,
    approvalEventId: input.approval.id
  })
}
