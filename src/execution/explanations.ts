import type { ExecutionBudgetDecision, ExecutionRecoveryBudgetDecision } from './budget'
import { assertExecutionOutcomeEvidence, type ExecutionOutcomeEvidence } from './calibration'
import { stableFingerprint } from './overrides'
import { assertExecutionPlanDecision, type BillableUsageP95, type ExactCostEvidence, type ExecutionPlanDecision, type ExecutionPlanExclusionCode, type ExecutionPlanTieBreakDecision } from './plans'
import { assertExecutionLineage, type ExecutionLineage, type ExecutionLineageTerminalState, type ExecutionObservedOutcome, type ExecutionReplanTrigger } from './replanning'

const FINGERPRINT = /^[a-f0-9]{64}$/
const EXPLANATION_FIELDS = [
  'schemaVersion',
  'id',
  'planDecisionId',
  'status',
  'requirementsId',
  'catalogueFingerprint',
  'policyFingerprint',
  'selected',
  'alternatives',
  'tieBreaks',
  'authority',
  'lineage',
  'outcomes',
  'evidenceRefs'
] as const

export type ExecutionExplanationStatus = ExecutionPlanDecision['status']

export interface ExecutionSelectedExplanation {
  proposalId: string
  candidateId: string
  expectedAggregateP95: ExactCostEvidence
  maximumPathP95: ExactCostEvidence
  reasonCode: 'sole-qualified-plan' | 'minimum-expected-cost'
}

export interface ExecutionAlternativeExplanation {
  proposalId: string
  status: 'qualified' | 'excluded'
  candidateIds: string[]
  nodeIds: string[]
  reasonCodes: Array<ExecutionPlanExclusionCode | `tie-break:${ExecutionPlanTieBreakDecision['rule']}`>
  expectedAggregateP95?: ExactCostEvidence
  maximumPathP95?: ExactCostEvidence
}

export interface ExecutionAuthorityExplanation {
  decisionId: string
  status: ExecutionBudgetDecision['status']
  mode: ExecutionBudgetDecision['mode']
  reasonCode: ExecutionBudgetDecision['reasonCode']
  dispatchAuthorized: boolean
  nonMonetaryApprovalRequired: boolean
  baselineP95: ExactCostEvidence
  expectedAggregateP95?: ExactCostEvidence
  maximumPathP95?: ExactCostEvidence
  expectedIncrement?: ExactCostEvidence
  pathIncrement?: ExactCostEvidence
  runId?: string
  lineageRevision?: number
  historyHead?: string
  spentP95?: ExactCostEvidence
  remainingAutomaticAuthorityP95?: ExactCostEvidence
  recoveryExpectedTotalP95?: ExactCostEvidence
  recoveryMaximumTotalP95?: ExactCostEvidence
}

export interface ExecutionLineageExplanation {
  lineageId: string
  runId: string
  revision: number
  historyHead: string
  terminalState: ExecutionLineageTerminalState
  attemptCount: number
  currentAttemptId: string
  lastTrigger: 'initial' | ExecutionReplanTrigger
  lastOutcome?: ExecutionObservedOutcome
  invalidatedPermitIds: string[]
}

export interface ExecutionOutcomeExplanation {
  outcomeId: string
  eventId: string
  runId: string
  attemptId: string
  nodeId: string
  candidateId: string
  occurredAt: string
  receivedAt: string
  outcome: ExecutionOutcomeEvidence['outcome']
  actualUsage: BillableUsageP95
  metering: ExecutionOutcomeEvidence['metering']
  latencyMs: number | null
  validation: ExecutionOutcomeEvidence['validation']
  retryOrdinal: number
  fallbackReason?: ExecutionOutcomeEvidence['fallbackReason']
  sourceKind: ExecutionOutcomeEvidence['sourceKind']
  evidenceRefs: string[]
}

export interface ExecutionDecisionExplanation {
  schemaVersion: 1
  id: string
  planDecisionId: string
  status: ExecutionExplanationStatus
  requirementsId: string
  catalogueFingerprint: string
  policyFingerprint: string
  selected?: ExecutionSelectedExplanation
  alternatives: ExecutionAlternativeExplanation[]
  tieBreaks: ExecutionPlanTieBreakDecision[]
  authority?: ExecutionAuthorityExplanation
  lineage?: ExecutionLineageExplanation
  outcomes: ExecutionOutcomeExplanation[]
  evidenceRefs: string[]
}

export interface ExecutionExplanationInput {
  budgetDecision?: ExecutionBudgetDecision | ExecutionRecoveryBudgetDecision
  lineage?: ExecutionLineage
  outcomes?: readonly ExecutionOutcomeEvidence[]
}

export class ExecutionExplanationContractError extends Error {
  readonly issues: string[]

  constructor(issues: string[]) {
    super(`Invalid execution explanation contract: ${issues.join('; ')}`)
    this.name = 'ExecutionExplanationContractError'
    this.issues = [...issues]
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const entry of Object.values(value as Record<string, unknown>)) freeze(entry)
    Object.freeze(value)
  }
  return value
}

