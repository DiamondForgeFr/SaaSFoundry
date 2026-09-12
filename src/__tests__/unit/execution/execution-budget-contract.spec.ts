import { assertSessionBudgetEnvelope, deriveSessionBudgetEnvelope, ExecutionBudgetContractError, type SessionWorkloadEvidence } from '../../../execution/budget'
import { createExecutionCandidateId, type ExecutionCandidate, type ExecutionCandidateCatalogueSnapshot, type ExecutionPlanSelectionPolicy } from '../../../execution'

const OBSERVED_AT = '2026-09-12T10:00:00.000Z'
const PLANNING_AT = '2026-09-12T12:00:00.000Z'
const VALID_UNTIL = '2026-09-13T12:00:00.000Z'

function candidate(currency = 'USD', price = '1'): ExecutionCandidate {
  return {
    id: createExecutionCandidateId('provider', 'hosted', 'model', 'medium'),
    provider: { id: 'provider' },
    runtime: { id: 'hosted', kind: 'cloud' },
    model: { id: 'model' },
    effort: { normalized: 'medium', sourceId: 'medium' },
    context: { windowTokens: 64_000, maxOutputTokens: 8_000 },
    capabilities: ['code', 'text'],
    availability: { state: 'available', checkedAt: OBSERVED_AT, validUntil: VALID_UNTIL },
    pricing: { observedAt: OBSERVED_AT, validUntil: VALID_UNTIL, dimensions: [{ kind: 'request', amount: price, currency, unit: 'request', per: 1, sourceUnit: 'request' }] },
    privacy: { boundary: 'provider-managed', trainingUse: 'none', retentionDays: 0 },
    tools: { mode: 'none', supported: [], parallelCalls: false, requiresApproval: false },
    source: { adapterId: 'fixture', candidateRef: 'models/model', retrievedAt: OBSERVED_AT }
  }
}

function snapshot(entry: ExecutionCandidate): ExecutionCandidateCatalogueSnapshot {
  return { version: 1, generatedAt: OBSERVED_AT, eligible: [entry], excluded: [] }
}

const policy: ExecutionPlanSelectionPolicy = {
  schemaVersion: 1,
  planningAt: PLANNING_AT,
  settlementCurrency: 'USD',
  displayScale: 2,
  tieBreakers: ['fewer-nodes']
}

function session(entry: ExecutionCandidate): SessionWorkloadEvidence {
  return {
    schemaVersion: 1,
    sessionId: 'session/current',
    candidateId: entry.id,
    usageP95: { request: '1' },
    observedAt: OBSERVED_AT,
    validUntil: VALID_UNTIL,
    evidenceRef: 'session/workload',
    authorityRevision: 'session/revision-1'
  }
}

describe('execution budget contract safety (#728)', () => {
  it('rejects opaque or secret-bearing session fields without reflecting their values', () => {
    const entry = candidate()
    const value = { ...session(entry), prompt: 'Bearer secret-value' }

    expect(() => deriveSessionBudgetEnvelope(value, snapshot(entry), policy)).toThrow(ExecutionBudgetContractError)
    expect(() => deriveSessionBudgetEnvelope(value, snapshot(entry), policy)).not.toThrow(/secret-value/)
  })

  it('fails closed on missing prices, mixed currencies, and stale workload evidence', () => {
    const missing = candidate()
    missing.pricing.dimensions = []
    expect(() => deriveSessionBudgetEnvelope(session(missing), snapshot(missing), policy)).toThrow(/price-incomplete/)

    const mixed = candidate('EUR')
    expect(() => deriveSessionBudgetEnvelope(session(mixed), snapshot(mixed), policy)).toThrow(/currency-uncomparable/)

    const stale = candidate()
    const staleSession = session(stale)
    staleSession.validUntil = PLANNING_AT
    expect(() => deriveSessionBudgetEnvelope(staleSession, snapshot(stale), policy)).toThrow(/current at planning time/)
  })

  it('accepts an explicit complete zero-price schedule and rejects tampered envelope evidence', () => {
    const free = candidate('USD', '0')
    const catalogue = snapshot(free)
    const envelope = deriveSessionBudgetEnvelope(session(free), catalogue, policy)
    expect(envelope.baselineP95).toMatchObject({ numerator: '0', denominator: '1', amount: '0.00' })

    const tampered = JSON.parse(JSON.stringify(envelope)) as Record<string, unknown>
    ;(tampered.baselineP95 as Record<string, unknown>).amount = '1.00'

    expect(() => assertSessionBudgetEnvelope(tampered)).toThrow(/amount|canonical payload/)
  })
})
