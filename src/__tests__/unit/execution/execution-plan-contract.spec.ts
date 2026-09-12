import { assertExecutionPlanProposal, ExecutionPlanContractError, type ExecutionPlanProposal } from '../../../execution'

const NOW = '2026-09-12T12:00:00.000Z'
const LATER = '2026-09-13T12:00:00.000Z'

function proposal(): ExecutionPlanProposal {
  return {
    schemaVersion: 1,
    id: 'plan/codex-primary',
    rootNodeId: 'primary',
    nodes: [
      {
        id: 'primary',
        role: 'primary',
        candidateId: 'openai/hosted/gpt-6-astra/high',
        estimate: {
          usageP95: { 'input-token': '1250', 'output-token': '500', second: '1.25' },
          latencyP95Ms: 4_000,
          observedAt: NOW,
          validUntil: LATER,
          evidenceRef: 'benchmarks/plan-679/primary',
          independenceDomain: 'openai/hosted'
        },
        tools: ['shell'],
        checks: ['automated-tests'],
        outcomes: [{ code: 'success', conditionalProbability: '1', evidenceRef: 'benchmarks/plan-679/success' }]
      }
    ]
  }
}

describe('execution plan public contract (#723)', () => {
  it('accepts a provider-neutral serializable execution tree', () => {
    const value: unknown = proposal()

    expect(() => assertExecutionPlanProposal(value)).not.toThrow()
    expect(JSON.parse(JSON.stringify(value))).toEqual(value)
  })

  it('rejects missing roots, duplicate nodes, opaque fields, and invalid quantities', () => {
    const value = proposal() as unknown as Record<string, unknown>
    value.rootNodeId = 'missing'
    value.providerPayload = { opaque: true }
    const nodes = value.nodes as Array<Record<string, unknown>>
    nodes.push({ ...nodes[0] })
    const estimate = nodes[0].estimate as Record<string, unknown>
    estimate.usageP95 = { 'input-token': -1 }

    expect(() => assertExecutionPlanProposal(value)).toThrow(ExecutionPlanContractError)
    expect(() => assertExecutionPlanProposal(value)).toThrow(/unsupported fields|unique|declared node|decimal string/)
  })

  it.each([
    ['plan ID', (value: ExecutionPlanProposal) => (value.id = 'sk-secret-secret-secret-secret')],
    ['candidate ID', (value: ExecutionPlanProposal) => (value.nodes[0].candidateId = 'Bearer secret-secret-secret')],
    ['evidence reference', (value: ExecutionPlanProposal) => (value.nodes[0].estimate.evidenceRef = 'github_pat_secret-secret-secret')]
  ])('rejects a secret-bearing %s', (_label, mutate) => {
    const value = proposal()
    mutate(value)

    expect(() => assertExecutionPlanProposal(value)).toThrow(/safe public identifier/)
    expect(() => assertExecutionPlanProposal(value)).not.toThrow(/secret-secret-secret/)
  })
})