function withoutId<T extends { id: string }>(value: T): Omit<T, 'id'> {
  const rest: Partial<T> = { ...value }
  delete rest.id
  return rest as Omit<T, 'id'>
}

function cloneCost(value: ExactCostEvidence): ExactCostEvidence {
  return { ...value }
}

function authorityExplanation(value: ExecutionBudgetDecision | ExecutionRecoveryBudgetDecision, planDecisionId: string): ExecutionAuthorityExplanation {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1 || !FINGERPRINT.test(value.id) || stableFingerprint(withoutId(value)) !== value.id)
    throw new ExecutionExplanationContractError(['budget decision must be an immutable fingerprinted decision'])
  if (value.planDecisionId !== planDecisionId) throw new ExecutionExplanationContractError(['budget decision must reference the explained plan'])
  const challenge = value.challenge
  const recovery = 'runId' in value ? value : undefined
  return {
    decisionId: value.id,
    status: value.status,
    mode: value.mode,
    reasonCode: value.reasonCode,
    dispatchAuthorized: value.dispatchAuthorized,
    nonMonetaryApprovalRequired: value.nonMonetaryApprovalRequired,
    baselineP95: cloneCost(value.baselineP95),
    ...(value.expectedAggregateP95 ? { expectedAggregateP95: cloneCost(value.expectedAggregateP95) } : {}),
    ...(value.maximumPathP95 ? { maximumPathP95: cloneCost(value.maximumPathP95) } : {}),
    ...(challenge ? { expectedIncrement: cloneCost(challenge.expectedIncrement), pathIncrement: cloneCost(challenge.pathIncrement) } : {}),
    ...(recovery
      ? {
          runId: recovery.runId,
          lineageRevision: recovery.lineageRevision,
          historyHead: recovery.historyHead,
          spentP95: cloneCost(recovery.spentP95),
          remainingAutomaticAuthorityP95: cloneCost(recovery.remainingAutomaticAuthorityP95),
          ...(recovery.recoveryExpectedTotalP95 ? { recoveryExpectedTotalP95: cloneCost(recovery.recoveryExpectedTotalP95) } : {}),
          ...(recovery.recoveryMaximumTotalP95 ? { recoveryMaximumTotalP95: cloneCost(recovery.recoveryMaximumTotalP95) } : {})
        }
      : {})
  }
}

function alternatives(plan: ExecutionPlanDecision): ExecutionAlternativeExplanation[] {
  const selectedId = plan.selected?.proposalId
  const entries = new Map<string, ExecutionAlternativeExplanation>()
  for (const qualified of plan.qualified) {
    if (qualified.proposalId === selectedId) continue
    const tieBreak = plan.tieBreakDecisions.find((entry) => entry.loserProposalId === qualified.proposalId)
    entries.set(qualified.proposalId, {
      proposalId: qualified.proposalId,
      status: 'qualified',
      candidateIds: [...new Set(qualified.nodeCosts.map((cost) => cost.candidateId))].sort(),
      nodeIds: qualified.nodeCosts.map((cost) => cost.nodeId).sort(),
      reasonCodes: tieBreak ? [`tie-break:${tieBreak.rule}`] : [],
      expectedAggregateP95: cloneCost(qualified.expectedAggregateP95),
      maximumPathP95: cloneCost(qualified.maximumPathP95)
    })
  }
  for (const exclusion of plan.exclusions) {
    const current = entries.get(exclusion.proposalId) ?? {
      proposalId: exclusion.proposalId,
      status: 'excluded' as const,
      candidateIds: [],
      nodeIds: [],
      reasonCodes: []
    }
    if (exclusion.candidateId) current.candidateIds.push(exclusion.candidateId)
    if (exclusion.nodeId) current.nodeIds.push(exclusion.nodeId)
    current.reasonCodes.push(exclusion.code)
    current.candidateIds = [...new Set(current.candidateIds)].sort()
    current.nodeIds = [...new Set(current.nodeIds)].sort()
    current.reasonCodes = [...new Set(current.reasonCodes)].sort()
    entries.set(exclusion.proposalId, current)
  }
  return [...entries.values()].sort((left, right) => left.proposalId.localeCompare(right.proposalId))
}

