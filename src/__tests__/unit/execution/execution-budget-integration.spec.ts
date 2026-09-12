import {
  authorizeExecutionPlan,
  classifyTaskIntent,
  createExecutionCandidateId,
  ExecutionCandidateCatalogue,
  selectMinimumCostExecutionPlan,
  type ExecutionBudgetJustification,
  type ExecutionCandidate,
  type ExecutionCandidateAdapter,
  type ExecutionPlanProposal,
  type ExecutionPlanSelectionPolicy,
  type SessionWorkloadEvidence
} from '../../../execution'

const OBSERVED_AT = '2026-09-12T10:00:00.000Z'
const PLANNING_AT = '2026-09-12T12:00:00.000Z'
const EVALUATED_AT = '2026-09-12T12:01:00.000Z'
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
    pricing: {
      observedAt: OBSERVED_AT,
      validUntil: VALID_UNTIL,
      dimensions: [{ kind: 'request', amount: price, currency: 'USD', unit: 'request', per: 1, sourceUnit: 'request' }]
    },
    privacy: { boundary: 'provider-managed', trainingUse: 'none', retentionDays: 0 },
    tools: { mode: 'none', supported: [], parallelCalls: false, requiresApproval: false },
    source: { adapterId: 'fixture', candidateRef: `models/${model}`, retrievedAt: OBSERVED_AT }
  }
}

function adapter(entries: readonly ExecutionCandidate[]): ExecutionCandidateAdapter {
  return {
    id: 'fixture',
    discover: () => entries.map((entry) => ({ sourceId: entry.source.candidateRef, value: entry })),
    normalize: (observation) => observation.value as ExecutionCandidate
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

const policy: ExecutionPlanSelectionPolicy = {
  schemaVersion: 1,
  planningAt: PLANNING_AT,
  settlementCurrency: 'USD',
  displayScale: 2,
  tieBreakers: ['lower-max-path-cost', 'fewer-nodes']
}

function session(entry: ExecutionCandidate, usage = '1'): SessionWorkloadEvidence {
  return {
    schemaVersion: 1,
    sessionId: 'session/current',
    candidateId: entry.id,
    usageP95: { request: usage },
    observedAt: OBSERVED_AT,
    validUntil: VALID_UNTIL,
    evidenceRef: 'session/workload/current',
    authorityRevision: 'session/revision-1'
  }
}

const justification: ExecutionBudgetJustification = {
  reasonCode: 'quality-requirement',
  expectedBenefitCodes: ['higher-quality'],
  evidenceRefs: ['quality/benchmark-1']
}

describe('public execution budget integration (#729)', () => {
  it('flows from adapter discovery through requirements and planning to exact session authority', async () => {
    const current = candidate('current', '1.001', 'high')
    const equal = candidate('equal', '1.001')
    const roundedSameButHigher = candidate('rounded-higher', '1.009')
    const catalogue = await new ExecutionCandidateCatalogue({ clock: () => new Date(PLANNING_AT) }).register(adapter([roundedSameButHigher, current, equal])).snapshot()
    const requirements = classifyTaskIntent({ text: 'Document a public value', categories: ['mechanical'], signals: { operation: 'document' } })

    const equalPlan = selectMinimumCostExecutionPlan([proposal('plan/equal', equal)], requirements, catalogue, policy)
    const equalDecision = authorizeExecutionPlan(equalPlan, session(current), catalogue, policy, { evaluatedAt: EVALUATED_AT })
    expect(equalDecision).toMatchObject({
      status: 'authorized',
      mode: 'automatic',
      baselineP95: { numerator: '1001', denominator: '1000', amount: '1.01' },
      expectedAggregateP95: { numerator: '1001', denominator: '1000', amount: '1.01' }
    })

    const higherPlan = selectMinimumCostExecutionPlan([proposal('plan/rounded-higher', roundedSameButHigher)], requirements, catalogue, policy)
    const higherDecision = authorizeExecutionPlan(higherPlan, session(current), catalogue, policy, { evaluatedAt: EVALUATED_AT, justification })
    expect(higherDecision).toMatchObject({
      status: 'approval-required',
      baselineP95: { amount: '1.01' },
      expectedAggregateP95: { amount: '1.01' },
      challenge: {
        expectedIncrement: { numerator: '1', denominator: '125', amount: '0.01' },
        pathIncrement: { numerator: '1', denominator: '125', amount: '0.01' }
      }
    })
  })

  it('is deterministic across catalogue and proposal order and emits secret-safe evidence', async () => {
    const current = candidate('current', '10', 'high')
    const first = candidate('a', '2')
    const second = candidate('b', '3')
    const leftCatalogue = await new ExecutionCandidateCatalogue({ clock: () => new Date(PLANNING_AT) }).register(adapter([current, second, first])).snapshot()
    const rightCatalogue = await new ExecutionCandidateCatalogue({ clock: () => new Date(PLANNING_AT) }).register(adapter([first, current, second])).snapshot()
    const requirements = classifyTaskIntent({ text: 'Private raw prompt with sk-12345678901234567890', categories: ['mechanical'], signals: { operation: 'document' } })

    const left = selectMinimumCostExecutionPlan([proposal('plan/b', second), proposal('plan/a', first)], requirements, leftCatalogue, policy)
    const right = selectMinimumCostExecutionPlan([proposal('plan/a', first), proposal('plan/b', second)], requirements, rightCatalogue, policy)
    const leftDecision = authorizeExecutionPlan(left, session(current), leftCatalogue, policy, { evaluatedAt: EVALUATED_AT })
    const rightDecision = authorizeExecutionPlan(right, session(current), rightCatalogue, policy, { evaluatedAt: EVALUATED_AT })

    expect(left.id).toBe(right.id)
    expect(leftDecision.id).toBe(rightDecision.id)
    expect(left.selected?.proposalId).toBe('plan/a')
    expect(JSON.stringify({ requirements, left, leftDecision })).not.toContain('sk-12345678901234567890')
  })

  it('rejects unplannable work without manufacturing monetary authority', async () => {
    const current = candidate('current', '10', 'high')
    const catalogue = await new ExecutionCandidateCatalogue({ clock: () => new Date(PLANNING_AT) }).register(adapter([current])).snapshot()
    const requirements = classifyTaskIntent({
      text: 'Perform a security review',
      categories: ['security'],
      signals: { operation: 'security-review', requiredCapabilities: ['security-analysis'] }
    })
    const plan = selectMinimumCostExecutionPlan([proposal('plan/insufficient', current)], requirements, catalogue, policy)

    expect(authorizeExecutionPlan(plan, session(current), catalogue, policy, { evaluatedAt: EVALUATED_AT })).toMatchObject({
      status: 'rejected',
      mode: null,
      reasonCode: 'no-qualified-plan'
    })
  })
})
