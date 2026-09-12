import {
  authorizeExecutionRecovery,
  type ExecutionBudgetApprovalGrant,
  type ExecutionBudgetJustification,
  type ExecutionRecoveryBudgetEvidence,
  type ExecutionRecoveryBudgetHostAuthority,
  type SessionWorkloadEvidence
} from '../../../execution/budget'
import {
  classifyTaskIntent,
  createExecutionCandidateId,
  selectMinimumCostExecutionPlan,
  type ExecutionCandidate,
  type ExecutionCandidateCatalogueSnapshot,
  type ExecutionPlanNode,
  type ExecutionPlanProposal,
  type ExecutionPlanSelectionPolicy,
  type ExecutionRequirementSet
} from '../../../execution'

const OBSERVED_AT = '2026-09-12T10:00:00.000Z'
const PLANNING_AT = '2026-09-12T12:00:00.000Z'
const EVALUATED_AT = '2026-09-12T12:01:00.000Z'
const APPROVED_AT = '2026-09-12T12:02:00.000Z'
const VALID_UNTIL = '2026-09-13T12:00:00.000Z'
const HISTORY_HEAD = 'a'.repeat(64)

function candidate(model: string, price: string, effort: 'high' | 'medium' = model === 'session' ? 'high' : 'medium'): ExecutionCandidate {
  return {
    id: createExecutionCandidateId('provider', 'hosted', model, effort),
    provider: { id: 'provider' },
    runtime: { id: 'hosted', kind: 'cloud' },
    model: { id: model },
    effort: { normalized: effort, sourceId: effort },
    context: { windowTokens: 64_000, maxOutputTokens: 8_000 },
    capabilities: ['code', 'text'],
    availability: { state: 'available', checkedAt: OBSERVED_AT, validUntil: VALID_UNTIL },
    pricing: { observedAt: OBSERVED_AT, validUntil: VALID_UNTIL, dimensions: [{ kind: 'request', amount: price, currency: 'USD', unit: 'request', per: 1, sourceUnit: 'request' }] },
    privacy: { boundary: 'provider-managed', trainingUse: 'none', retentionDays: 0 },
    tools: { mode: 'none', supported: [], parallelCalls: false, requiresApproval: false },
    source: { adapterId: 'fixture', candidateRef: `models/${model}`, retrievedAt: OBSERVED_AT }
  }
}

function proposal(entry: ExecutionCandidate): ExecutionPlanProposal {
  const node: ExecutionPlanNode = {
    id: 'primary',
    role: 'primary',
    candidateId: entry.id,
    estimate: {
      usageP95: { request: '1' },
      latencyP95Ms: 1_000,
      observedAt: OBSERVED_AT,
      validUntil: VALID_UNTIL,
      evidenceRef: 'benchmarks/recovery',
      independenceDomain: `fixture/${entry.model.id}`
    },
    tools: [],
    checks: ['automated-tests', 'self-review', 'type-check'],
    outcomes: [{ code: 'success', conditionalProbability: '1', evidenceRef: 'rates/recovery-success' }]
  }
  return { schemaVersion: 1, id: 'plan/recovery', rootNodeId: 'primary', nodes: [node] }
}

function catalogue(entries: ExecutionCandidate[]): ExecutionCandidateCatalogueSnapshot {
  return { version: 1, generatedAt: OBSERVED_AT, eligible: entries, excluded: [] }
}

const requirements = classifyTaskIntent({ text: 'Document a public value', categories: ['mechanical'], signals: { operation: 'document' } })
const policy: ExecutionPlanSelectionPolicy = { schemaVersion: 1, planningAt: PLANNING_AT, settlementCurrency: 'USD', displayScale: 2, tieBreakers: ['lower-max-path-cost', 'fewer-nodes'] }
const justification: ExecutionBudgetJustification = { reasonCode: 'fallback-resilience', expectedBenefitCodes: ['fallback-resilience'], evidenceRefs: ['benchmarks/recovery'] }

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

