import { readFileSync } from 'fs'
import { join } from 'path'

import { applyExecutionRequirementOverrides, classifyTaskIntent, type ExecutionRequirementSet, type TaskIntent } from '../../../execution'

describe('task intent classification (#721)', () => {
  it('derives materially different floors for mechanical, architecture, and security work', () => {
    const mechanical = classifyTaskIntent({ text: 'Rename a documented command', signals: { operation: 'rename' } })
    const architecture = classifyTaskIntent({ text: 'Design the architecture for a schema migration', signals: { operation: 'architecture' } })
    const security = classifyTaskIntent({ text: 'Review authentication and secret handling', signals: { operation: 'security-review', handlesSecrets: true } })

    expect(mechanical).toMatchObject({
      classifier: { assessedRisk: 'low' },
      effective: {
        capabilities: { minimumEffort: 'low' },
        validation: { minimum: 'automated-checks' },
        latency: { priority: 'interactive' },
        context: { mode: 'partitionable' }
      }
    })
    expect(architecture).toMatchObject({
      classifier: { assessedRisk: 'high' },
      effective: {
        capabilities: { minimumEffort: 'high' },
        validation: { minimum: 'independent-review' },
        latency: { priority: 'throughput' },
        context: { minimumWindowTokens: 128_000, mode: 'single-candidate' }
      }
    })
    expect(security).toMatchObject({
      classifier: { assessedRisk: 'critical' },
      effective: {
        capabilities: { minimumEffort: 'xhigh' },
        validation: { minimum: 'independent-review-and-tests' },
        privacy: { allowedBoundaries: ['customer-controlled', 'local-device'], allowedTrainingUse: ['none'], maxRetentionDays: 0 },
        tools: { requireApproval: true }
      }
    })
  })

  it('uses a conservative implementation profile when no explicit signal matches', () => {
    const result = classifyTaskIntent({ text: 'Handle the requested work' })

    expect(result.classifier).toMatchObject({ categories: ['implementation'], assessedRisk: 'medium', evidence: ['intent.default-conservative'] })
    expect(result.effective.capabilities.minimumEffort).toBe('medium')
    expect(result.effective.validation.minimum).toBe('automated-checks')
  })

  it('normalizes structured signals deterministically and produces an immutable reusable artifact', () => {
    const first: TaskIntent = {
      text: '  Implement the reporting feature  ',
      categories: ['implementation', 'architecture'],
      signals: {
        estimatedInputTokens: 96_000,
        estimatedOutputTokens: 12_000,
        requiredCapabilities: ['tool-use', 'long-context'],
        requiredTools: ['shell', 'file-read']
      }
    }
    const reordered: TaskIntent = {
      text: 'implement the reporting feature',
      categories: ['architecture', 'implementation'],
      signals: {
        estimatedInputTokens: 96_000,
        estimatedOutputTokens: 12_000,
        requiredCapabilities: ['long-context', 'tool-use'],
        requiredTools: ['file-read', 'shell']
      }
    }

    const result = classifyTaskIntent(first)
    const equivalent = classifyTaskIntent(reordered)
    const roundTrip = JSON.parse(JSON.stringify(result)) as ExecutionRequirementSet

    expect(result).toEqual(equivalent)
    expect(result.id).toBe(equivalent.id)
    expect(result.effective.context).toMatchObject({ minimumWindowTokens: 128_000, minimumOutputTokens: 12_000 })
    expect(result.effective.tools.required).toEqual(expect.arrayContaining(['file-read', 'shell']))
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.effective)).toBe(true)
    expect(applyExecutionRequirementOverrides(roundTrip, [])).toEqual(result)
  })

  it('does not retain raw task text, credentials, providers, runtimes, or models', () => {
    const secret = 'sk-examplecredential123456789'
    const result = classifyTaskIntent({ text: `Use ${secret} to compare OpenAI GPT, Claude, Gemini, and a local Ollama model` })
    const serialized = JSON.stringify(result)

    expect(serialized).not.toContain(secret)
    for (const term of ['OpenAI', 'GPT', 'Claude', 'Gemini', 'Ollama']) expect(serialized.toLowerCase()).not.toContain(term.toLowerCase())
    expect(result.taskFingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(result).not.toHaveProperty('provider')
    expect(result).not.toHaveProperty('model')
  })

  it('rejects malformed or provider-specific inputs at the runtime boundary', () => {
    const invalidCategory = { text: 'Do work', categories: ['billing'] } as unknown as TaskIntent
    const providerSpecific = { text: 'Do work', provider: 'openai' } as unknown as TaskIntent
    const unsafeTool = { text: 'Do work', signals: { requiredTools: ['ghp_examplecredential123456'] } } as TaskIntent
    const duplicateCapabilities = { text: 'Do work', signals: { requiredCapabilities: ['code', 'code'] } } as TaskIntent

    expect(() => classifyTaskIntent(invalidCategory)).toThrow('unsupported value')
    expect(() => classifyTaskIntent(providerSpecific)).toThrow('unsupported fields')
    expect(() => classifyTaskIntent(unsafeTool)).toThrow('safe public identifiers')
    expect(() => classifyTaskIntent(duplicateCapabilities)).toThrow('duplicates')
    expect(() => classifyTaskIntent({ text: 'Do work' }, { policyRevision: 'sk-secret' })).toThrow('safe public identifier')
    expect(() => classifyTaskIntent({ text: 'Do work' }, { policyRevision: 123 as unknown as string })).toThrow('safe public identifier')
  })

  it('keeps classification independent from candidate catalogues and ranking', () => {
    const source = readFileSync(join(__dirname, '../../../execution/classifier.ts'), 'utf8')

    expect(source).not.toMatch(/from ['"].*(?:catalogue|ranking|adapter|harness)/)
    expect(source).not.toMatch(/switch\s*\([^)]*(?:provider|model|runtime)/i)
  })
})
