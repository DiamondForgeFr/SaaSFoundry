import {
  assertExecutionLineage,
  assertExecutionReplanRequest,
  blockExecutionLineage,
  closeExecutionLineage,
  createExecutionLineage,
  createExecutionReplanRequest,
  replanExecution,
  type ExecutionLineage,
  type ExecutionReplanHostAuthority,
  type ExecutionReplanRequest
} from '../../../execution/replanning'
import {
  authorizeExecutionRecovery,
  classifyTaskIntent,
  createExecutionCandidateId,
  selectMinimumCostExecutionPlan,
  type ExecutionCandidate,
  type ExecutionCandidateCatalogueSnapshot,
  type ExecutionPlanNode,
  type ExecutionPlanProposal,
  type ExecutionPlanSelectionPolicy
} from '../../../execution'
import type { ExecutionRecoveryBudgetEvidence, ExecutionRecoveryBudgetHostAuthority, SessionWorkloadEvidence } from '../../../execution/budget'

const OBSERVED_AT = '2026-09-12T10:00:00.000Z'
const PLANNING_AT = '2026-09-12T12:00:00.000Z'
const VALID_UNTIL = '2026-09-13T12:00:00.000Z'
const FINGERPRINT = 'a'.repeat(64)

function candidate(model: string, price = '1'): ExecutionCandidate {
  return {
    id: createExecutionCandidateId('provider', 'hosted', model, 'medium'),
    provider: { id: 'provider' },
    runtime: { id: 'hosted', kind: 'cloud' },
    model: { id: model },
    effort: { normalized: 'medium', sourceId: 'medium' },
    context: { windowTokens: 64_000, maxOutputTokens: 8_000 },
    capabilities: ['code', 'repository-analysis', 'text', 'tool-use'],
    availability: { state: 'available', checkedAt: OBSERVED_AT, validUntil: VALID_UNTIL },
    pricing: { observedAt: OBSERVED_AT, validUntil: VALID_UNTIL, dimensions: [{ kind: 'request', amount: price, currency: 'USD', unit: 'request', per: 1, sourceUnit: 'request' }] },
    privacy: { boundary: 'provider-managed', trainingUse: 'none', retentionDays: 0 },
    tools: { mode: 'native', supported: ['file-edit', 'file-read'], parallelCalls: false, requiresApproval: true },
    source: { adapterId: 'fixture', candidateRef: `models/${model}`, retrievedAt: OBSERVED_AT }
  }
}

function proposal(id: string, entry: ExecutionCandidate, outcome: 'success' | 'execution-failed' = 'success'): ExecutionPlanProposal {
  const node: ExecutionPlanNode = {
    id: 'primary',
    role: 'primary',
    candidateId: entry.id,
    estimate: { usageP95: { request: '1' }, latencyP95Ms: 1_000, observedAt: OBSERVED_AT, validUntil: VALID_UNTIL, evidenceRef: `benchmarks/${id}`, independenceDomain: `fixture/${entry.model.id}` },
    tools: [],
    checks: ['automated-tests', 'self-review', 'type-check'],
    outcomes: [{ code: outcome, conditionalProbability: '1', evidenceRef: `rates/${id}` }]
  }
  return { schemaVersion: 1, id, rootNodeId: 'primary', nodes: [node] }
}

function catalogue(entries: ExecutionCandidate[]): ExecutionCandidateCatalogueSnapshot {
  return { version: 1, generatedAt: OBSERVED_AT, eligible: entries, excluded: [] }
}
const requirements = classifyTaskIntent({ text: 'Document a public value', categories: ['mechanical'], signals: { operation: 'document' } })
const policy: ExecutionPlanSelectionPolicy = { schemaVersion: 1, planningAt: PLANNING_AT, settlementCurrency: 'USD', displayScale: 2, tieBreakers: ['lower-max-path-cost', 'fewer-nodes'] }
const authority: ExecutionReplanHostAuthority = { verifyLineage: () => true, verifyScopeRevision: () => true }