/** Projects immutable planner and authority records into one deterministic, safe explanation. */
export function explainExecutionDecision(planValue: unknown, input: ExecutionExplanationInput = {}): ExecutionDecisionExplanation {
  assertExecutionPlanDecision(planValue)
  const plan = planValue
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new ExecutionExplanationContractError(['explanation input must be an object'])
  const unknown = Object.keys(input).filter((field) => !['budgetDecision', 'lineage', 'outcomes'].includes(field))
  if (unknown.length) throw new ExecutionExplanationContractError([`explanation input contains unsupported fields: ${unknown.sort().join(', ')}`])
  const lineage = input.lineage
  if (lineage) {
    assertExecutionLineage(lineage)
    if (lineage.currentPlanDecisionId !== plan.id) throw new ExecutionExplanationContractError(['lineage current plan must match the explained plan'])
  }
  const lastAttempt = lineage?.attempts[lineage.attempts.length - 1]
  const evidenceRefs = new Set(plan.selected?.evidenceRefs ?? [])
  for (const attempt of lineage?.attempts ?? []) for (const reference of attempt.evidenceRefs) evidenceRefs.add(reference)
  for (const reference of input.budgetDecision?.challenge?.justification.evidenceRefs ?? []) evidenceRefs.add(reference)
  const outcomes = [...(input.outcomes ?? [])]
    .map((outcome) => {
      assertExecutionOutcomeEvidence(outcome)
      if (outcome.binding.planDecisionId !== plan.id) throw new ExecutionExplanationContractError(['outcome evidence must reference the explained plan'])
      for (const reference of outcome.evidenceRefs) evidenceRefs.add(reference)
      return {
        outcomeId: outcome.id,
        eventId: outcome.eventId,
        runId: outcome.binding.runId,
        attemptId: outcome.binding.attemptId,
        nodeId: outcome.binding.nodeId,
        candidateId: outcome.binding.candidateId,
        occurredAt: outcome.occurredAt,
        receivedAt: outcome.receivedAt,
        outcome: outcome.outcome,
        actualUsage: { ...outcome.actualUsage },
        metering: outcome.metering,
        latencyMs: outcome.latencyMs,
        validation: { result: outcome.validation.result, checks: [...outcome.validation.checks].sort() },
        retryOrdinal: outcome.binding.retryOrdinal,
        ...(outcome.fallbackReason ? { fallbackReason: outcome.fallbackReason } : {}),
        sourceKind: outcome.sourceKind,
        evidenceRefs: [...outcome.evidenceRefs].sort()
      }
    })
    .sort((left, right) => `${left.receivedAt}/${left.outcomeId}`.localeCompare(`${right.receivedAt}/${right.outcomeId}`))
  const payload: Omit<ExecutionDecisionExplanation, 'id'> = {
    schemaVersion: 1,
    planDecisionId: plan.id,
    status: plan.status,
    requirementsId: plan.requirementsId,
    catalogueFingerprint: plan.catalogueFingerprint,
    policyFingerprint: plan.policyFingerprint,
    ...(plan.selected
      ? {
          selected: {
            proposalId: plan.selected.proposalId,
            candidateId: plan.selected.rootCandidateId,
            expectedAggregateP95: cloneCost(plan.selected.expectedAggregateP95),
            maximumPathP95: cloneCost(plan.selected.maximumPathP95),
            reasonCode: plan.qualified.length === 1 ? ('sole-qualified-plan' as const) : ('minimum-expected-cost' as const)
          }
        }
      : {}),
    alternatives: alternatives(plan),
    tieBreaks: plan.tieBreakDecisions
      .map((entry) => ({ ...entry }))
      .sort((left, right) => `${left.loserProposalId}/${left.winnerProposalId}/${left.rule}`.localeCompare(`${right.loserProposalId}/${right.winnerProposalId}/${right.rule}`)),
    ...(input.budgetDecision ? { authority: authorityExplanation(input.budgetDecision, plan.id) } : {}),
    ...(lineage && lastAttempt
      ? {
          lineage: {
            lineageId: lineage.id,
            runId: lineage.runId,
            revision: lineage.revision,
            historyHead: lineage.historyHead,
            terminalState: lineage.terminalState,
            attemptCount: lineage.attempts.length,
            currentAttemptId: lineage.currentAttemptId,
            lastTrigger: lastAttempt.trigger,
            ...(lastAttempt.outcomeCode ? { lastOutcome: lastAttempt.outcomeCode } : {}),
            invalidatedPermitIds: [...lastAttempt.invalidatedPermitIds].sort()
          }
        }
      : {}),
    outcomes,
    evidenceRefs: [...evidenceRefs].sort()
  }
  return freeze({ ...payload, id: stableFingerprint(payload) })
}

export function assertExecutionDecisionExplanation(value: unknown): asserts value is ExecutionDecisionExplanation {
  if (!object(value)) throw new ExecutionExplanationContractError(['explanation must be an object'])
  const unknown = Object.keys(value).filter((field) => !EXPLANATION_FIELDS.includes(field as (typeof EXPLANATION_FIELDS)[number]))
  const issues: string[] = []
  if (unknown.length) issues.push(`explanation contains unsupported fields: ${unknown.sort().join(', ')}`)
  if (value.schemaVersion !== 1) issues.push('explanation.schemaVersion must equal 1')
  if (typeof value.id !== 'string' || !FINGERPRINT.test(value.id)) issues.push('explanation.id must be a SHA-256 fingerprint')
  if (typeof value.planDecisionId !== 'string' || !FINGERPRINT.test(value.planDecisionId)) issues.push('explanation.planDecisionId must be a SHA-256 fingerprint')
  if (typeof value.id === 'string' && FINGERPRINT.test(value.id)) {
    if (stableFingerprint(withoutId(value as unknown as ExecutionDecisionExplanation)) !== value.id) issues.push('explanation.id does not match its canonical payload')
  }
  if (issues.length) throw new ExecutionExplanationContractError(issues)
}
