import { authorizeExecutionPlan, deriveSessionBudgetEnvelope, type ExecutionBudgetApprovalGrant, type ExecutionBudgetJustification, type SessionWorkloadEvidence } from '../../../execution/budget'
import {
  classifyTaskIntent,
  createExecutionCandidateId,
  selectMinimumCostExecutionPlan,
  stableFingerprint,
  type ExecutionCandidate,
  type ExecutionCandidateCatalogueSnapshot,
  type ExecutionBudgetHostAuthority,
  type ExecutionPlanNode,
  type ExecutionPlanProposal,
  type ExecutionPlanSelectionPolicy
} from '../../../execution'

const OBSERVED_AT = '2026-09-12T10:00:00.000Z'
const PLANNING_AT = '2026-09-12T12:00:00.000Z'
const EVALUATED_AT = '2026-09-12T12:01:00.000Z'
const APPROVED_EVALUATED_AT = '2026-09-12T12:02:00.000Z'
const VALID_UNTIL = '2026-09-13T12:00:00.000Z'

function candidate(model: string, price: string, requiresApproval = false): ExecutionCandidate {
  return {
    id: createExecutionCandidateId('provider', 'hosted', model, model === 'session' ? 'high' : 'medium'),
    provider: { id: 'provider' },
    runtime: { id: 'hosted', kind: 'cloud' },
    model: { id: model },
    effort: { normalized: model === 'session' ? 'high' : 'medium', sourceId: model === 'session' ? 'high' : 'medium' },
    context: { windowTokens: 64_000, maxOutputTokens: 8_000 },
    capabilities: ['code', 'text'],
    availability: { state: 'available', checkedAt: OBSERVED_AT, validUntil: VALID_UNTIL },
    pricing: {
      observedAt: OBSERVED_AT,
      validUntil: VALID_UNTIL,
      dimensions: [{ kind: 'request', amount: price, currency: 'USD', unit: 'request', per: 1, sourceUnit: 'request' }]
    },
    privacy: { boundary: 'provider-managed', trainingUse: 'none', retentionDays: 0 },
    tools: { mode: 'none', supported: [], parallelCalls: false, requiresApproval },
    source: { adapterId: 'fixture', candidateRef: `models/${model}`, retrievedAt: OBSERVED_AT }
  }
}

function node(id: string, role: 'primary' | 'fallback', entry: ExecutionCandidate, outcomes: ExecutionPlanNode['outcomes']): ExecutionPlanNode {
  return {
    id,
    role,
    candidateId: entry.id,
    estimate: {
      usageP95: { request: '1' },
      latencyP95Ms: 1_000,
      observedAt: OBSERVED_AT,
      validUntil: VALID_UNTIL,
      evidenceRef: `benchmarks/${id}`,
      independenceDomain: `provider/${entry.model.id}`
    },
    tools: [],
    checks: role === 'primary' ? ['automated-tests', 'self-review', 'type-check'] : [],
    outcomes
  }
}

function proposal(primary: ExecutionCandidate, fallback?: ExecutionCandidate): ExecutionPlanProposal {
  return {
    schemaVersion: 1,
    id: fallback ? 'plan/with-fallback' : 'plan/single',
    rootNodeId: 'primary',
    nodes: fallback
      ? [
          node('primary', 'primary', primary, [
            { code: 'success', conditionalProbability: '0.9', evidenceRef: 'rates/primary-success' },
            { code: 'execution-failed', conditionalProbability: '0.1', nextNodeId: 'fallback', evidenceRef: 'rates/primary-failure' }
          ]),
          node('fallback', 'fallback', fallback, [{ code: 'success', conditionalProbability: '1', evidenceRef: 'rates/fallback-success' }])
        ]
      : [node('primary', 'primary', primary, [{ code: 'success', conditionalProbability: '1', evidenceRef: 'rates/primary-success' }])]
  }
}

function catalogue(entries: ExecutionCandidate[]): ExecutionCandidateCatalogueSnapshot {
  return { version: 1, generatedAt: OBSERVED_AT, eligible: entries, excluded: [] }
}

