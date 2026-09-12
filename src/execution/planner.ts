import { qualifyAndCostExecutionPlan } from './cost'
import { compareExactCosts } from './exact-cost'
import { stableFingerprint } from './overrides'
import type { ExecutionPlanDecision, ExecutionPlanExclusion, ExecutionPlanSelectionPolicy, ExecutionPlanTieBreakDecision, ExecutionPlanTieBreaker, QualifiedExecutionPlan } from './plans'
import type { ExecutionRequirementSet } from './requirements'
import type { ExecutionCandidateCatalogueSnapshot, NormalizedEffort } from './types'

const EFFORT_ORDER: NormalizedEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'custom']
const SECRET_LIKE = /(?:\bBearer\s+|\b(?:sk|gh[pousr]|github_pat|xox[baprs])[_-]|\beyJ[a-zA-Z0-9_-]{8,}\.)/i
const MAX_EXECUTION_PLAN_PROPOSALS = 256

function safeProposalId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._:/-]{0,127}$/i.test(value) && !SECRET_LIKE.test(value)
}

function safeTimestamp(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return fallback
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value ? value : fallback
}

function compareNullableNumber(left: number | null, right: number | null): number {
  if (left === right) return 0
  if (left === null) return 1
  if (right === null) return -1
  return left - right
}

function compareRule(left: QualifiedExecutionPlan, right: QualifiedExecutionPlan, rule: ExecutionPlanTieBreaker): number {
  switch (rule) {
    case 'lower-max-path-cost':
      return compareExactCosts(left.maximumPathP95, right.maximumPathP95)
    case 'lower-p95-latency':
      return compareNullableNumber(left.maximumPathLatencyP95Ms, right.maximumPathLatencyP95Ms)
    case 'fewer-nodes':
      return left.nodeCount - right.nodeCount
    case 'prefer-local':
      return Number(right.rootRuntimeKind === 'local') - Number(left.rootRuntimeKind === 'local')
    case 'higher-effort':
      return EFFORT_ORDER.indexOf(right.rootEffort) - EFFORT_ORDER.indexOf(left.rootEffort)
  }
}

function decidingRule(left: QualifiedExecutionPlan, right: QualifiedExecutionPlan, policy: ExecutionPlanSelectionPolicy): ExecutionPlanTieBreakDecision['rule'] {
  if (compareExactCosts(left.expectedAggregateP95, right.expectedAggregateP95) !== 0) return 'expected-aggregate-p95'
  for (const rule of policy.tieBreakers) if (compareRule(left, right, rule) !== 0) return rule
  return 'canonical-proposal-id'
}

function comparePlan(left: QualifiedExecutionPlan, right: QualifiedExecutionPlan, policy: ExecutionPlanSelectionPolicy): number {
  const cost = compareExactCosts(left.expectedAggregateP95, right.expectedAggregateP95)
  if (cost !== 0) return cost
  for (const rule of policy.tieBreakers) {
    const result = compareRule(left, right, rule)
    if (result !== 0) return result
  }
  return left.proposalId.localeCompare(right.proposalId) || left.proposalFingerprint.localeCompare(right.proposalFingerprint)
}

