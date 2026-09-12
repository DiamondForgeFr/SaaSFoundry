import {
  assertExecutionDecisionExplanation,
  classifyTaskIntent,
  createExecutionCandidateId,
  createExecutionLineage,
  explainExecutionDecision,
  selectMinimumCostExecutionPlan,
  stableFingerprint,
  type ExecutionBudgetDecision,
  type ExecutionCandidate,
  type ExecutionCandidateCatalogueSnapshot,
  type ExecutionPlanProposal,
  type ExecutionPlanSelectionPolicy
} from '../../../execution'

const OBSERVED_AT = '2026-09-12T10:00:00.000Z'
const PLANNING_AT = '2026-09-12T12:00:00.000Z'
const VALID_UNTIL = '2026-09-13T12:00:00.000Z'

function candidate(model: string, price: string, capabilities = ['code', 'text']): ExecutionCandidate {
  return {
    id: createExecutionCandidateId('provider', 'hosted', model, 'medium'),
    provider: { id: 'provider' },
    runtime: { id: 'hosted', kind: 'cloud' },
    model: { id: model },
    effort: { normalized: 'medium', sourceId: 'medium' },
    context: { windowTokens: 64_000, maxOutputTokens: 8_000 },
    capabilities,
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
          independenceDomain: `provider/${entry.model.id}`
        },
        tools: [],
        checks: ['automated-tests', 'self-review', 'type-check'],
        outcomes: [{ code: 'success', conditionalProbability: '1', evidenceRef: `rates/${id}` }]
      }
    ]
  }
}

const requirements = classifyTaskIntent({ text: 'Document a public value', categories: ['mechanical'], signals: { operation: 'document' } })
const policy: ExecutionPlanSelectionPolicy = { schemaVersion: 1, planningAt: PLANNING_AT, settlementCurrency: 'USD', displayScale: 4, tieBreakers: ['lower-p95-latency', 'prefer-local'] }

function fixture() {
  const cheap = candidate('cheap', '1')
  const expensive = candidate('expensive', '2')
  const invalid = candidate('invalid', '0.5', ['text'])
  const proposals = [proposal('plan/cheap', cheap), proposal('plan/expensive', expensive), proposal('plan/invalid', invalid)]
  const catalogue: ExecutionCandidateCatalogueSnapshot = { version: 1, generatedAt: OBSERVED_AT, eligible: [cheap, expensive, invalid], excluded: [] }
  return { cheap, proposals, catalogue, decision: selectMinimumCostExecutionPlan(proposals, requirements, catalogue, policy) }
}

function budgetDecision(planDecisionId: string, proposalFingerprint: string, expected: ExecutionBudgetDecision['expectedAggregateP95']): ExecutionBudgetDecision {
  const payload: Omit<ExecutionBudgetDecision, 'id'> = {
    schemaVersion: 1,
    status: 'authorized',
    mode: 'automatic',
    reasonCode: 'within-session-authority',
    evaluatedAt: '2026-09-12T12:01:00.000Z',
    planDecisionId,
    proposalFingerprint,
    sessionEnvelopeId: stableFingerprint('envelope'),
    sessionId: 'session/current',
    sessionCandidateId: 'provider/hosted/session/high',
    sessionEffort: 'high',
    workloadFingerprint: stableFingerprint('workload'),
    authorityRevision: 'authority/1',
    currency: 'USD',
    expectedAggregateP95: expected,
    maximumPathP95: expected,
    baselineP95: { currency: 'USD', numerator: '3', denominator: '1', amount: '3.0000', scale: 4, rounding: 'ceiling' },
    dispatchAuthorized: true,
    nonMonetaryApprovalRequired: false
  }
  return { ...payload, id: stableFingerprint(payload) }
}

describe('execution decision explanations (#735)', () => {
  it('projects the winner, qualified loser, exclusions, exact costs, and stable reasons', () => {
    const { decision } = fixture()
    const explanation = explainExecutionDecision(decision)

    expect(explanation.selected).toMatchObject({
      proposalId: 'plan/cheap',
      candidateId: 'provider/hosted/cheap/medium',
      expectedAggregateP95: { numerator: '1', denominator: '1' },
      reasonCode: 'minimum-expected-cost'
    })
    expect(explanation.alternatives).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ proposalId: 'plan/expensive', status: 'qualified', reasonCodes: ['tie-break:expected-aggregate-p95'] }),
        expect.objectContaining({ proposalId: 'plan/invalid', status: 'excluded', reasonCodes: expect.arrayContaining(['capability-mismatch']) })
      ])
    )
    expect(() => assertExecutionDecisionExplanation(JSON.parse(JSON.stringify(explanation)))).not.toThrow()
    expect(Object.isFrozen(explanation.alternatives)).toBe(true)
  })

  it('is independent of proposal and catalogue order', () => {
    const { proposals, catalogue, decision } = fixture()
    const reordered = selectMinimumCostExecutionPlan([...proposals].reverse(), requirements, { ...catalogue, eligible: [...catalogue.eligible].reverse() }, policy)

    expect(explainExecutionDecision(decision)).toEqual(explainExecutionDecision(reordered))
  })

  it('projects authority and lineage facts without changing either source artifact', () => {
    const { decision } = fixture()
    const selected = decision.selected!
    const authority = budgetDecision(decision.id, selected.proposalFingerprint, selected.expectedAggregateP95)
    const lineage = createExecutionLineage(decision, 'scope/1', ['execution/initial'], { runId: 'run/host-unique', taskFingerprint: requirements.taskFingerprint, maxAttempts: 4, maxReplans: 2 })
    const before = JSON.stringify({ decision, authority, lineage })

    const explanation = explainExecutionDecision(decision, { budgetDecision: authority, lineage })

    expect(explanation.authority).toMatchObject({ status: 'authorized', reasonCode: 'within-session-authority', dispatchAuthorized: true })
    expect(explanation.lineage).toMatchObject({ runId: 'run/host-unique', revision: 1, attemptCount: 1, lastTrigger: 'initial' })
    expect(explanation.evidenceRefs).toEqual(expect.arrayContaining(['execution/initial', 'benchmarks/plan/cheap', 'rates/plan/cheap']))
    expect(JSON.stringify({ decision, authority, lineage })).toBe(before)
  })

  it('rejects mismatched authority, lineage, unsupported inputs, and tampered explanations', () => {
    const { decision } = fixture()
    const authority = budgetDecision(stableFingerprint('different-plan'), decision.selected!.proposalFingerprint, decision.selected!.expectedAggregateP95)
    const lineage = createExecutionLineage(decision, 'scope/1', [], { runId: 'run/host-unique', taskFingerprint: requirements.taskFingerprint })

    expect(() => explainExecutionDecision(decision, { budgetDecision: authority })).toThrow(/reference the explained plan/)
    expect(() => explainExecutionDecision(decision, { lineage: { ...lineage, currentPlanDecisionId: stableFingerprint('different-plan') } })).toThrow()
    expect(() => explainExecutionDecision(decision, { rawPrompt: 'secret' } as never)).toThrow(/unsupported fields/)

    const tampered = JSON.parse(JSON.stringify(explainExecutionDecision(decision))) as Record<string, unknown>
    tampered.status = 'unplannable'
    expect(() => assertExecutionDecisionExplanation(tampered)).toThrow(/canonical payload/)
  })
})
