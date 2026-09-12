import {
  applyExecutionCalibrationToPlanEstimate,
  authorizeExecutionPlan,
  classifyTaskIntent,
  createExecutionCandidateId,
  createExecutionLineage,
  deriveExecutionCalibrationSnapshot,
  explainExecutionDecision,
  recordExecutionOutcome,
  selectMinimumCostExecutionPlan,
  type ExecutionBudgetHostAuthority,
  type ExecutionCalibrationCohort,
  type ExecutionCalibrationPolicy,
  type ExecutionCandidate,
  type ExecutionCandidateCatalogueSnapshot,
  type ExecutionDispatchBinding,
  type ExecutionOutcomeEvidence,
  type ExecutionPlanProposal,
  type ExecutionPlanSelectionPolicy,
  type SessionWorkloadEvidence
} from '../../../execution'

const OBSERVED_AT = '2026-09-12T09:00:00.000Z'
const OCCURRED_AT = '2026-09-12T10:00:00.000Z'
const RECEIVED_AT = '2026-09-12T10:01:00.000Z'
const CALIBRATED_AT = '2026-09-12T11:30:00.000Z'
const PLANNING_AT = '2026-09-12T12:00:00.000Z'
const VALID_UNTIL = '2026-09-13T12:00:00.000Z'