function history(spent: string, revision = 1): ExecutionRecoveryBudgetEvidence {
  return {
    schemaVersion: 1,
    runId: 'run/current',
    revision,
    historyHead: HISTORY_HEAD,
    reservations: [{ attemptId: `attempt-${revision}`, reservedInvocationP95: { currency: 'USD', numerator: spent, denominator: '1', amount: `${spent}.00`, scale: 2, rounding: 'ceiling' } }]
  }
}

function host(proposals: readonly unknown[], configuredRequirements: ExecutionRequirementSet = requirements, consumed = new Set<string>()): ExecutionRecoveryBudgetHostAuthority {
  return {
    requirements: configuredRequirements,
    proposals,
    verifySessionEvidence: () => true,
    verifyRecoveryHistory: () => true,
    consumeApprovalGrant: (grant) => !consumed.has(grant.id) && (consumed.add(grant.id), true)
  }
}

function grant(challenge: NonNullable<ReturnType<typeof authorizeExecutionRecovery>['challenge']>, id = 'approval/recovery-1'): ExecutionBudgetApprovalGrant {
  return {
    schemaVersion: 1,
    id,
    challengeId: challenge.id,
    sessionId: challenge.sessionId,
    planDecisionId: challenge.planDecisionId,
    expectedIncrement: challenge.expectedIncrement,
    pathIncrement: challenge.pathIncrement,
    approvedAt: APPROVED_AT,
    validUntil: challenge.validUntil,
    approvedByRef: 'user/owner'
  }
}

