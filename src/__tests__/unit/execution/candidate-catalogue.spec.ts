import { readFileSync } from 'fs'
import { resolve } from 'path'

import { createExecutionCandidateId, ExecutionCandidateCatalogue, type ExecutionCandidate, type ExecutionCandidateAdapter, type NormalizedEffort } from '../../../execution'

const NOW = new Date('2026-09-11T10:00:00.000Z')

interface CandidateOptions {
  adapterId: string
  providerId?: string
  runtimeId?: string
  runtimeKind?: 'cloud' | 'local' | 'hybrid'
  modelId?: string
  effort?: NormalizedEffort
  sourceEffort?: string
  sourceUnit?: string
  amount?: string
  availability?: 'available' | 'unavailable'
  availabilityReason?: { code: string; detail?: string }
  availabilityUntil?: string
  pricingUntil?: string
  original?: ExecutionCandidate['source']['original']
}

function candidate(options: CandidateOptions): ExecutionCandidate {
  const providerId = options.providerId ?? options.adapterId
  const runtimeId = options.runtimeId ?? 'hosted'
  const modelId = options.modelId ?? 'model-1'
  const effort = options.effort ?? 'medium'
  const sourceEffort = options.sourceEffort ?? effort
  const candidateRef = `${modelId}-${sourceEffort}`
  return {
    id: `${providerId}/${runtimeId}/${modelId}/${effort}`,
    provider: { id: providerId, displayName: providerId.toUpperCase() },
    runtime: { id: runtimeId, kind: options.runtimeKind ?? 'cloud' },
    model: { id: modelId },
    effort: { normalized: effort, sourceId: sourceEffort, sourceLabel: sourceEffort },
    context: { windowTokens: 128_000, maxOutputTokens: 16_000 },
    capabilities: ['text', 'tool-use'],
    availability: {
      state: options.availability ?? 'available',
      checkedAt: '2026-09-11T09:00:00.000Z',
      validUntil: options.availabilityUntil ?? '2026-09-11T11:00:00.000Z',
      ...(options.availabilityReason ? { reason: options.availabilityReason } : {})
    },
    pricing: {
      observedAt: '2026-09-11T09:00:00.000Z',
      validUntil: options.pricingUntil ?? '2026-09-12T09:00:00.000Z',
      dimensions: [
        {
          kind: 'input-token',
          amount: options.amount ?? '1.25',
          currency: 'USD',
          unit: 'token',
          per: 1_000_000,
          sourceUnit: options.sourceUnit ?? 'USD / 1M input tokens'
        }
      ]
    },
    privacy: { boundary: options.runtimeKind === 'local' ? 'local-device' : 'provider-managed', trainingUse: 'unknown' },
    tools: { mode: 'native', supported: ['shell', 'file-edit'], parallelCalls: true, requiresApproval: true },
    source: {
      adapterId: options.adapterId,
      candidateRef,
      retrievedAt: '2026-09-11T09:00:00.000Z',
      original: options.original ?? { effort: sourceEffort, price_unit: options.sourceUnit ?? 'USD / 1M input tokens' }
    }
  }
}

function adapter(id: string, candidates: ExecutionCandidate[]): ExecutionCandidateAdapter {
  return {
    id,
    discover: () => candidates.map((value) => ({ sourceId: value.source.candidateRef, value })),
    normalize: (observation) => observation.value as ExecutionCandidate
  }
}