export function canonicalExecutionCandidateCatalogue(catalogue: ExecutionCandidateCatalogueSnapshot): ExecutionCandidateCatalogueSnapshot {
  return {
    ...catalogue,
    eligible: catalogue.eligible
      .map((candidate) => ({
        ...candidate,
        capabilities: [...candidate.capabilities].sort(),
        pricing: {
          ...candidate.pricing,
          dimensions: [...candidate.pricing.dimensions].sort((left, right) => `${left.kind}/${left.currency}/${left.unit}`.localeCompare(`${right.kind}/${right.currency}/${right.unit}`))
        },
        privacy: { ...candidate.privacy, ...(candidate.privacy.dataResidency ? { dataResidency: [...candidate.privacy.dataResidency].sort() } : {}) },
        tools: { ...candidate.tools, supported: [...candidate.tools.supported].sort() }
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    excluded: [...catalogue.excluded].sort((left, right) => {
      const leftId = `${left.identity.adapterId}/${left.identity.sourceId}/${left.identity.candidateId ?? ''}`
      const rightId = `${right.identity.adapterId}/${right.identity.sourceId}/${right.identity.candidateId ?? ''}`
      return leftId.localeCompare(rightId)
    })
  }
}

export function fingerprintExecutionCandidateCatalogue(catalogue: ExecutionCandidateCatalogueSnapshot): string {
  return stableFingerprint(canonicalExecutionCandidateCatalogue(catalogue))
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const entry of Object.values(value as Record<string, unknown>)) freeze(entry)
    Object.freeze(value)
  }
  return value
}

function finalize(value: Omit<ExecutionPlanDecision, 'id'>): ExecutionPlanDecision {
  return freeze({ ...value, id: stableFingerprint(value) })
}

/** Selects the cheapest qualified complete tree and returns an immutable safe ledger. */
export function selectMinimumCostExecutionPlan(
  proposals: readonly unknown[],
  requirements: ExecutionRequirementSet,
  catalogue: ExecutionCandidateCatalogueSnapshot,
  policy: ExecutionPlanSelectionPolicy
): ExecutionPlanDecision {
  if (!Array.isArray(proposals) || proposals.length > MAX_EXECUTION_PLAN_PROPOSALS) throw new Error(`Execution planning accepts at most ${MAX_EXECUTION_PLAN_PROPOSALS} proposals.`)
  const qualified: QualifiedExecutionPlan[] = []
  const exclusions: ExecutionPlanExclusion[] = []
  const proposalIds = proposals.map((proposal) => (proposal !== null && typeof proposal === 'object' ? (proposal as { id?: unknown }).id : undefined))
  const duplicateIds = new Set(proposalIds.filter((id): id is string => safeProposalId(id) && proposalIds.filter((candidate) => candidate === id).length > 1))
  const reportedDuplicateIds = new Set<string>()
  for (const proposal of proposals) {
    const proposalId = proposal !== null && typeof proposal === 'object' ? (proposal as { id?: unknown }).id : undefined
    if (safeProposalId(proposalId) && duplicateIds.has(proposalId)) {
      if (!reportedDuplicateIds.has(proposalId)) exclusions.push({ proposalId, code: 'invalid-proposal', detailCode: 'duplicate-proposal-id' })
      reportedDuplicateIds.add(proposalId)
      continue
    }
    const result = qualifyAndCostExecutionPlan(proposal, requirements, catalogue, policy)
    if (result.status === 'qualified') qualified.push(result.plan)
    else exclusions.push(...result.exclusions)
  }
  qualified.sort((left, right) => comparePlan(left, right, policy))
  exclusions.sort((left, right) =>
    `${left.proposalId}/${left.nodeId ?? ''}/${left.code}/${left.detailCode ?? ''}`.localeCompare(`${right.proposalId}/${right.nodeId ?? ''}/${right.code}/${right.detailCode ?? ''}`)
  )
  const selected = qualified[0]
  const tieBreakDecisions: ExecutionPlanTieBreakDecision[] = selected
    ? qualified.slice(1).map((loser) => ({ winnerProposalId: selected.proposalId, loserProposalId: loser.proposalId, rule: decidingRule(selected, loser, policy) }))
    : []
  const catalogueFingerprint = fingerprintExecutionCandidateCatalogue(catalogue)
  return finalize({
    schemaVersion: 1,
    status: requirements.resolution.status === 'unsatisfiable' ? 'requirements-unsatisfiable' : selected ? 'selected' : 'unplannable',
    requirementsId: /^[a-f0-9]{64}$/.test(requirements.id) ? requirements.id : 'invalid-requirements',
    catalogueGeneratedAt: safeTimestamp(catalogue.generatedAt, 'invalid-catalogue-time'),
    catalogueFingerprint,
    planningAt: safeTimestamp(policy.planningAt, 'invalid-planning-time'),
    policyFingerprint: stableFingerprint(policy),
    ...(selected ? { selected } : {}),
    qualified,
    exclusions,
    tieBreakDecisions
  })
}
