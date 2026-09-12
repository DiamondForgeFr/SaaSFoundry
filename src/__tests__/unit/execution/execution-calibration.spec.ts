import {
  applyExecutionCalibrationToPlanEstimate,
  assertExecutionCalibrationSnapshot,
  deriveExecutionCalibrationSnapshot,
  recordExecutionOutcome,
  stableFingerprint,
  type ExecutionCalibrationCohort,
  type ExecutionCalibrationHostAuthority,
  type ExecutionCalibrationPolicy,
  type ExecutionDispatchBinding,
  type ExecutionOutcomeEvidence,
  type ExecutionOutcomeEvidenceInput,
  type ExecutionOutcomeHostAuthority,
  type ExecutionPlanProposal
} from '../../../execution'

const OCCURRED_AT = '2026-09-12T10:00:00.000Z'
const RECEIVED_AT = '2026-09-12T10:00:01.000Z'
const GENERATED_AT = '2026-09-12T12:00:00.000Z'
const VALID_UNTIL = '2026-09-13T12:00:00.000Z'

const cohort: ExecutionCalibrationCohort = {
  candidateId: 'provider/hosted/model/medium',
  effort: 'medium',
  runtimeKind: 'cloud',
  workloadClass: 'code/mechanical',
  privacyBoundary: 'provider-managed',
  tenantBoundaryId: 'tenant/acme'
}

const binding: ExecutionDispatchBinding = {
  runId: 'run/host-unique',
  lineageId: stableFingerprint('lineage'),
  lineageRevision: 2,
  historyHead: stableFingerprint('history'),
  attemptId: stableFingerprint('attempt'),
  dispatchPermitId: 'permit/2',
  planDecisionId: stableFingerprint('plan'),
  proposalFingerprint: stableFingerprint('proposal'),
  nodeId: 'primary',
  candidateId: cohort.candidateId,
  retryOrdinal: 0,
  cohort
}

function input(eventId: string, usage: string, overrides: Partial<ExecutionOutcomeEvidenceInput> = {}): ExecutionOutcomeEvidenceInput {
  return {
    schemaVersion: 1,
    eventId,
    binding,
    occurredAt: OCCURRED_AT,
    receivedAt: RECEIVED_AT,
    outcome: 'success',
    actualUsage: { request: usage },
    metering: 'complete',
    latencyMs: 1_000,
    validation: { result: 'passed', checks: ['type-check', 'automated-tests'] },
    sourceKind: 'provider-settlement',
    evidenceRefs: [`receipts/${eventId}`],
    ...overrides
  }
}

function outcomeHost(verified = true): ExecutionOutcomeHostAuthority & { records: Map<string, ExecutionOutcomeEvidence> } {
  const records = new Map<string, ExecutionOutcomeEvidence>()
  return {
    records,
    verifyOutcomeEvidence: () => verified,
    appendOutcome: (record) => {
      const existing = records.get(record.eventId)
      if (existing) return existing.id === record.id ? { status: 'replayed', outcomeId: existing.id } : { status: 'rejected' }
      records.set(record.eventId, record)
      return { status: 'accepted', outcomeId: record.id }
    }
  }
}

const policy: ExecutionCalibrationPolicy = {
  schemaVersion: 1,
  estimatorVersion: 'nearest-rank/v1',
  cutoffAt: '2026-09-12T11:00:00.000Z',
  generatedAt: GENERATED_AT,
  validUntil: VALID_UNTIL,
  minimumSamples: 2,
  maximumSamples: 16,
  quantileBps: 9500,
  usageCaps: { request: '10' },
  latencyCapMs: 5_000,
  evidenceRef: 'calibration/model/v1'
}

function calibrationHost(verified = true): ExecutionCalibrationHostAuthority {
  return { verifyRecordedOutcome: () => verified }
}

function proposal(): ExecutionPlanProposal {
  return {
    schemaVersion: 1,
    id: 'plan/future',
    rootNodeId: 'primary',
    nodes: [
      {
        id: 'primary',
        role: 'primary',
        candidateId: cohort.candidateId,
        estimate: { usageP95: { request: '1' }, latencyP95Ms: 500, observedAt: OCCURRED_AT, validUntil: VALID_UNTIL, evidenceRef: 'estimate/original', independenceDomain: 'provider/model' },
        tools: [],
        checks: [],
        outcomes: [{ code: 'success', conditionalProbability: '1', evidenceRef: 'rates/original' }]
      }
    ]
  }
}