describe('execution recovery budget authority (#732)', () => {
  it('adds spent reservations to recovery E/M and auto-authorizes within the baseline', () => {
    const current = candidate('session', '10')
    const recovery = candidate('recovery', '4')
    const entries = [current, recovery]
    const proposals = [proposal(recovery)]
    const plan = selectMinimumCostExecutionPlan(proposals, requirements, catalogue(entries), policy)
    const result = authorizeExecutionRecovery(plan, session(current), catalogue(entries), policy, history('3'), { evaluatedAt: EVALUATED_AT }, host(proposals))

    expect(result).toMatchObject({
      status: 'authorized',
      mode: 'automatic',
      reasonCode: 'within-session-authority',
      spentP95: { amount: '3.00' },
      remainingAutomaticAuthorityP95: { amount: '7.00' },
      recoveryExpectedTotalP95: { amount: '7.00' },
      recoveryMaximumTotalP95: { amount: '7.00' }
    })
  })

  it('creates a lineage-bound challenge for recovery totals above the baseline', () => {
    const current = candidate('session', '10')
    const recovery = candidate('recovery', '5')
    const entries = [current, recovery]
    const proposals = [proposal(recovery)]
    const plan = selectMinimumCostExecutionPlan(proposals, requirements, catalogue(entries), policy)
    const result = authorizeExecutionRecovery(plan, session(current), catalogue(entries), policy, history('7', 2), { evaluatedAt: EVALUATED_AT, justification }, host(proposals))

    expect(result).toMatchObject({
      status: 'approval-required',
      reasonCode: 'plan-exceeds-session-authority',
      runId: 'run/current',
      lineageRevision: 2,
      historyHead: HISTORY_HEAD,
      spentP95: { amount: '7.00' },
      remainingAutomaticAuthorityP95: { amount: '3.00' },
      recoveryExpectedTotalP95: { amount: '12.00' },
      recoveryMaximumTotalP95: { amount: '12.00' },
      challenge: {
        runId: 'run/current',
        lineageRevision: 2,
        historyHead: HISTORY_HEAD,
        expectedIncrement: { amount: '2.00' },
        pathIncrement: { amount: '2.00' },
        spentP95: { amount: '7.00' },
        remainingAutomaticAuthorityP95: { amount: '3.00' }
      }
    })
  })

  it('rejects prior-revision grants, accepts a matching grant once, and rejects replay', () => {
    const current = candidate('session', '10')
    const recovery = candidate('recovery', '5')
    const entries = [current, recovery]
    const proposals = [proposal(recovery)]
    const plan = selectMinimumCostExecutionPlan(proposals, requirements, catalogue(entries), policy)
    const authority = host(proposals)
    const prior = authorizeExecutionRecovery(plan, session(current), catalogue(entries), policy, history('7', 1), { evaluatedAt: EVALUATED_AT, justification }, authority)
    const currentRevision = authorizeExecutionRecovery(plan, session(current), catalogue(entries), policy, history('7', 2), { evaluatedAt: EVALUATED_AT, justification }, authority)

    expect(
      authorizeExecutionRecovery(plan, session(current), catalogue(entries), policy, history('7', 2), { evaluatedAt: EVALUATED_AT, justification, approval: grant(prior.challenge!) }, authority)
    ).toMatchObject({ status: 'rejected', reasonCode: 'approval-scope-mismatch' })
    const approved = authorizeExecutionRecovery(
      plan,
      session(current),
      catalogue(entries),
      policy,
      history('7', 2),
      { evaluatedAt: APPROVED_AT, justification, approval: grant(currentRevision.challenge!) },
      authority
    )
    expect(approved).toMatchObject({ status: 'authorized', mode: 'approved-increment', reasonCode: 'approval-granted', approvalEventId: 'approval/recovery-1' })
    expect(
      authorizeExecutionRecovery(
        plan,
        session(current),
        catalogue(entries),
        policy,
        history('7', 2),
        { evaluatedAt: APPROVED_AT, justification, approval: grant(currentRevision.challenge!) },
        authority
      )
    ).toMatchObject({ status: 'rejected', reasonCode: 'approval-host-rejected' })
  })

  function expectInvalidHistory(mutate: (value: ExecutionRecoveryBudgetEvidence) => void, configure?: (authority: ExecutionRecoveryBudgetHostAuthority) => void): void {
    const current = candidate('session', '10')
    const recovery = candidate('recovery', '4')
    const entries = [current, recovery]
    const proposals = [proposal(recovery)]
    const plan = selectMinimumCostExecutionPlan(proposals, requirements, catalogue(entries), policy)
    const evidence = history('3')
    const authority = host(proposals)
    configure?.(authority)
    mutate(evidence)

    expect(() => authorizeExecutionRecovery(plan, session(current), catalogue(entries), policy, evidence, { evaluatedAt: EVALUATED_AT }, authority)).toThrow()
  }

  it('fails closed for unauthenticated history', () =>
    expectInvalidHistory(
      () => {},
      (authority) => {
        authority.verifyRecoveryHistory = () => false
      }
    ))
  it('fails closed for tampered history heads', () =>
    expectInvalidHistory((value) => {
      value.historyHead = 'bad'
    }))
  it('fails closed for duplicate reservations', () =>
    expectInvalidHistory((value) => {
      value.reservations = [value.reservations[0], value.reservations[0]]
    }))
  it('fails closed for secret-like attempt IDs', () =>
    expectInvalidHistory((value) => {
      value.reservations[0].attemptId = 'sk-secret-secret-secret'
    }))
  it('fails closed for oversized reservation histories', () =>
    expectInvalidHistory((value) => {
      value.reservations = Array.from({ length: 65 }, (_, index) => ({ attemptId: `attempt-${index}`, reservedInvocationP95: value.reservations[0].reservedInvocationP95 }))
    }))

  it('rejects a recovery with no qualified plan', () => {
    const current = candidate('session', '10')
    const recovery = candidate('recovery', '4')
    const entries = [current, recovery]
    const proposals = [proposal(recovery)]
    const securityRequirements = classifyTaskIntent({
      text: 'Perform a security review',
      categories: ['security'],
      signals: { operation: 'security-review', requiredCapabilities: ['security-analysis'] }
    })
    const plan = selectMinimumCostExecutionPlan(proposals, securityRequirements, catalogue(entries), policy)

    expect(authorizeExecutionRecovery(plan, session(current), catalogue(entries), policy, history('3'), { evaluatedAt: EVALUATED_AT }, host(proposals, securityRequirements))).toMatchObject({
      status: 'rejected',
      reasonCode: 'no-qualified-plan',
      spentP95: { amount: '3.00' }
    })
  })
})