function request(
  lineage: ExecutionLineage,
  trigger: ExecutionReplanRequest['trigger'] = 'execution-failed',
  outcomeCode: ExecutionReplanRequest['outcomeCode'] = 'execution-failed',
  scopeRevision = lineage.scopeRevision
): ExecutionReplanRequest {
  return createExecutionReplanRequest({
    schemaVersion: 1,
    parentPlanDecisionId: lineage.currentPlanDecisionId,
    parentAttemptId: lineage.currentAttemptId,
    trigger,
    scopeRevision,
    nodeId: 'primary',
    outcomeCode,
    invalidatedPermitIds: ['permit/old'],
    evidenceRefs: ['events/recovery']
  })
}

function setup() {
  const initialCandidate = candidate('initial', '2')
  const recoveryCandidate = candidate('recovery', '1')
  const initialProposal = proposal('plan/initial', initialCandidate, 'execution-failed')
  const initialDecision = selectMinimumCostExecutionPlan([initialProposal], requirements, catalogue([initialCandidate, recoveryCandidate]), policy)
  const lineage = createExecutionLineage(initialDecision, 'scope/v1', ['events/initial'], { runId: 'run/test', maxAttempts: 4, maxReplans: 3, taskFingerprint: requirements.taskFingerprint })
  return { initialCandidate, recoveryCandidate, initialProposal, initialDecision, lineage }
}