function candidate(model: string, price: string, effort: 'medium' | 'high' = 'medium'): ExecutionCandidate {
  return {
    id: createExecutionCandidateId('fixture', 'cloud', model, effort),
    provider: { id: 'fixture' },
    runtime: { id: 'cloud', kind: 'cloud' },
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

function proposal(id: string, entry: ExecutionCandidate): ExecutionPlanProposal {
  return {
    schemaVersion: 1,
    id,
    rootNodeId: 'primary',
    nodes: [
      {
        id: 'primary',
        role: 'primary',
        candidateId: entry.id,
        estimate: {
          usageP95: { request: '1' },
          latencyP95Ms: 1_000,
          observedAt: OBSERVED_AT,
          validUntil: VALID_UNTIL,
          evidenceRef: `benchmarks/${id}`,
          independenceDomain: `fixture/${entry.model.id}`
        },
        tools: [],
        checks: ['automated-tests', 'self-review', 'type-check'],
        outcomes: [{ code: 'success', conditionalProbability: '1', evidenceRef: `rates/${id}` }]
      }
    ]
  }
}

describe('execution explanation and calibration pipeline (#737)', () => {
  it('changes only future routing while historical decisions and authority remain byte-stable', () => {
    const underestimated = candidate('underestimated', '1')
    const steady = candidate('steady', '2')
    const sessionCandidate = candidate('session', '10', 'high')
    const catalogue: ExecutionCandidateCatalogueSnapshot = { version: 1, generatedAt: OBSERVED_AT, eligible: [underestimated, steady, sessionCandidate], excluded: [] }
    const proposals = [proposal('plan/underestimated', underestimated), proposal('plan/steady', steady)]
    const requirements = classifyTaskIntent({ text: 'Document a public value', categories: ['mechanical'], signals: { operation: 'document' } })
    const policy: ExecutionPlanSelectionPolicy = { schemaVersion: 1, planningAt: PLANNING_AT, settlementCurrency: 'USD', displayScale: 4, tieBreakers: ['lower-max-path-cost', 'fewer-nodes'] }
    const initialPlan = selectMinimumCostExecutionPlan(proposals, requirements, catalogue, policy)
    const session: SessionWorkloadEvidence = {
      schemaVersion: 1,
      sessionId: 'session/current',
      candidateId: sessionCandidate.id,
      usageP95: { request: '1' },
      observedAt: OBSERVED_AT,
      validUntil: VALID_UNTIL,
      evidenceRef: 'session/workload/current',
      authorityRevision: 'authority/1'
    }
    const authorityHost: ExecutionBudgetHostAuthority = { requirements, proposals, verifySessionEvidence: () => true, consumeApprovalGrant: () => false }
    const authority = authorizeExecutionPlan(initialPlan, session, catalogue, policy, { evaluatedAt: '2026-09-12T12:01:00.000Z' }, authorityHost)
    const lineage = createExecutionLineage(initialPlan, 'scope/1', ['execution/initial'], { runId: 'run/host-unique', taskFingerprint: requirements.taskFingerprint })
    const selected = initialPlan.selected!
    const cohort: ExecutionCalibrationCohort = {
      candidateId: selected.rootCandidateId,
      effort: selected.rootEffort,
      runtimeKind: selected.rootRuntimeKind,
      workloadClass: 'code/mechanical',
      privacyBoundary: 'provider-managed',
      tenantBoundaryId: 'tenant/acme'
    }
    const binding: ExecutionDispatchBinding = {
      runId: lineage.runId,
      lineageId: lineage.id,
      lineageRevision: lineage.revision,
      historyHead: lineage.historyHead,
      attemptId: lineage.currentAttemptId,
      dispatchPermitId: 'permit/initial',
      planDecisionId: initialPlan.id,
      proposalFingerprint: selected.proposalFingerprint,
      nodeId: 'primary',
      candidateId: selected.rootCandidateId,
      retryOrdinal: 0,
      cohort
    }
    const recorded = new Map<string, ExecutionOutcomeEvidence>()
    const record = (eventId: string, actualRequests: string, latencyMs: number): ExecutionOutcomeEvidence =>
      recordExecutionOutcome(
        {
          schemaVersion: 1,
          eventId,
          binding,
          occurredAt: OCCURRED_AT,
          receivedAt: RECEIVED_AT,
          outcome: 'success',
          actualUsage: { request: actualRequests },
          metering: 'complete',
          latencyMs,
          validation: { result: 'passed', checks: ['automated-tests', 'type-check'] },
          sourceKind: 'provider-settlement',
          evidenceRefs: [`receipts/${eventId}`]
        },
        binding,
        {
          verifyOutcomeEvidence: () => true,
          appendOutcome: (evidence) => {
            const existing = recorded.get(evidence.eventId)
            if (existing) return existing.id === evidence.id ? { status: 'replayed', outcomeId: existing.id } : { status: 'rejected' }
            recorded.set(evidence.eventId, evidence)
            return { status: 'accepted', outcomeId: evidence.id }
          }
        }
      )
    const outcomes = [record('event/1', '4', 1_200), record('event/2', '6', 1_500)]
    const calibrationPolicy: ExecutionCalibrationPolicy = {
      schemaVersion: 1,
      estimatorVersion: 'nearest-rank/v1',
      cutoffAt: '2026-09-12T11:00:00.000Z',
      generatedAt: CALIBRATED_AT,
      validUntil: VALID_UNTIL,
      minimumSamples: 2,
      maximumSamples: 16,
      quantileBps: 9500,
      usageCaps: { request: '10' },
      latencyCapMs: 5_000,
      evidenceRef: 'calibration/underestimated/v1'
    }
    const historicalExplanation = explainExecutionDecision(initialPlan, { budgetDecision: authority, lineage, outcomes })
    const historicalBytes = JSON.stringify({ initialPlan, authority, lineage, outcomes, historicalExplanation })

    const snapshot = deriveExecutionCalibrationSnapshot(outcomes, cohort, calibrationPolicy, { verifyRecordedOutcome: () => true })
    const calibratedProposal = applyExecutionCalibrationToPlanEstimate(proposals[0], 'primary', snapshot)
    const futurePlan = selectMinimumCostExecutionPlan([calibratedProposal, proposals[1]], requirements, catalogue, policy)
    const futureExplanation = explainExecutionDecision(futurePlan)

    expect(initialPlan.selected?.proposalId).toBe('plan/underestimated')
    expect(authority).toMatchObject({ status: 'authorized', dispatchAuthorized: true })
    expect(snapshot.usageP95).toEqual({ request: '6' })
    expect(futurePlan.selected?.proposalId).toBe('plan/steady')
    expect(futurePlan.id).not.toBe(initialPlan.id)
    expect(futureExplanation.selected?.candidateId).toBe(steady.id)
    expect(JSON.stringify({ initialPlan, authority, lineage, outcomes, historicalExplanation })).toBe(historicalBytes)
    expect(historicalExplanation.outcomes).toHaveLength(2)
  })
})