const requirements = classifyTaskIntent({ text: 'Document a public value', categories: ['mechanical'], signals: { operation: 'document' } })
const policy: ExecutionPlanSelectionPolicy = {
  schemaVersion: 1,
  planningAt: PLANNING_AT,
  settlementCurrency: 'USD',
  displayScale: 2,
  tieBreakers: ['lower-max-path-cost', 'fewer-nodes']
}
const justification: ExecutionBudgetJustification = {
  reasonCode: 'fallback-resilience',
  expectedBenefitCodes: ['fallback-resilience'],
  evidenceRefs: ['benchmarks/recovery-benefit']
}

function host(proposals: readonly unknown[], consumed = new Set<string>()): ExecutionBudgetHostAuthority {
  return {
    requirements,
    proposals,
    verifySessionEvidence: () => true,
    consumeApprovalGrant: (grant) => {
      if (consumed.has(grant.id)) return false
      consumed.add(grant.id)
      return true
    }
  }
}

function session(entry: ExecutionCandidate): SessionWorkloadEvidence {
  return {
    schemaVersion: 1,
    sessionId: 'session/current',
    candidateId: entry.id,
    usageP95: { request: '1' },
    observedAt: OBSERVED_AT,
    validUntil: VALID_UNTIL,
    evidenceRef: 'session/workload/current',
    authorityRevision: 'session/revision-1'
  }
}

