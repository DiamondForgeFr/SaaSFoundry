import {
  classifyTaskIntent,
  createExecutionCandidateId,
  finalizeExecutionRequirementSet,
  qualifyAndCostExecutionPlan,
  type ExecutionCandidate,
  type ExecutionCandidateCatalogueSnapshot,
  type ExecutionPlanExclusionCode,
  type ExecutionPlanNode,
  type ExecutionPlanProposal,
  type ExecutionPlanSelectionPolicy,
  type ExecutionRequirementSet
} from '../../../execution'

const PLANNING_AT = '2026-09-12T12:00:00.000Z'
const OBSERVED_AT = '2026-09-12T10:00:00.000Z'
const VALID_UNTIL = '2026-09-13T12:00:00.000Z'

function candidate(model: string, requestPrice: string): ExecutionCandidate {
  return {
    id: createExecutionCandidateId('provider', 'hosted', model, 'medium'),
    provider: { id: 'provider' },
    runtime: { id: 'hosted', kind: 'cloud' },
    model: { id: model },
    effort: { normalized: 'medium', sourceId: 'medium' },
    context: { windowTokens: 64_000, maxOutputTokens: 8_000 },
    capabilities: ['code', 'text'],
    availability: { state: 'available', checkedAt: OBSERVED_AT, validUntil: VALID_UNTIL },
    pricing: {
      observedAt: OBSERVED_AT,
      validUntil: VALID_UNTIL,
      dimensions: [{ kind: 'request', amount: requestPrice, currency: 'USD', unit: 'request', per: 1, sourceUnit: 'request' }]
    },
    privacy: { boundary: 'provider-managed', trainingUse: 'none', retentionDays: 0 },
    tools: { mode: 'none', supported: [], parallelCalls: false, requiresApproval: false },
    source: { adapterId: 'fixture', candidateRef: `models/${model}`, retrievedAt: OBSERVED_AT }
  }
}

function catalogue(candidates: ExecutionCandidate[]): ExecutionCandidateCatalogueSnapshot {
  return { version: 1, generatedAt: OBSERVED_AT, eligible: candidates, excluded: [] }
}

function requirements(): ExecutionRequirementSet {
  return classifyTaskIntent({ text: 'Document a public value', categories: ['mechanical'], signals: { operation: 'document' } })
}

function adjustedRequirements(mutate: (value: ExecutionRequirementSet) => void): ExecutionRequirementSet {
  const value = JSON.parse(JSON.stringify(requirements())) as ExecutionRequirementSet
  mutate(value)
  return finalizeExecutionRequirementSet(value)
}

const policy: ExecutionPlanSelectionPolicy = {
  schemaVersion: 1,
  planningAt: PLANNING_AT,
  settlementCurrency: 'USD',
  displayScale: 2,
  tieBreakers: ['lower-max-path-cost', 'fewer-nodes']
}

function node(id: string, role: 'primary' | 'validation' | 'retry' | 'fallback', model: string, outcomes: ExecutionPlanProposal['nodes'][number]['outcomes']): ExecutionPlanNode {
  return {
    id,
    role,
    candidateId: createExecutionCandidateId('provider', 'hosted', model, 'medium'),
    estimate: {
      usageP95: { request: '1' },
      latencyP95Ms: 1_000,
      observedAt: OBSERVED_AT,
      validUntil: VALID_UNTIL,
      evidenceRef: `benchmarks/${id}`,
      independenceDomain: `provider/${model}`
    },
    tools: [],
    checks: id === 'primary' ? ['self-review', 'type-check', 'automated-tests'] : [],
    outcomes
  }
}

function proposal(): ExecutionPlanProposal {
  return {
    schemaVersion: 1,
    id: 'plan/complete-tree',
    rootNodeId: 'primary',
    nodes: [
      node('primary', 'primary', 'primary', [
        { code: 'success', conditionalProbability: '0.8', nextNodeId: 'validation', evidenceRef: 'rates/primary-success' },
        { code: 'execution-failed', conditionalProbability: '0.2', nextNodeId: 'retry', evidenceRef: 'rates/primary-failure' }
      ]),
      node('validation', 'validation', 'validation', [{ code: 'success', conditionalProbability: '1', evidenceRef: 'rates/validation-success' }]),
      node('retry', 'retry', 'retry', [
        { code: 'success', conditionalProbability: '0.5', evidenceRef: 'rates/retry-success' },
        { code: 'execution-failed', conditionalProbability: '0.5', nextNodeId: 'fallback', evidenceRef: 'rates/retry-failure' }
      ]),
      node('fallback', 'fallback', 'fallback', [{ code: 'success', conditionalProbability: '1', evidenceRef: 'rates/fallback-success' }])
    ]
  }
}

function candidates(): ExecutionCandidate[] {
  return [candidate('primary', '10'), candidate('validation', '2'), candidate('retry', '5'), candidate('fallback', '20')]
}

function exclusionCodes(result: ReturnType<typeof qualifyAndCostExecutionPlan>): ExecutionPlanExclusionCode[] {
  if (result.status !== 'excluded') throw new Error('Expected the plan to be excluded.')
  return result.exclusions.map((entry) => entry.code)
}

