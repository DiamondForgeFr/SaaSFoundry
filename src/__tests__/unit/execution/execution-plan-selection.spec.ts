import {
  classifyTaskIntent,
  createExecutionCandidateId,
  selectMinimumCostExecutionPlan,
  type ExecutionCandidate,
  type ExecutionCandidateCatalogueSnapshot,
  type ExecutionPlanProposal,
  type ExecutionPlanSelectionPolicy,
  type NormalizedEffort
} from '../../../execution'

const OBSERVED_AT = '2026-09-12T10:00:00.000Z'
const PLANNING_AT = '2026-09-12T12:00:00.000Z'
const VALID_UNTIL = '2026-09-13T12:00:00.000Z'

function candidate(model: string, effort: NormalizedEffort, price: string, runtime: 'cloud' | 'local' = 'cloud'): ExecutionCandidate {
  return {
    id: createExecutionCandidateId('provider', runtime, model, effort),
    provider: { id: 'provider' },
    runtime: { id: runtime, kind: runtime },
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
    privacy: { boundary: runtime === 'local' ? 'local-device' : 'provider-managed', trainingUse: 'none', retentionDays: 0 },
    tools: { mode: 'none', supported: [], parallelCalls: false, requiresApproval: false },
    source: { adapterId: 'fixture', candidateRef: `models/${model}`, retrievedAt: OBSERVED_AT }
  }
}

function proposal(id: string, entry: ExecutionCandidate, latencyP95Ms = 1_000): ExecutionPlanProposal {
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
          latencyP95Ms,
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

function catalogue(entries: ExecutionCandidate[]): ExecutionCandidateCatalogueSnapshot {
  return { version: 1, generatedAt: OBSERVED_AT, eligible: entries, excluded: [] }
}

const requirements = classifyTaskIntent({ text: 'Document a public value', categories: ['mechanical'], signals: { operation: 'document' } })
const policy: ExecutionPlanSelectionPolicy = {
  schemaVersion: 1,
  planningAt: PLANNING_AT,
  settlementCurrency: 'USD',
  displayScale: 4,
  tieBreakers: ['lower-p95-latency', 'prefer-local', 'higher-effort', 'fewer-nodes']
}

describe('deterministic minimum-cost plan selection (#725)', () => {
  it('selects a higher-effort candidate when its complete qualified plan is cheaper', () => {
    const low = candidate('low-model', 'low', '2')
    const high = candidate('high-model', 'high', '1')

    const decision = selectMinimumCostExecutionPlan([proposal('plan/low', low), proposal('plan/high', high)], requirements, catalogue([low, high]), policy)

    expect(decision.status).toBe('selected')
    expect(decision.selected).toMatchObject({ proposalId: 'plan/high', rootEffort: 'high', expectedAggregateP95: { amount: '1.0000' } })
    expect(decision.tieBreakDecisions).toEqual([{ winnerProposalId: 'plan/high', loserProposalId: 'plan/low', rule: 'expected-aggregate-p95' }])
  })

  it('applies declared tie-breakers then canonical plan ID independent of input order', () => {
    const slow = candidate('slow', 'medium', '1')
    const fastCloud = candidate('fast-cloud', 'medium', '1')
    const fastLocal = candidate('fast-local', 'medium', '1', 'local')
    const plans = [proposal('plan/z-slow', slow, 2_000), proposal('plan/y-cloud', fastCloud, 1_000), proposal('plan/x-local', fastLocal, 1_000), proposal('plan/a-local', fastLocal, 1_000)]
    const entries = [slow, fastCloud, fastLocal]

    const first = selectMinimumCostExecutionPlan(plans, requirements, catalogue(entries), policy)
    const second = selectMinimumCostExecutionPlan([...plans].reverse(), requirements, catalogue([...entries].reverse()), policy)

    expect(first.selected?.proposalId).toBe('plan/a-local')
    expect(first).toEqual(second)
    expect(first.tieBreakDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ loserProposalId: 'plan/z-slow', rule: 'lower-p95-latency' }),
        expect.objectContaining({ loserProposalId: 'plan/y-cloud', rule: 'prefer-local' }),
        expect.objectContaining({ loserProposalId: 'plan/x-local', rule: 'canonical-proposal-id' })
      ])
    )
  })

  it('ranks only qualified plans and produces a deeply immutable safe decision ledger', () => {
    const valid = candidate('valid', 'medium', '1')
    const invalid = candidate('invalid', 'medium', '0.01')
    invalid.capabilities = ['text']
    const invalidPlan = proposal('plan/invalid', invalid)
    Object.assign(invalidPlan as unknown as Record<string, unknown>, { prompt: 'credential-shaped raw prompt must not survive' })

    const decision = selectMinimumCostExecutionPlan([invalidPlan, proposal('plan/valid', valid)], requirements, catalogue([invalid, valid]), policy)
    const serialized = JSON.stringify(decision)

    expect(decision.selected?.proposalId).toBe('plan/valid')
    expect(decision.exclusions).toEqual([expect.objectContaining({ proposalId: 'plan/invalid', code: 'invalid-proposal', detailCode: 'contract-validation' })])
    expect(decision).toMatchObject({ requirementsId: requirements.id, catalogueFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/), policyFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) })
    expect(Object.isFrozen(decision)).toBe(true)
    expect(Object.isFrozen(decision.qualified)).toBe(true)
    expect(Object.isFrozen(decision.selected?.nodeCosts)).toBe(true)
    expect(serialized).not.toContain('raw prompt')
    expect(serialized).not.toContain('credential-shaped')
  })

  it('returns a stable unplannable decision when no proposal qualifies', () => {
    const invalid = candidate('invalid', 'minimal', '0')
    const plan = proposal('plan/invalid', invalid)

    const decision = selectMinimumCostExecutionPlan([plan], requirements, catalogue([invalid]), policy)

    expect(decision.status).toBe('unplannable')
    expect(decision.selected).toBeUndefined()
    expect(decision.exclusions.map((entry) => entry.code)).toContain('effort-mismatch')
  })

  it('rejects duplicate proposal IDs and never reflects an unsafe ID', () => {
    const entry = candidate('valid', 'medium', '1')
    const first = proposal('plan/duplicate', entry)
    const second = proposal('plan/duplicate', entry)
    second.nodes[0].estimate.latencyP95Ms = 2_000
    const unsafe = proposal('sk-secret-secret-secret-secret', entry)

    const decision = selectMinimumCostExecutionPlan([first, second, unsafe], requirements, catalogue([entry]), policy)

    expect(decision.status).toBe('unplannable')
    expect(decision.exclusions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ proposalId: 'plan/duplicate', detailCode: 'duplicate-proposal-id' }),
        expect.objectContaining({ proposalId: 'unknown-proposal', detailCode: 'contract-validation' })
      ])
    )
    expect(JSON.stringify(decision)).not.toContain('secret-secret-secret')
  })
})