describe('provider-neutral execution candidate catalogue (#677)', () => {
  it('normalizes representative provider and local-runtime candidates without provider branches', async () => {
    const fixtures = [
      candidate({ adapterId: 'anthropic', modelId: 'claude-opus', effort: 'high', sourceEffort: 'extended', sourceUnit: '$ / MTok' }),
      candidate({ adapterId: 'deepseek', modelId: 'deepseek-v3', effort: 'medium', sourceEffort: 'default', sourceUnit: 'CNY / 1M tokens' }),
      candidate({ adapterId: 'google', modelId: 'gemini-pro', effort: 'high', sourceEffort: 'high', sourceUnit: '$ / 1M chars' }),
      candidate({ adapterId: 'moonshot', modelId: 'kimi-k2', effort: 'medium', sourceEffort: 'thinking', sourceUnit: '$ / 1M tokens' }),
      candidate({ adapterId: 'ollama', providerId: 'alibaba', runtimeId: 'developer-mac', runtimeKind: 'local', modelId: 'qwen3', effort: 'custom', sourceEffort: 'local-default', amount: '0' }),
      candidate({ adapterId: 'openai', modelId: 'gpt-6-astra', effort: 'xhigh', sourceEffort: 'xhigh', sourceUnit: '$ / 1M input tokens' })
    ]
    const catalogue = new ExecutionCandidateCatalogue({ clock: () => NOW })
    for (const fixture of fixtures) catalogue.register(adapter(fixture.source.adapterId, [fixture]))

    const snapshot = await catalogue.snapshot()

    expect(snapshot).toMatchObject({ version: 1, generatedAt: NOW.toISOString(), excluded: [] })
    expect(snapshot.eligible.map((entry) => entry.id)).toEqual([...fixtures.map((entry) => entry.id)].sort())
    expect(snapshot.eligible.map((entry) => entry.effort.normalized)).toEqual(expect.arrayContaining(['medium', 'high', 'custom', 'xhigh']))
    expect(snapshot.eligible.find((entry) => entry.provider.id === 'openai')?.source.original).toEqual({ effort: 'xhigh', price_unit: '$ / 1M input tokens' })
    expect(snapshot.eligible.find((entry) => entry.runtime.kind === 'local')?.privacy.boundary).toBe('local-device')
  })

  it('excludes unavailable and stale candidates with machine-readable reasons', async () => {
    const unavailable = candidate({
      adapterId: 'openai',
      modelId: 'temporarily-offline',
      availability: 'unavailable',
      availabilityReason: { code: 'capacity-exhausted', detail: 'No capacity in the selected runtime.' }
    })
    const staleAvailability = candidate({ adapterId: 'anthropic', modelId: 'stale-availability', availabilityUntil: '2026-09-11T09:59:59.000Z' })
    const stalePrice = candidate({ adapterId: 'google', modelId: 'stale-price', pricingUntil: '2026-09-11T09:59:59.000Z' })
    const catalogue = new ExecutionCandidateCatalogue({ clock: () => NOW })
      .register(adapter('openai', [unavailable]))
      .register(adapter('anthropic', [staleAvailability]))
      .register(adapter('google', [stalePrice]))

    const snapshot = await catalogue.snapshot()

    expect(snapshot.eligible).toEqual([])
    expect(snapshot.excluded.map((entry) => entry.exclusion.code).sort()).toEqual(['candidate-unavailable', 'catalogue-stale', 'catalogue-stale'])
    expect(snapshot.excluded.find((entry) => entry.exclusion.code === 'candidate-unavailable')?.exclusion).toMatchObject({
      detailCode: 'capacity-exhausted'
    })
    expect(JSON.stringify(snapshot)).not.toContain('No capacity in the selected runtime.')
  })

  it('fails closed for malformed, secret-bearing, duplicate, and failed-adapter records', async () => {
    const duplicateA = candidate({ adapterId: 'host-a', providerId: 'openai', modelId: 'duplicate' })
    const duplicateB = { ...candidate({ adapterId: 'host-b', providerId: 'openai', modelId: 'duplicate' }), id: duplicateA.id }
    const secret = candidate({ adapterId: 'unsafe', modelId: 'secret', original: { public_model: 'secret', note: 'Bearer must-never-enter-the-catalogue-123456789' } })
    const invalidPrice = candidate({ adapterId: 'broken-price', modelId: 'bad-price', amount: '-1.5' })
    const catalogue = new ExecutionCandidateCatalogue({ clock: () => NOW })
      .register(adapter('host-a', [duplicateA]))
      .register(adapter('host-b', [duplicateB]))
      .register(adapter('unsafe', [secret]))
      .register(adapter('broken-price', [invalidPrice]))
      .register({ id: 'offline-adapter', discover: () => Promise.reject(new Error('credential detail must stay private')), normalize: () => duplicateA })

    const snapshot = await catalogue.snapshot()

    expect(snapshot.eligible).toEqual([])
    expect(snapshot.excluded.map((entry) => entry.exclusion.code).sort()).toEqual(['adapter-unavailable', 'duplicate-candidate', 'duplicate-candidate', 'invalid-candidate', 'invalid-candidate'])
    expect(JSON.stringify(snapshot)).not.toContain('must-never-enter-the-catalogue')
    expect(JSON.stringify(snapshot)).not.toContain('credential detail must stay private')
  })

  it('requires canonical identities and strict UTC timestamps', async () => {
    const wrongId = { ...candidate({ adapterId: 'openai', modelId: 'wrong-id' }), id: 'openai/custom-id' }
    const looseDate = candidate({ adapterId: 'anthropic', modelId: 'loose-date' })
    looseDate.availability.checkedAt = '2026-09-11 09:00:00Z'
    const catalogue = new ExecutionCandidateCatalogue({ clock: () => NOW }).register(adapter('openai', [wrongId])).register(adapter('anthropic', [looseDate]))

    const snapshot = await catalogue.snapshot()

    expect(createExecutionCandidateId('openai', 'hosted', 'gpt-6-astra', 'xhigh')).toBe('openai/hosted/gpt-6-astra/xhigh')
    expect(snapshot.eligible).toEqual([])
    expect(snapshot.excluded.map((entry) => entry.exclusion)).toEqual([
      expect.objectContaining({ code: 'invalid-candidate', detailCode: 'contract-validation' }),
      expect.objectContaining({ code: 'invalid-candidate', detailCode: 'contract-validation' })
    ])
  })

  it('keeps catalogue output deterministic and detached from adapter-owned objects', async () => {
    const first = candidate({ adapterId: 'z-provider', modelId: 'z-model', original: { effort: 'provider-z' } })
    const second = candidate({ adapterId: 'a-provider', modelId: 'a-model', original: { effort: 'provider-a' } })
    const catalogue = new ExecutionCandidateCatalogue({ clock: () => NOW }).register(adapter('z-provider', [first])).register(adapter('a-provider', [second]))

    const snapshot = await catalogue.snapshot()
    ;(first.source.original as { effort: string }).effort = 'mutated-after-snapshot'
    first.capabilities.length = 0

    expect(snapshot.eligible.map((entry) => entry.id)).toEqual([...snapshot.eligible.map((entry) => entry.id)].sort())
    expect(snapshot.eligible.find((entry) => entry.source.adapterId === 'z-provider')?.source.original).toEqual({ effort: 'provider-z' })
    expect(snapshot.eligible.find((entry) => entry.source.adapterId === 'z-provider')?.capabilities).toEqual(['text', 'tool-use'])
  })

  it('rejects unsafe and duplicate adapter registrations before discovery', () => {
    const catalogue = new ExecutionCandidateCatalogue()
    expect(() => catalogue.register(adapter('../provider', []))).toThrow('safe non-empty identifier')
    catalogue.register(adapter('provider', []))
    expect(() => catalogue.register(adapter('provider', []))).toThrow('already registered')
  })

  it('remains independent from coding-agent profiles and portable workflow skills', () => {
    const catalogueSource = readFileSync(resolve(__dirname, '../../../execution/catalogue.ts'), 'utf8')
    expect(catalogueSource).not.toContain("from '../harness")
    expect(catalogueSource).not.toContain('agent-profiles.json')
    expect(catalogueSource).not.toMatch(/if\s*\([^)]*(?:openai|anthropic|gemini|kimi|deepseek)/i)
  })
})