describe('execution replanning contracts (#733)', () => {
  it('creates deterministic request and initial lineage identities', () => {
    const { initialDecision } = setup()
    const first = createExecutionLineage(initialDecision, 'scope/v1', ['events/initial'], { runId: 'run/test', taskFingerprint: requirements.taskFingerprint })
    const second = createExecutionLineage(initialDecision, 'scope/v1', ['events/initial'], { runId: 'run/test', taskFingerprint: requirements.taskFingerprint })
    expect(first).toEqual(second)
    const left = request(first)
    const right = request(second)
    expect(left).toEqual(right)
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(left)).toBe(true)
  })

  it('replans from a separate fresh proposal set and records the exact failure outcome', () => {
    const { initialCandidate, recoveryCandidate, initialProposal, initialDecision, lineage } = setup()
    const recoveryProposal = proposal('plan/recovery', recoveryCandidate)
    const result = replanExecution(lineage, request(lineage), initialDecision, requirements, [recoveryProposal], catalogue([recoveryCandidate]), policy, initialProposal, authority)

    expect(result.decision.selected?.proposalId).toBe('plan/recovery')
    expect(result.lineage.attempts).toHaveLength(2)
    expect(result.lineage.attempts[1]).toMatchObject({
      trigger: 'execution-failed',
      outcomeCode: 'execution-failed',
      nodeId: 'primary',
      parentAttemptId: lineage.currentAttemptId,
      invalidatedPermitIds: ['permit/old']
    })
    expect(result.lineage.attempts[1].proposalFingerprint).not.toBe(initialDecision.selected?.proposalFingerprint)
    expect(initialCandidate.id).not.toBe(recoveryCandidate.id)
  })

  it('preserves frozen requirements for non-scope replans', () => {
    const { initialProposal, initialDecision, lineage, recoveryCandidate } = setup()
    const result = replanExecution(
      lineage,
      request(lineage),
      initialDecision,
      requirements,
      [proposal('plan/recovery', recoveryCandidate)],
      catalogue([recoveryCandidate]),
      policy,
      initialProposal,
      authority
    )
    expect(result.lineage.requirementsId).toBe(lineage.requirementsId)
    expect(result.lineage.taskFingerprint).toBe(lineage.taskFingerprint)
    expect(result.lineage.scopeRevision).toBe(lineage.scopeRevision)
  })

  it('requires a new scope revision and task fingerprint for scope changes', () => {
    const { initialProposal, initialDecision, lineage, recoveryCandidate } = setup()
    const changed = classifyTaskIntent({ text: 'Document a different public value', categories: ['mechanical'], signals: { operation: 'document' } })
    const scopeRequest = request(lineage, 'scope-changed', undefined, 'scope/v2')
    const result = replanExecution(lineage, scopeRequest, initialDecision, changed, [proposal('plan/recovery', recoveryCandidate)], catalogue([recoveryCandidate]), policy, initialProposal, authority)
    expect(result.lineage.scopeRevision).toBe('scope/v2')
    expect(result.lineage.taskFingerprint).toBe(changed.taskFingerprint)
    expect(result.lineage.requirementsId).toBe(changed.id)
    expect(() =>
      replanExecution(
        lineage,
        request(lineage, 'scope-changed', undefined, 'scope/v1'),
        initialDecision,
        changed,
        [proposal('plan/recovery', recoveryCandidate)],
        catalogue([recoveryCandidate]),
        policy,
        initialProposal,
        authority
      )
    ).toThrow(/new scope revision/)
  })

  it('requires host authentication of lineage and scope', () => {
    const { initialProposal, initialDecision, lineage, recoveryCandidate } = setup()
    const denied = { verifyLineage: () => false, verifyScopeRevision: () => true }
    expect(() =>
      replanExecution(lineage, request(lineage), initialDecision, requirements, [proposal('plan/recovery', recoveryCandidate)], catalogue([recoveryCandidate]), policy, initialProposal, denied)
    ).toThrow(/authenticate lineage/)
    const deniedScope = { verifyLineage: () => true, verifyScopeRevision: () => false }
    expect(() =>
      replanExecution(lineage, request(lineage), initialDecision, requirements, [proposal('plan/recovery', recoveryCandidate)], catalogue([recoveryCandidate]), policy, initialProposal, deniedScope)
    ).toThrow(/authenticate lineage/)
  })

  it('maintains append-only hash links and invalidated permit IDs', () => {
    const { initialProposal, initialDecision, lineage, recoveryCandidate } = setup()
    const result = replanExecution(
      lineage,
      request(lineage),
      initialDecision,
      requirements,
      [proposal('plan/recovery', recoveryCandidate)],
      catalogue([recoveryCandidate]),
      policy,
      initialProposal,
      authority
    )
    expect(result.lineage.historyHead).toBe(result.lineage.attempts[1].id)
    expect(result.lineage.attempts[1].parentAttemptId).toBe(result.lineage.attempts[0].id)
    expect(result.lineage.attempts[1].invalidatedPermitIds).toEqual(['permit/old'])
    expect(result.lineage.attempts[0].id).not.toBe(result.lineage.attempts[1].id)
    expect(() => assertExecutionLineage(result.lineage)).not.toThrow()
  })

  it('rejects tampered requests and lineages, unsafe IDs, and bounds', () => {
    const { initialDecision, lineage } = setup()
    const invalidRequest = JSON.parse(JSON.stringify(request(lineage))) as Record<string, unknown>
    invalidRequest.id = FINGERPRINT
    expect(() => assertExecutionReplanRequest(invalidRequest)).toThrow(/canonical payload/)
    const tampered = JSON.parse(JSON.stringify(lineage)) as Record<string, unknown>
    tampered.historyHead = FINGERPRINT
    expect(() => assertExecutionLineage(tampered)).toThrow(/current pointers|canonical payload/)
    expect(() => createExecutionLineage(initialDecision, 'scope/v1', [], { maxAttempts: 0 })).toThrow(/bounds/)
    expect(() => createExecutionLineage(initialDecision, 'scope/v1', [], { maxAttempts: 2, maxReplans: 2 })).toThrow(/bounds/)
    expect(() =>
      createExecutionReplanRequest({
        schemaVersion: 1,
        parentPlanDecisionId: FINGERPRINT,
        parentAttemptId: FINGERPRINT,
        trigger: 'execution-failed',
        scopeRevision: 'scope/v1',
        nodeId: 'sk-secret-secret-secret',
        outcomeCode: 'execution-failed',
        invalidatedPermitIds: [],
        evidenceRefs: []
      })
    ).toThrow(/safe public identifier/)
  })

  it('requires exact trigger/outcome pairs and blocks unknown outcomes', () => {
    const { initialDecision, initialProposal, lineage, recoveryCandidate } = setup()
    expect(() =>
      createExecutionReplanRequest({
        schemaVersion: 1,
        parentPlanDecisionId: lineage.currentPlanDecisionId,
        parentAttemptId: lineage.currentAttemptId,
        trigger: 'validation-failed',
        scopeRevision: lineage.scopeRevision,
        nodeId: 'primary',
        outcomeCode: 'execution-failed',
        invalidatedPermitIds: [],
        evidenceRefs: []
      })
    ).toThrow(/match/)
    const unknown = request(lineage, 'outcome-unknown', 'outcome-unknown')
    expect(() =>
      replanExecution(lineage, unknown, initialDecision, requirements, [proposal('plan/recovery', recoveryCandidate)], catalogue([recoveryCandidate]), policy, initialProposal, authority)
    ).toThrow(/ambiguous outcome/)
    const blocked = blockExecutionLineage(lineage, unknown)
    expect(blocked.terminalState).toBe('blocked')
    expect(blocked.attempts.at(-1)?.outcomeCode).toBe('outcome-unknown')
    expect(() =>
      replanExecution(blocked, unknown, initialDecision, requirements, [proposal('plan/recovery', recoveryCandidate)], catalogue([recoveryCandidate]), policy, initialProposal, authority)
    ).toThrow(/terminal lineage/)
  })

  it('cannot replan completed or otherwise terminal lineages', () => {
    const { initialProposal, initialDecision, lineage, recoveryCandidate } = setup()
    const completedLineage = closeExecutionLineage(lineage, 'completed', lineage.historyHead)
    expect(() => assertExecutionLineage(completedLineage)).not.toThrow()
    expect(() =>
      replanExecution(
        completedLineage,
        request(lineage),
        initialDecision,
        requirements,
        [proposal('plan/recovery', recoveryCandidate)],
        catalogue([recoveryCandidate]),
        policy,
        initialProposal,
        authority
      )
    ).toThrow(/terminal lineage/)
    expect(() => closeExecutionLineage(completedLineage, 'cancelled', completedLineage.historyHead)).toThrow(/cannot be closed again/)
  })

  it('carries authenticated lineage spend into fresh recovery authority', () => {
    const { initialCandidate, initialProposal, initialDecision, lineage, recoveryCandidate } = setup()
    const recoveryProposal = proposal('plan/recovery', recoveryCandidate)
    const freshCatalogue = catalogue([initialCandidate, recoveryCandidate])
    const recovery = replanExecution(lineage, request(lineage), initialDecision, requirements, [recoveryProposal], freshCatalogue, policy, initialProposal, authority)
    const history: ExecutionRecoveryBudgetEvidence = {
      schemaVersion: 1,
      runId: recovery.lineage.runId,
      revision: recovery.lineage.revision,
      historyHead: recovery.lineage.historyHead,
      reservations: [
        {
          attemptId: lineage.currentAttemptId,
          reservedInvocationP95: { currency: 'USD', numerator: '1', denominator: '1', amount: '1.00', scale: 2, rounding: 'ceiling' }
        }
      ]
    }
    const session: SessionWorkloadEvidence = {
      schemaVersion: 1,
      sessionId: 'session/current',
      candidateId: initialCandidate.id,
      usageP95: { request: '1' },
      observedAt: OBSERVED_AT,
      validUntil: VALID_UNTIL,
      evidenceRef: 'session/workload/current',
      authorityRevision: 'session/revision-1'
    }
    const budgetHost: ExecutionRecoveryBudgetHostAuthority = {
      requirements,
      proposals: [recoveryProposal],
      verifySessionEvidence: () => true,
      verifyRecoveryHistory: (value) => value.historyHead === recovery.lineage.historyHead,
      consumeApprovalGrant: () => false
    }

    expect(authorizeExecutionRecovery(recovery.decision, session, freshCatalogue, policy, history, { evaluatedAt: '2026-09-12T12:01:00.000Z' }, budgetHost)).toMatchObject({
      status: 'authorized',
      spentP95: { amount: '1.00' },
      remainingAutomaticAuthorityP95: { amount: '1.00' },
      recoveryExpectedTotalP95: { amount: '2.00' },
      recoveryMaximumTotalP95: { amount: '2.00' }
    })
  })
})
