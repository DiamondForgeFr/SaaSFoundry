import { classifyTaskIntent, type ExecutionRequirementOverride } from '../../../execution'

function constraint(id: string, source: 'workflow' | 'user', changes: ExecutionRequirementOverride['changes']): ExecutionRequirementOverride {
  return { id, source, reference: `${source}-rule-${id}`, appliesTo: 'future-replans', changes }
}

describe('execution requirement constraint resolution (#720)', () => {
  it('merges typed constraints with deterministic field-specific semantics', () => {
    const workflow = constraint('workflow-floor', 'workflow', {
      minimumEffort: 'high',
      validationMinimum: 'independent-review',
      minimumWindowTokens: 64_000,
      allowedPrivacyBoundaries: ['customer-controlled', 'local-device'],
      allowedTrainingUse: ['none'],
      maxRetentionDays: 7,
      requiredTools: ['shell'],
      requireApproval: true
    })
    const user = constraint('user-needs', 'user', {
      requiredCapabilities: ['long-context'],
      requiredChecks: ['integration-tests'],
      maximumPlanP95Ms: 5_000,
      minimumOutputTokens: 6_000,
      contextMode: 'single-candidate',
      forbiddenTools: ['network-publish']
    })

    const first = classifyTaskIntent({ text: 'Rename a documented command', signals: { operation: 'rename' } }, { workflowConstraints: [workflow], userConstraints: [user] })
    const second = classifyTaskIntent({ text: 'Rename a documented command', signals: { operation: 'rename' } }, { userConstraints: [user], workflowConstraints: [workflow] })

    expect(first).toEqual(second)
    expect(first.effective).toMatchObject({
      capabilities: { minimumEffort: 'high' },
      validation: { minimum: 'independent-review' },
      latency: { maximumPlanP95Ms: 5_000 },
      context: { minimumWindowTokens: 64_000, minimumOutputTokens: 6_000, mode: 'single-candidate' },
      privacy: { allowedBoundaries: ['customer-controlled', 'local-device'], allowedTrainingUse: ['none'], maxRetentionDays: 7 },
      tools: { requireApproval: true }
    })
    expect(first.effective.capabilities.required).toContain('long-context')
    expect(first.effective.validation.requiredChecks).toContain('integration-tests')
    expect(first.effective.tools.required).toContain('shell')
    expect(first.effective.tools.forbidden).toContain('network-publish')
    expect(first.resolution.status).toBe('resolved')
    const sources = first.resolution.decisions.map((entry) => entry.source)
    expect(sources).toEqual([...sources].sort((left, right) => Number(left === 'user') - Number(right === 'user')))
  })

  it('retains mandatory security floors and records every weakening attempt', () => {
    const result = classifyTaskIntent(
      { text: 'Audit authentication secrets', categories: ['security'], signals: { handlesSecrets: true } },
      {
        userConstraints: [
          constraint('unsafe-relaxation', 'user', {
            minimumEffort: 'low',
            validationMinimum: 'self-check',
            minimumWindowTokens: 8_000,
            allowedPrivacyBoundaries: ['customer-controlled', 'local-device', 'provider-managed', 'unknown'],
            allowedTrainingUse: ['none', 'opt-in', 'opt-out', 'unknown'],
            maxRetentionDays: 30,
            requireApproval: false
          })
        ]
      }
    )

    expect(result.classifier.assessedRisk).toBe('critical')
    expect(result.effective.capabilities.minimumEffort).toBe('xhigh')
    expect(result.effective.validation.minimum).toBe('independent-review-and-tests')
    expect(result.effective.context.minimumWindowTokens).toBe(128_000)
    expect(result.effective.privacy).toMatchObject({ allowedBoundaries: ['customer-controlled', 'local-device'], allowedTrainingUse: ['none'], maxRetentionDays: 0 })
    expect(result.effective.tools.requireApproval).toBe(true)
    expect(result.resolution.decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'minimumEffort', status: 'rejected', reason: 'would-weaken-required-floor' }),
        expect.objectContaining({ field: 'validationMinimum', status: 'rejected', reason: 'would-weaken-required-floor' }),
        expect.objectContaining({ field: 'allowedPrivacyBoundaries', status: 'rejected', reason: 'would-widen-privacy-boundary' }),
        expect.objectContaining({ field: 'requireApproval', status: 'rejected', reason: 'would-disable-required-approval' })
      ])
    )
  })

  it('marks privacy and tool intersections as unsatisfiable instead of silently choosing', () => {
    const result = classifyTaskIntent(
      { text: 'Change a module', categories: ['implementation'] },
      {
        workflowConstraints: [constraint('requires-shell', 'workflow', { requiredTools: ['shell'], allowedPrivacyBoundaries: ['local-device'] })],
        userConstraints: [constraint('forbids-shell', 'user', { forbiddenTools: ['shell'], allowedPrivacyBoundaries: ['provider-managed'] })]
      }
    )

    expect(result.resolution.status).toBe('unsatisfiable')
    expect(result.effective.privacy.allowedBoundaries).toEqual([])
    expect(result.effective.tools.required).toContain('shell')
    expect(result.effective.tools.forbidden).toContain('shell')
    expect(result.resolution.decisions).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'rejected', reason: 'constraint-conflict' })]))
  })

  it('rejects source confusion, duplicate IDs, and undeclared patch fields', () => {
    const workflow = constraint('same-id', 'workflow', { minimumEffort: 'high' })
    expect(() => classifyTaskIntent({ text: 'Implement a task' }, { userConstraints: [workflow] })).toThrow('userConstraints')
    expect(() => classifyTaskIntent({ text: 'Implement a task' }, { workflowConstraints: [workflow, workflow] })).toThrow('Duplicate')
    const invalid = constraint('invalid-field', 'workflow', { minimumEffort: 'high' })
    ;(invalid.changes as unknown as Record<string, unknown>).provider = 'openai'
    expect(() => classifyTaskIntent({ text: 'Implement a task' }, { workflowConstraints: [invalid] })).toThrow('unsupported fields')
  })
})