describe('authenticated outcomes and forward-only calibration (#736)', () => {
  it('authenticates, normalizes, freezes, and idempotently replays an exact outcome', () => {
    const host = outcomeHost()
    const record = recordExecutionOutcome(input('event/1', '1'), binding, host)
    const replay = recordExecutionOutcome(input('event/1', '1'), binding, host)

    expect(replay.id).toBe(record.id)
    expect(record.actualUsage).toEqual({ request: '1' })
    expect(Object.isFrozen(record.binding.cohort)).toBe(true)
    expect(host.records.size).toBe(1)
  })

  it('rejects unauthenticated, mismatched, conflicting, unsafe, and opaque evidence', () => {
    expect(() => recordExecutionOutcome(input('event/1', '1'), binding, outcomeHost(false))).toThrow(/did not authenticate/)
    expect(() => recordExecutionOutcome(input('event/1', '1'), { ...binding, nodeId: 'fallback' }, outcomeHost())).toThrow(/expected dispatch binding/)
    expect(() => recordExecutionOutcome({ ...input('event/1', '1'), rawOutput: 'secret' }, binding, outcomeHost())).toThrow(/unsupported fields/)
    expect(() => recordExecutionOutcome(input('sk-secret-secret-secret', '1'), binding, outcomeHost())).toThrow(/opaque safe identifier/)

    const host = outcomeHost()
    recordExecutionOutcome(input('event/1', '1'), binding, host)
    expect(() => recordExecutionOutcome(input('event/1', '2'), binding, host)).toThrow(/atomic outcome append/)
  })

  it('derives the same bounded snapshot regardless of input order and censors ambiguous outcomes', () => {
    const host = outcomeHost()
    const records = [
      recordExecutionOutcome(input('event/1', '1', { latencyMs: 1_000 }), binding, host),
      recordExecutionOutcome(input('event/2', '3', { latencyMs: 3_000 }), binding, host),
      recordExecutionOutcome(input('event/3', '99', { latencyMs: 99_000 }), binding, host),
      recordExecutionOutcome(input('event/4', '8', { outcome: 'outcome-unknown', metering: 'unknown', latencyMs: null }), binding, host),
      recordExecutionOutcome(
        input('event/5', '2', { binding: { ...binding, cohort: { ...cohort, tenantBoundaryId: 'tenant/other' } } }),
        { ...binding, cohort: { ...cohort, tenantBoundaryId: 'tenant/other' } },
        host
      )
    ]

    const first = deriveExecutionCalibrationSnapshot(records, cohort, policy, calibrationHost())
    const second = deriveExecutionCalibrationSnapshot([...records].reverse(), cohort, policy, calibrationHost())

    expect(first).toEqual(second)
    expect(first).toMatchObject({ sampleCount: 3, censoredCount: 1, usageP95: { request: '10' }, latencyP95Ms: 5_000 })
    expect(first.outcomeRates).toEqual([{ outcome: 'success', numerator: '1', denominator: '1' }])
    expect(first.sourceOutcomeIds).not.toContain(records[4].id)
    expect(() => assertExecutionCalibrationSnapshot(JSON.parse(JSON.stringify(first)))).not.toThrow()
  })

  it('fails closed for insufficient samples, inconsistent dimensions, duplicate events, and unauthenticated history', () => {
    const host = outcomeHost()
    const one = recordExecutionOutcome(input('event/1', '1'), binding, host)
    const different = recordExecutionOutcome(input('event/2', '2', { actualUsage: { request: '2', second: '1' } }), binding, host)

    expect(() => deriveExecutionCalibrationSnapshot([one], cohort, policy, calibrationHost())).toThrow(/insufficient eligible samples/)
    expect(() => deriveExecutionCalibrationSnapshot([one, different], cohort, { ...policy, usageCaps: { request: '10', second: '10' } }, calibrationHost())).toThrow(
      /dimensions must be complete and identical/
    )
    expect(() => deriveExecutionCalibrationSnapshot([one, one], cohort, policy, calibrationHost())).toThrow(/duplicate event ID/)
    expect(() => deriveExecutionCalibrationSnapshot([one, different], cohort, { ...policy, usageCaps: { request: '10', second: '10' } }, calibrationHost(false))).toThrow(/did not authenticate/)
  })

  it('applies calibrated estimate evidence only to a fresh immutable proposal', () => {
    const host = outcomeHost()
    const records = [recordExecutionOutcome(input('event/1', '4'), binding, host), recordExecutionOutcome(input('event/2', '6'), binding, host)]
    const snapshot = deriveExecutionCalibrationSnapshot(records, cohort, policy, calibrationHost())
    const original = proposal()
    const before = JSON.stringify(original)

    const calibrated = applyExecutionCalibrationToPlanEstimate(original, 'primary', snapshot)

    expect(calibrated.nodes[0].estimate).toMatchObject({ usageP95: { request: '6' }, latencyP95Ms: 1_000, observedAt: GENERATED_AT, evidenceRef: 'calibration/model/v1' })
    expect(JSON.stringify(original)).toBe(before)
    expect(Object.isFrozen(calibrated.nodes[0].estimate)).toBe(true)
    expect(() => applyExecutionCalibrationToPlanEstimate(original, 'missing', snapshot)).toThrow(/does not exist/)
  })

  it('detects tampered snapshots', () => {
    const host = outcomeHost()
    const records = [recordExecutionOutcome(input('event/1', '4'), binding, host), recordExecutionOutcome(input('event/2', '6'), binding, host)]
    const snapshot = deriveExecutionCalibrationSnapshot(records, cohort, policy, calibrationHost())
    const tampered = JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>
    tampered.sampleCount = 99

    expect(() => assertExecutionCalibrationSnapshot(tampered)).toThrow(/canonical payload/)
  })
})