describe('session-derived execution budget authority (#728)', () => {
  it('derives the exact envelope from the current session candidate, effort, workload, and price snapshot', () => {
    const current = candidate('session', '10')
    const snapshot = catalogue([current])

    const envelope = deriveSessionBudgetEnvelope(session(current), snapshot, policy)

    expect(envelope).toMatchObject({
      sessionId: 'session/current',
      candidateId: current.id,
      effort: 'high',
      currency: 'USD',
      baselineP95: { numerator: '10', denominator: '1', amount: '10.00' },
      catalogueFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      workloadFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/)
    })
    expect(Object.isFrozen(envelope)).toBe(true)
    expect(Object.isFrozen(envelope.baselineP95)).toBe(true)
  })

  it('automatically authorizes any qualified plan whose aggregate and maximum path both fit', () => {
    const current = candidate('session', '10')
    const delegated = candidate('delegated-higher-effort-value', '5')
    const snapshot = catalogue([current, delegated])
    const proposals = [proposal(delegated)]
    const plan = selectMinimumCostExecutionPlan(proposals, requirements, snapshot, policy)
    const result = authorizeExecutionPlan(plan, session(current), snapshot, policy, { evaluatedAt: EVALUATED_AT }, host(proposals))

    expect(result).toMatchObject({ status: 'authorized', mode: 'automatic', reasonCode: 'within-session-authority', expectedAggregateP95: { amount: '5.00' }, maximumPathP95: { amount: '5.00' } })
    expect(Object.isFrozen(result)).toBe(true)
  })

  it('blocks a rare expensive fallback even when expected aggregate cost is below the session baseline', () => {
    const current = candidate('session', '10')
    const primary = candidate('primary', '5')
    const fallback = candidate('fallback', '10')
    const snapshot = catalogue([current, primary, fallback])
    const proposals = [proposal(primary, fallback)]
    const plan = selectMinimumCostExecutionPlan(proposals, requirements, snapshot, policy)
    const result = authorizeExecutionPlan(plan, session(current), snapshot, policy, { evaluatedAt: EVALUATED_AT, justification }, host(proposals))

    expect(result).toMatchObject({
      status: 'approval-required',
      reasonCode: 'plan-exceeds-session-authority',
      expectedAggregateP95: { numerator: '6', denominator: '1', amount: '6.00' },
      maximumPathP95: { numerator: '15', denominator: '1', amount: '15.00' },
      challenge: { expectedIncrement: { amount: '0.00' }, pathIncrement: { amount: '5.00' }, justification }
    })
  })

  it('accepts only the quoted plan-scoped increments from a host-authenticated approval event', () => {
    const current = candidate('session', '10')
    const delegated = candidate('expensive', '12')
    const snapshot = catalogue([current, delegated])
    const proposals = [proposal(delegated)]
    const plan = selectMinimumCostExecutionPlan(proposals, requirements, snapshot, policy)
    const consumed = new Set<string>()
    const authority = host(proposals, consumed)
    const request = authorizeExecutionPlan(plan, session(current), snapshot, policy, { evaluatedAt: EVALUATED_AT, justification }, authority)
    expect(request.status).toBe('approval-required')
    const challenge = request.challenge!
    const grant: ExecutionBudgetApprovalGrant = {
      schemaVersion: 1,
      id: 'approval/event-1',
      challengeId: challenge.id,
      sessionId: challenge.sessionId,
      planDecisionId: challenge.planDecisionId,
      expectedIncrement: challenge.expectedIncrement,
      pathIncrement: challenge.pathIncrement,
      approvedAt: EVALUATED_AT,
      validUntil: challenge.validUntil,
      approvedByRef: 'user/owner'
    }

    expect(authorizeExecutionPlan(plan, session(current), snapshot, policy, { evaluatedAt: APPROVED_EVALUATED_AT, justification, approval: grant }, authority)).toMatchObject({
      status: 'authorized',
      mode: 'approved-increment',
      reasonCode: 'approval-granted',
      approvalEventId: 'approval/event-1'
    })

    expect(authorizeExecutionPlan(plan, session(current), snapshot, policy, { evaluatedAt: APPROVED_EVALUATED_AT, justification, approval: grant }, authority)).toMatchObject({
      status: 'rejected',
      reasonCode: 'approval-host-rejected',
      dispatchAuthorized: false
    })

    grant.pathIncrement = { ...grant.pathIncrement, numerator: '3', amount: '3.00' }
    expect(authorizeExecutionPlan(plan, session(current), snapshot, policy, { evaluatedAt: APPROVED_EVALUATED_AT, justification, approval: grant }, authority)).toMatchObject({
      status: 'rejected',
      reasonCode: 'approval-scope-mismatch'
    })
  })

  it('keeps monetary authority separate from candidate or tool approval', () => {
    const current = candidate('session', '10')
    const delegated = candidate('side-effecting', '5', true)
    const snapshot = catalogue([current, delegated])
    const proposals = [proposal(delegated)]
    const plan = selectMinimumCostExecutionPlan(proposals, requirements, snapshot, policy)
    expect(authorizeExecutionPlan(plan, session(current), snapshot, policy, { evaluatedAt: EVALUATED_AT }, host(proposals))).toMatchObject({
      status: 'authorized',
      mode: 'automatic',
      dispatchAuthorized: false,
      nonMonetaryApprovalRequired: true
    })
  })

  it('requires authenticated session evidence from the host boundary', () => {
    const current = candidate('session', '10')
    const delegated = candidate('delegated', '5')
    const snapshot = catalogue([current, delegated])
    const proposals = [proposal(delegated)]
    const plan = selectMinimumCostExecutionPlan(proposals, requirements, snapshot, policy)
    const authority = host(proposals)
    authority.verifySessionEvidence = () => false

    expect(() => authorizeExecutionPlan(plan, session(current), snapshot, policy, { evaluatedAt: EVALUATED_AT }, authority)).toThrow(/authenticate the active session/)
  })

  it('rejects a self-hashed decision that does not match recomputed planner evidence', () => {
    const current = candidate('session', '10')
    const delegated = candidate('delegated', '5')
    const snapshot = catalogue([current, delegated])
    const proposals = [proposal(delegated)]
    const plan = selectMinimumCostExecutionPlan(proposals, requirements, snapshot, policy)
    const forged = JSON.parse(JSON.stringify(plan))
    forged.selected.expectedAggregateP95 = { ...forged.selected.expectedAggregateP95, numerator: '0', denominator: '1', amount: '0.00' }
    forged.selected.maximumPathP95 = { ...forged.selected.maximumPathP95, numerator: '0', denominator: '1', amount: '0.00' }
    forged.qualified[0] = forged.selected
    const payload = { ...forged }
    delete payload.id
    forged.id = stableFingerprint(payload)

    expect(() => authorizeExecutionPlan(forged, session(current), snapshot, policy, { evaluatedAt: EVALUATED_AT }, host(proposals))).toThrow(/recomputed authoritative planner evidence/)
  })
})