describe('exact execution-tree qualification and cost (#724)', () => {
  it('weights every reachable node exactly and retains the maximum terminal path', () => {
    const result = qualifyAndCostExecutionPlan(proposal(), requirements(), catalogue(candidates()), policy)

    expect(result.status).toBe('qualified')
    if (result.status !== 'qualified') return
    expect(result.plan.expectedAggregateP95).toMatchObject({ numerator: '73', denominator: '5', amount: '14.60' })
    expect(result.plan.maximumPathP95).toMatchObject({ numerator: '35', denominator: '1', amount: '35.00' })
    expect(result.plan.nodeCosts.map(({ nodeId, reachProbability }) => [nodeId, reachProbability])).toEqual([
      ['fallback', { numerator: '1', denominator: '10' }],
      ['primary', { numerator: '1', denominator: '1' }],
      ['retry', { numerator: '1', denominator: '5' }],
      ['validation', { numerator: '4', denominator: '5' }]
    ])
  })

  it.each([
    ['capability-mismatch', (plan: ExecutionPlanProposal, entries: ExecutionCandidate[]) => entries.forEach((entry) => (entry.capabilities = ['text']))],
    ['effort-mismatch', (_plan: ExecutionPlanProposal, entries: ExecutionCandidate[]) => entries.forEach((entry) => (entry.effort.normalized = 'minimal'))],
    ['context-mismatch', (_plan: ExecutionPlanProposal, entries: ExecutionCandidate[]) => entries.forEach((entry) => (entry.context.windowTokens = null))],
    ['tool-mismatch', (plan: ExecutionPlanProposal) => plan.nodes[0].tools.push('file-read')],
    ['validation-mismatch', (plan: ExecutionPlanProposal) => (plan.nodes[0].checks = [])],
    ['candidate-stale', (_plan: ExecutionPlanProposal, entries: ExecutionCandidate[]) => (entries[0].availability.validUntil = PLANNING_AT)],
    ['evidence-stale', (plan: ExecutionPlanProposal) => (plan.nodes[0].estimate.validUntil = PLANNING_AT)]
  ] as Array<[ExecutionPlanExclusionCode, (plan: ExecutionPlanProposal, entries: ExecutionCandidate[]) => void]>)('rejects %s before comparing price', (expected, mutate) => {
    const plan = proposal()
    const entries = candidates()
    mutate(plan, entries)

    expect(exclusionCodes(qualifyAndCostExecutionPlan(plan, requirements(), catalogue(entries), policy))).toContain(expected)
  })

  it('fails closed on retention and latency ceilings', () => {
    const entries = candidates()
    entries.forEach((entry) => (entry.privacy.retentionDays = null))
    const constrained = adjustedRequirements((value) => {
      value.effective.privacy.maxRetentionDays = 0
      value.effective.latency.maximumPlanP95Ms = 2_000
    })

    const codes = exclusionCodes(qualifyAndCostExecutionPlan(proposal(), constrained, catalogue(entries), policy))

    expect(codes).toContain('retention-unknown')
    expect(codes).toContain('latency-mismatch')
  })

  it('requires a different candidate and independence domain for independent review', () => {
    const constrained = adjustedRequirements((value) => {
      value.effective.validation.minimum = 'independent-review'
      value.effective.validation.requiredChecks.push('independent-review')
    })
    const plan = proposal()
    plan.nodes.find((entry) => entry.id === 'validation')!.checks = ['independent-review']
    const entries = candidates()

    expect(qualifyAndCostExecutionPlan(plan, constrained, catalogue(entries), policy).status).toBe('qualified')

    plan.nodes.find((entry) => entry.id === 'validation')!.estimate.independenceDomain = plan.nodes[0].estimate.independenceDomain
    expect(exclusionCodes(qualifyAndCostExecutionPlan(plan, constrained, catalogue(entries), policy))).toContain('independence-mismatch')
  })

  it.each([
    ['outcome-probabilities-must-sum-to-one', (plan: ExecutionPlanProposal) => (plan.nodes[0].outcomes[0].conditionalProbability = '0.7')],
    ['dangling-node', (plan: ExecutionPlanProposal) => (plan.nodes[0].outcomes[0].nextNodeId = 'missing')],
    ['unreachable-node', (plan: ExecutionPlanProposal) => plan.nodes.push(node('orphan', 'retry', 'retry', [{ code: 'success', conditionalProbability: '1', evidenceRef: 'rates/orphan' }]))],
    ['root-has-parent', (plan: ExecutionPlanProposal) => (plan.nodes[3].outcomes[0].nextNodeId = 'primary')]
  ])('rejects an invalid graph: %s', (detail, mutate) => {
    const plan = proposal()
    mutate(plan)
    const result = qualifyAndCostExecutionPlan(plan, requirements(), catalogue(candidates()), policy)

    expect(result).toMatchObject({ status: 'excluded', exclusions: [expect.objectContaining({ code: 'invalid-proposal', detailCode: detail })] })
  })

  it('rejects duplicate, missing, incompatible, stale, and cross-currency price evidence', () => {
    const mutations: Array<[ExecutionPlanExclusionCode, string, (entry: ExecutionCandidate) => void]> = [
      ['price-incomplete', 'duplicate-price-dimension', (entry) => entry.pricing.dimensions.push({ ...entry.pricing.dimensions[0] })],
      [
        'price-incomplete',
        'usage-missing-for-priced-dimension',
        (entry) => entry.pricing.dimensions.push({ kind: 'second', amount: '1', currency: 'USD', unit: 'second', per: 1, sourceUnit: 'second' })
      ],
      ['price-incomplete', 'incompatible-normalized-unit', (entry) => (entry.pricing.dimensions[0].unit = 'call')],
      ['candidate-stale', 'pricing-not-current', (entry) => (entry.pricing.validUntil = PLANNING_AT)],
      ['currency-uncomparable', 'settlement-currency-mismatch', (entry) => (entry.pricing.dimensions[0].currency = 'EUR')]
    ]
    for (const [code, detailCode, mutate] of mutations) {
      const entries = candidates()
      mutate(entries[0])
      const result = qualifyAndCostExecutionPlan(proposal(), requirements(), catalogue(entries), policy)
      expect(result).toMatchObject({ status: 'excluded', exclusions: expect.arrayContaining([expect.objectContaining({ code, detailCode })]) })
    }
  })
})
